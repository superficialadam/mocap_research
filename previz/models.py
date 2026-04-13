from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class ShotPromptSegment:
    id: str
    text: str
    start_frame: int
    end_frame: int


@dataclass
class ShotPin:
    kind: str
    enabled: bool
    frame: int | None = None


@dataclass
class ShotTake:
    id: str
    source: str
    created_at: str = field(default_factory=utc_now_iso)
    accepted: bool = False


@dataclass
class Shot:
    id: str
    name: str
    prompt_segments: list[ShotPromptSegment] = field(default_factory=list)
    selected_frame: int = 0
    pins: dict[str, ShotPin] = field(default_factory=dict)
    takes: list[ShotTake] = field(default_factory=list)
    active_take_id: str | None = None
    status: str = "idle"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Shot":
        prompt_segments = [
            ShotPromptSegment(**segment) for segment in data.get("prompt_segments", [])
        ]
        pins = {
            key: ShotPin(**pin)
            for key, pin in data.get("pins", {}).items()
        }
        takes = [ShotTake(**take) for take in data.get("takes", [])]
        return cls(
            id=data["id"],
            name=data["name"],
            prompt_segments=prompt_segments,
            selected_frame=data.get("selected_frame", 0),
            pins=pins,
            takes=takes,
            active_take_id=data.get("active_take_id"),
            status=data.get("status", "idle"),
        )
