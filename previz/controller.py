from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import torch
import viser
import viser.transforms as tf

from .models import Shot, ShotPin, ShotPromptSegment, ShotTake
from .shot_store import ShotStore
from .solver_client import SolverClient


@dataclass
class HandleBinding:
    name: str
    joint_name: str
    joint_index: int
    handle: viser.TransformControlsHandle
    mode: str


class PrevizController:
    def __init__(
        self,
        *,
        demo,
        client: viser.ClientHandle,
        session_getter: Callable[[], object | None],
        status_handle: viser.GuiMarkdownHandle,
        add_constraint_callback: Callable[..., None],
        solver_url: str,
        store_dir: str | Path,
    ) -> None:
        self.demo = demo
        self.client = client
        self._session_getter = session_getter
        self.status_handle = status_handle
        self.add_constraint_callback = add_constraint_callback
        self.solver = SolverClient(solver_url)
        self.store = ShotStore(store_dir)
        self.enabled = False
        self.shot: Shot | None = None
        self.bindings: dict[str, HandleBinding] = {}
        self._syncing = False

    @property
    def session(self):
        session = self._session_getter()
        if session is None:
            raise RuntimeError("Previz controller session is unavailable.")
        return session

    def current_motion(self):
        if not self.session.motions:
            return None
        return list(self.session.motions.values())[0]

    def current_prompt_segments(self) -> list[ShotPromptSegment]:
        prompt_values = sorted(
            [x for x in self.client.timeline._prompts.values()],
            key=lambda prompt: prompt.start_frame,
        )
        segments: list[ShotPromptSegment] = []
        for idx, prompt in enumerate(prompt_values):
            segments.append(
                ShotPromptSegment(
                    id=f"segment-{idx}",
                    text=prompt.text,
                    start_frame=int(prompt.start_frame),
                    end_frame=int(prompt.end_frame),
                )
            )
        return segments

    def capture_shot(self, name: str | None = None) -> Shot:
        shot_id = str(uuid.uuid4())
        shot = Shot(
            id=shot_id,
            name=name or f"Previz Shot {shot_id[:8]}",
            prompt_segments=self.current_prompt_segments(),
            selected_frame=self.session.frame_idx,
            status="editing",
            pins={
                key: ShotPin(kind=key, enabled=False)
                for key in ("left_hand", "right_hand", "left_foot", "right_foot")
            },
        )
        self.shot = shot
        self.session.previz_shot = shot
        self._set_status(f"**Previz:** Captured shot `{shot.name}`.")
        return shot

    def save_shot(self) -> str:
        shot = self.ensure_shot()
        shot.selected_frame = self.session.frame_idx
        path = self.store.save(shot)
        self._set_status(f"**Previz:** Saved shot to `{path.name}`.")
        return str(path)

    def load_shot(self, shot_id: str) -> Shot:
        shot = self.store.load(shot_id)
        self.shot = shot
        self.session.previz_shot = shot
        self.session.frame_idx = shot.selected_frame
        for key, pin in shot.pins.items():
            self.set_pin(key, pin.enabled, announce=False)
        self._set_status(f"**Previz:** Loaded shot `{shot.name}`.")
        return shot

    def ensure_shot(self) -> Shot:
        if self.shot is None:
            return self.capture_shot()
        return self.shot

    def set_pin(self, pin_key: str, enabled: bool, announce: bool = True) -> None:
        shot = self.ensure_shot()
        pin = shot.pins.get(pin_key, ShotPin(kind=pin_key, enabled=False))
        pin.enabled = enabled
        pin.frame = self.session.frame_idx if enabled else None
        shot.pins[pin_key] = pin
        if announce:
            state = "enabled" if enabled else "cleared"
            self._set_status(f"**Previz:** {pin_key.replace('_', ' ')} pin {state}.")

    def toggle(self) -> None:
        if self.enabled:
            self.disable()
        else:
            self.enable()

    def enable(self) -> None:
        motion = self.current_motion()
        if motion is None:
            self._set_status("**Previz:** Generate a take before entering previz.")
            return
        if self.session.edit_mode:
            self._set_status("**Previz:** Exit Kimodo editing mode before entering previz.")
            return

        self.enabled = True
        self.session.previz_enabled = True
        motion.character.set_skeleton_visibility(True)
        motion.character.set_skinned_mesh_visibility(True)
        motion.character.set_skinned_mesh_opacity(0.72)
        self.session.gui_elements.gui_viz_skinned_mesh_checkbox.value = True
        self.session.gui_elements.gui_viz_skeleton_checkbox.value = True
        self.session.gui_elements.gui_viz_skinned_mesh_opacity_slider.value = 0.72
        motion.clear_all_gizmos()
        motion.add_root_translation_gizmo(self.session.constraints)
        motion.add_joint_gizmos(self.session.constraints, space="local")
        self._show_rotation_gizmos_only({"Head", "Chest", "Spine3", "Spine2", "Hips", "Pelvis"})
        self._create_effector_handles()
        self.sync_handles_to_frame()
        self.ensure_shot()
        self._set_status(
            "**Previz:** Drag hands or feet for IK posing. Use the visible torso/head gizmos for silhouette tweaks."
        )

    def disable(self) -> None:
        motion = self.current_motion()
        self.enabled = False
        self.session.previz_enabled = False
        self._clear_effector_handles()
        if motion is not None:
            motion.clear_all_gizmos()
            motion.character.set_skeleton_visibility(False)
            motion.character.set_skinned_mesh_opacity(1.0)
            self.session.gui_elements.gui_viz_skinned_mesh_opacity_slider.value = 1.0
            self.session.gui_elements.gui_viz_skeleton_checkbox.value = False
        self._set_status("**Previz:** Mode exited.")

    def sync_handles_to_frame(self) -> None:
        if not self.enabled or self._syncing:
            return
        motion = self.current_motion()
        if motion is None:
            return
        frame_idx = min(self.session.frame_idx, motion.length - 1)
        joints_pos = motion.joints_pos[frame_idx].detach().cpu().numpy()
        joints_rot = motion.joints_rot[frame_idx].detach().cpu().numpy()
        self._syncing = True
        try:
            for binding in self.bindings.values():
                binding.handle.position = joints_pos[binding.joint_index]
                if binding.mode == "rotate":
                    binding.handle.wxyz = tf.SO3.from_matrix(joints_rot[binding.joint_index]).wxyz
        finally:
            self._syncing = False

    def preview_current_frame(self) -> None:
        motion = self.current_motion()
        if motion is None:
            self._set_status("**Previz:** No motion loaded.")
            return
        shot = self.ensure_shot()
        shot.selected_frame = self.session.frame_idx
        frame = self.session.frame_idx
        self.add_constraint_callback(
            f"previz-fullbody-{frame}",
            "Full-Body",
            (frame, frame),
            verbose=False,
        )
        pin_tracks = {
            "left_hand": "Left Hand",
            "right_hand": "Right Hand",
            "left_foot": "Left Foot",
            "right_foot": "Right Foot",
        }
        for pin_key, track_name in pin_tracks.items():
            pin = shot.pins.get(pin_key)
            if pin and pin.enabled:
                self.add_constraint_callback(
                    f"previz-{pin_key}-{frame}",
                    track_name,
                    (frame, frame),
                    verbose=False,
                )
        shot.status = "preview_ready"
        self._set_status("**Previz:** Current frame committed as hidden guides for regeneration.")

    def add_take(self, source: str) -> ShotTake:
        shot = self.ensure_shot()
        take = ShotTake(id=str(uuid.uuid4()), source=source)
        shot.takes.append(take)
        shot.active_take_id = take.id
        shot.status = "editing"
        return take

    def approve_current_take(self) -> None:
        shot = self.ensure_shot()
        if shot.active_take_id is None:
            self._set_status("**Previz:** No take to approve yet.")
            return
        for take in shot.takes:
            take.accepted = take.id == shot.active_take_id
        shot.status = "approved"
        self._set_status("**Previz:** Current take approved.")

    def solve_effector_drag(self, binding_name: str) -> None:
        if self._syncing or not self.enabled:
            return
        motion = self.current_motion()
        if motion is None:
            return
        binding = self.bindings[binding_name]
        chain = self._chain_for_effector(binding.joint_index)
        if len(chain) < 2:
            return
        frame_idx = min(self.session.frame_idx, motion.length - 1)
        payload = {
            "joint_names": list(self.session.skeleton.bone_order_names),
            "parents": [int(value) for value in self.session.skeleton.joint_parents.tolist()],
            "joints_pos": motion.get_joints_pos(frame_idx).tolist(),
            "joints_rot": motion.get_joints_rot(frame_idx).tolist(),
            "effectors": [
                {
                    "joint_index": binding.joint_index,
                    "chain": chain,
                    "target_position": list(binding.handle.position),
                }
            ],
            "rotation_targets": [],
        }
        for pin_key, pin_name in (
            ("left_hand", "left_hand"),
            ("right_hand", "right_hand"),
            ("left_foot", "left_foot"),
            ("right_foot", "right_foot"),
        ):
            pin = self.ensure_shot().pins.get(pin_key)
            if not pin or not pin.enabled:
                continue
            pin_binding = self.bindings.get(pin_name)
            if pin_binding is None or pin_binding.joint_index == binding.joint_index:
                continue
            payload["effectors"].append(
                {
                    "joint_index": pin_binding.joint_index,
                    "chain": self._chain_for_effector(pin_binding.joint_index),
                    "target_position": motion.joints_pos[frame_idx, pin_binding.joint_index].detach().cpu().tolist(),
                }
            )

        solved = self.solver.solve_frame(payload)
        joints_pos = torch.tensor(solved["joints_pos"], device=motion.joints_pos.device, dtype=motion.joints_pos.dtype)
        joints_rot = torch.tensor(solved["joints_rot"], device=motion.joints_rot.device, dtype=motion.joints_rot.dtype)
        motion.update_pose_at_frame(frame_idx, joints_pos=joints_pos, joints_rot=joints_rot)
        self.demo.set_frame(self.client.client_id, frame_idx, update_timeline=False)
        self._set_status(f"**Previz:** Updated {binding.joint_name} on frame {frame_idx}.")

    def _chain_for_effector(self, end_idx: int) -> list[int]:
        parents = [int(value) for value in self.session.skeleton.joint_parents.tolist()]
        chain = [end_idx]
        current = end_idx
        max_nodes = 4
        while len(chain) < max_nodes:
            parent = parents[current]
            if parent < 0:
                break
            chain.append(parent)
            current = parent
        return list(reversed(chain))

    def _show_rotation_gizmos_only(self, allowed_names: set[str]) -> None:
        motion = self.current_motion()
        if motion is None or motion.joint_gizmos is None:
            return
        for joint_idx, handle in enumerate(motion.joint_gizmos):
            joint_name = self.session.skeleton.bone_order_names[joint_idx]
            handle.visible = joint_name in allowed_names

    def _create_effector_handles(self) -> None:
        self._clear_effector_handles()
        motion = self.current_motion()
        if motion is None:
            return
        for handle_name, joint_name in (
            ("left_hand", self._find_joint_name(("LeftWrist", "LeftHand"))),
            ("right_hand", self._find_joint_name(("RightWrist", "RightHand"))),
            ("left_foot", self._find_joint_name(("LeftFoot", "LeftAnkle"))),
            ("right_foot", self._find_joint_name(("RightFoot", "RightAnkle"))),
        ):
            if joint_name is None:
                continue
            joint_idx = self.session.skeleton.bone_index[joint_name]
            handle = self.client.scene.add_transform_controls(
                f"/previz/{handle_name}",
                scale=0.18,
                line_width=3.0,
                active_axes=(True, True, True),
                disable_axes=False,
                disable_sliders=False,
                disable_rotations=True,
                depth_test=False,
            )
            binding = HandleBinding(
                name=handle_name,
                joint_name=joint_name,
                joint_index=joint_idx,
                handle=handle,
                mode="translate",
            )
            self.bindings[handle_name] = binding

            @handle.on_update
            def _(_event, binding_name=handle_name):
                self.solve_effector_drag(binding_name)

    def _clear_effector_handles(self) -> None:
        for binding in self.bindings.values():
            self.client.scene.remove_by_name(binding.handle.name)
        self.bindings.clear()

    def _find_joint_name(self, options: tuple[str, ...]) -> str | None:
        names = list(self.session.skeleton.bone_order_names)
        lowered = {name.lower(): name for name in names}
        for option in options:
            exact = lowered.get(option.lower())
            if exact is not None:
                return exact
        for option in options:
            option_lower = option.lower()
            for name in names:
                if option_lower in name.lower():
                    return name
        return None

    def _set_status(self, content: str) -> None:
        self.status_handle.content = content
