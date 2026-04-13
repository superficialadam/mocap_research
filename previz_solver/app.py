from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .solver import solve_frame_payload


class Handler(BaseHTTPRequestHandler):
    def _json_response(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._json_response(200, {"ok": True})
            return
        self._json_response(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/solve/frame":
            self._json_response(404, {"error": "not_found"})
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        solved = solve_frame_payload(payload)
        self._json_response(200, solved)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def main() -> None:
    host = os.environ.get("PREVIZ_SOLVER_HOST", "127.0.0.1")
    port = int(os.environ.get("PREVIZ_SOLVER_PORT", "8765"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Previz solver listening on http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
