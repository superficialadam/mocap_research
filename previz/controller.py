from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

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
        self._translate_targets: dict[str, list[float]] = {}
        self._rotation_targets: dict[str, list[float]] = {}
        self._active_frame_idx: int | None = None

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
        if self.enabled:
            binding = self.bindings.get(pin_key)
            if binding is not None:
                if enabled:
                    self._translate_targets[pin_key] = [float(v) for v in binding.handle.position]
                elif pin_key not in {"left_foot", "right_foot"}:
                    self._translate_targets.pop(pin_key, None)
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
        motion.character.set_skinned_mesh_opacity(0.82)
        self.session.gui_elements.gui_viz_skinned_mesh_checkbox.value = True
        self.session.gui_elements.gui_viz_skeleton_checkbox.value = True
        self.session.gui_elements.gui_viz_skinned_mesh_opacity_slider.value = 0.82
        motion.clear_all_gizmos()
        self._create_effector_handles()
        self._reset_targets_from_frame(self.session.frame_idx)
        self.sync_handles_to_frame()
        self.ensure_shot()
        self._set_status(
            "**Previz:** Feet stay planted by default. Drag hands, feet, or hips to pose the full body. Rotate chest or head for silhouette tweaks."
        )

    def disable(self) -> None:
        motion = self.current_motion()
        self.enabled = False
        self.session.previz_enabled = False
        self._clear_effector_handles()
        self._translate_targets.clear()
        self._rotation_targets.clear()
        self._active_frame_idx = None
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
        if self._active_frame_idx != frame_idx:
            self._reset_targets_from_frame(frame_idx)
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
        if binding.mode == "translate":
            self._translate_targets[binding_name] = [float(v) for v in binding.handle.position]
        else:
            self._rotation_targets[binding_name] = [float(v) for v in binding.handle.wxyz]

        solved = self._solve_current_frame(motion)
        joints_pos = torch.tensor(solved["joints_pos"], device=motion.joints_pos.device, dtype=motion.joints_pos.dtype)
        joints_rot = torch.tensor(solved["joints_rot"], device=motion.joints_rot.device, dtype=motion.joints_rot.dtype)
        frame_idx = min(self.session.frame_idx, motion.length - 1)
        motion.update_pose_at_frame(frame_idx, joints_pos=joints_pos, joints_rot=joints_rot)
        self.demo.set_frame(self.client.client_id, frame_idx, update_timeline=False)
        self._set_status(f"**Previz:** Updated {binding.joint_name} on frame {frame_idx}.")

    def _solve_current_frame(self, motion):
        frame_idx = min(self.session.frame_idx, motion.length - 1)
        payload = {
            "joint_names": list(self.session.skeleton.bone_order_names),
            "parents": [int(value) for value in self.session.skeleton.joint_parents.tolist()],
            "joints_pos": motion.get_joints_pos(frame_idx).tolist(),
            "joints_rot": motion.get_joints_rot(frame_idx).tolist(),
            "effectors": [
                {
                    "control_name": name,
                    "joint_index": self.bindings[name].joint_index,
                    "target_position": target,
                }
                for name, target in self._translate_targets.items()
                if name in self.bindings
            ],
            "rotation_targets": [
                {
                    "control_name": name,
                    "joint_index": self.bindings[name].joint_index,
                    "target_wxyz": target,
                }
                for name, target in self._rotation_targets.items()
                if name in self.bindings
            ],
        }
        return self.solver.solve_frame(payload)

    def _reset_targets_from_frame(self, frame_idx: int) -> None:
        motion = self.current_motion()
        if motion is None:
            return
        joints_pos = motion.joints_pos[frame_idx].detach().cpu().numpy()
        self._translate_targets = {}
        self._rotation_targets = {}
        for default_name in ("left_foot", "right_foot"):
            binding = self.bindings.get(default_name)
            if binding is not None:
                self._translate_targets[default_name] = joints_pos[binding.joint_index].astype(float).tolist()

        shot = self.ensure_shot()
        for pin_key, pin in shot.pins.items():
            if not pin.enabled:
                continue
            binding = self.bindings.get(pin_key)
            if binding is not None and binding.mode == "translate":
                self._translate_targets[pin_key] = joints_pos[binding.joint_index].astype(float).tolist()
        self._active_frame_idx = frame_idx

    def _create_effector_handles(self) -> None:
        self._clear_effector_handles()
        motion = self.current_motion()
        if motion is None:
            return
        for handle_name, joint_name, scale in (
            ("hips", self._find_joint_name(("Hips", "Pelvis", "Hip")), 0.24),
            ("left_hand", self._find_joint_name(("LeftWrist", "LeftHand")), 0.18),
            ("right_hand", self._find_joint_name(("RightWrist", "RightHand")), 0.18),
            ("left_foot", self._find_joint_name(("LeftFoot", "LeftAnkle")), 0.18),
            ("right_foot", self._find_joint_name(("RightFoot", "RightAnkle")), 0.18),
        ):
            if joint_name is None:
                continue
            joint_idx = self.session.skeleton.bone_index[joint_name]
            handle = self.client.scene.add_transform_controls(
                f"/previz/{handle_name}",
                scale=scale,
                line_width=3.5,
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

        for handle_name, joint_name, scale in (
            ("chest", self._find_joint_name(("Chest", "UpperChest", "Spine3", "Spine2")), 0.2),
            ("head", self._find_joint_name(("Head", "Neck")), 0.16),
        ):
            if joint_name is None:
                continue
            joint_idx = self.session.skeleton.bone_index[joint_name]
            handle = self.client.scene.add_transform_controls(
                f"/previz/{handle_name}",
                scale=scale,
                line_width=3.5,
                active_axes=(True, True, True),
                disable_axes=True,
                disable_sliders=True,
                disable_rotations=False,
                depth_test=False,
            )
            binding = HandleBinding(
                name=handle_name,
                joint_name=joint_name,
                joint_index=joint_idx,
                handle=handle,
                mode="rotate",
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
