from __future__ import annotations

import json
from pathlib import Path

from .models import Shot


class ShotStore:
    def __init__(self, root_dir: str | Path):
        self.root_dir = Path(root_dir)
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def shot_path(self, shot_id: str) -> Path:
        return self.root_dir / f"{shot_id}.json"

    def save(self, shot: Shot) -> Path:
        path = self.shot_path(shot.id)
        path.write_text(json.dumps(shot.to_dict(), indent=2), encoding="utf-8")
        return path

    def load(self, shot_id: str) -> Shot:
        path = self.shot_path(shot_id)
        return Shot.from_dict(json.loads(path.read_text(encoding="utf-8")))

