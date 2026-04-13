from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen


@dataclass
class SolverClient:
    base_url: str
    timeout_seconds: float = 2.0

    def healthcheck(self) -> bool:
        try:
            with urlopen(
                Request(f"{self.base_url.rstrip('/')}/healthz", method="GET"),
                timeout=self.timeout_seconds,
            ) as response:
                return response.status == 200
        except OSError:
            return False

    def solve_frame(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = Request(
            f"{self.base_url.rstrip('/')}/solve/frame",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
                return json.loads(body)
        except URLError as exc:
            raise RuntimeError(f"Previz solver unavailable: {exc}") from exc
