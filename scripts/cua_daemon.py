#!/usr/bin/env python3
"""
CUA Daemon – persistent process for efficient action execution.

All heavy Python modules (AppKit, Quartz, PIL, pyautogui, etc.) are loaded
ONCE at startup.  Every subsequent action incurs zero import / cold-start
overhead, giving 10-30× lower latency than spawning a new process per action.

Protocol (stdin / stdout, one JSON object per line):
  Request : {"id": "<uuid>", "action": {...}, "session_id": "<sid>"}
  Response: {"id": "<uuid>", "result": {...}, "error": null}
            {"id": "<uuid>", "result": null,  "error": "<message>"}

The daemon signals readiness immediately after imports by writing:
  {"ready": true}
"""
import sys
import os
import json

# Make scripts/ importable so we can pull in cua.execute
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ── Eager import of cua so all platform modules load now ──────────────────────
# Any import errors surface here (startup) rather than per-action, giving a
# clear diagnostic message rather than a timeout.
try:
    from cua import execute  # type: ignore[import]
except Exception as exc:
    sys.stdout.write(json.dumps({"ready": False, "error": str(exc)}) + "\n")
    sys.stdout.flush()
    sys.exit(1)

# Signal readiness to the TypeScript daemon manager
sys.stdout.write(json.dumps({"ready": True}) + "\n")
sys.stdout.flush()


def main() -> None:
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        req_id: str | None = None
        try:
            req    = json.loads(raw_line)
            req_id = req.get("id", "")
            action = req.get("action", {})

            # Per-request session env var so cua.py can write captures to the
            # right subfolder without needing to pass it through every call.
            session_id = req.get("session_id", "")
            if session_id:
                os.environ["CUA_SESSION_ID"] = session_id
            elif "CUA_SESSION_ID" in os.environ:
                del os.environ["CUA_SESSION_ID"]

            result = execute(action)
            sys.stdout.write(
                json.dumps({"id": req_id, "result": result, "error": None}) + "\n"
            )
            sys.stdout.flush()

        except Exception as exc:  # noqa: BLE001
            sys.stdout.write(
                json.dumps({"id": req_id, "result": None, "error": str(exc)}) + "\n"
            )
            sys.stdout.flush()


if __name__ == "__main__":
    main()
