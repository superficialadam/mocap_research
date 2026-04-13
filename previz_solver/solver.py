from __future__ import annotations

import math

import numpy as np


def _normalize(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    if norm < 1e-8:
        return np.zeros_like(vector)
    return vector / norm


def _rotation_from_vectors(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    source_n = _normalize(source)
    target_n = _normalize(target)
    if np.linalg.norm(source_n) < 1e-8 or np.linalg.norm(target_n) < 1e-8:
        return np.eye(3, dtype=np.float32)

    cross = np.cross(source_n, target_n)
    dot = float(np.clip(np.dot(source_n, target_n), -1.0, 1.0))
    if np.linalg.norm(cross) < 1e-8:
        if dot > 0.9999:
            return np.eye(3, dtype=np.float32)
        axis = _normalize(
            np.cross(source_n, np.array([1.0, 0.0, 0.0], dtype=np.float32))
        )
        if np.linalg.norm(axis) < 1e-8:
            axis = _normalize(
                np.cross(source_n, np.array([0.0, 1.0, 0.0], dtype=np.float32))
            )
        angle = math.pi
    else:
        axis = _normalize(cross)
        angle = math.acos(dot)

    kx, ky, kz = axis
    K = np.array(
        [[0.0, -kz, ky], [kz, 0.0, -kx], [-ky, kx, 0.0]],
        dtype=np.float32,
    )
    identity = np.eye(3, dtype=np.float32)
    return identity + math.sin(angle) * K + (1.0 - math.cos(angle)) * (K @ K)


def _fabrik(points: np.ndarray, target: np.ndarray) -> np.ndarray:
    solved = points.copy()
    root = solved[0].copy()
    lengths = np.linalg.norm(np.diff(solved, axis=0), axis=1)
    total_length = float(np.sum(lengths))
    root_to_target = float(np.linalg.norm(target - root))

    if root_to_target >= total_length:
        direction = _normalize(target - root)
        for idx in range(1, len(solved)):
            solved[idx] = solved[idx - 1] + direction * lengths[idx - 1]
        return solved

    for _ in range(8):
        solved[-1] = target
        for idx in range(len(solved) - 2, -1, -1):
            direction = _normalize(solved[idx] - solved[idx + 1])
            solved[idx] = solved[idx + 1] + direction * lengths[idx]

        solved[0] = root
        for idx in range(1, len(solved)):
            direction = _normalize(solved[idx] - solved[idx - 1])
            solved[idx] = solved[idx - 1] + direction * lengths[idx - 1]

        if np.linalg.norm(solved[-1] - target) < 1e-3:
            break

    return solved


def solve_frame_payload(payload: dict) -> dict:
    joints_pos = np.asarray(payload["joints_pos"], dtype=np.float32)
    joints_rot = np.asarray(payload["joints_rot"], dtype=np.float32)

    for effector in payload.get("effectors", []):
        chain = [int(index) for index in effector["chain"]]
        if len(chain) < 2:
            continue
        target = np.asarray(effector["target_position"], dtype=np.float32)
        current_chain = joints_pos[chain].copy()
        solved_chain = _fabrik(current_chain, target)
        joints_pos[chain] = solved_chain

        for idx in range(len(chain) - 1):
            joint_index = chain[idx]
            child_index = chain[idx + 1]
            old_vector = current_chain[idx + 1] - current_chain[idx]
            new_vector = solved_chain[idx + 1] - solved_chain[idx]
            delta = _rotation_from_vectors(old_vector, new_vector)
            joints_rot[joint_index] = delta @ joints_rot[joint_index]

    for rotation_target in payload.get("rotation_targets", []):
        joint_index = int(rotation_target["joint_index"])
        joints_rot[joint_index] = np.asarray(rotation_target["rotation_matrix"], dtype=np.float32)

    return {
        "joints_pos": joints_pos.tolist(),
        "joints_rot": joints_rot.tolist(),
    }
