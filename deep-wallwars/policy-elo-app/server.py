#!/usr/bin/env python3
"""Small static server for the policy Elo explorer."""

import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data" / "policy-elo.json"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def do_GET(self):
        if self.path == "/api/data":
            try:
                payload = DATA.read_bytes()
            except FileNotFoundError:
                payload = json.dumps({"error": "Policy Elo snapshot is not built."}).encode()
                self.send_response(503)
            else:
                self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def log_message(self, message, *args):
        print(f"policy-elo: {message % args}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"Policy Elo explorer listening on {port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
