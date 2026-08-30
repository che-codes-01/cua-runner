#!/usr/bin/env python3
"""
CUA (Computer Use Agent) action executor.

Called by the runner agent as:
    python3 cua.py <base64-encoded-json-action>

Returns a JSON result on stdout:
    { "type": "image", "data": "<base64-png>" }
    { "type": "text",  "text": "..." }
    { "type": "error", "error": "..." }

Backend selection (CUA_BACKEND env var):
    auto       — pick from platform  (default)
    cliclick   — macOS, cliclick CLI  (brew install cliclick)
    xdotool    — Linux, xdotool       (apt install xdotool)
    pyautogui  — any platform, legacy pyautogui fallback
"""

import sys
import json
import base64
import os
import platform
import subprocess
import time
import tempfile
import shutil
from datetime import datetime

# ── Backend selection ──────────────────────────────────────────────────────────

_SYSTEM  = platform.system()           # "Darwin" | "Linux" | "Windows"
_BACKEND = os.environ.get("CUA_BACKEND", "auto").lower()

if _BACKEND == "auto":
    if _SYSTEM == "Darwin":
        _BACKEND = "cliclick"
    elif _SYSTEM == "Linux":
        _BACKEND = "xdotool"
    else:
        _BACKEND = "pyautogui"

# ── Detect macOS Retina scale factor at import time ───────────────────────────
# Each cua.py subprocess invocation needs the scale immediately — we cannot
# wait for a screenshot action to set it.

def _macos_scale_factor() -> float:
    """Return the backing scale factor (2.0 on Retina, 1.0 otherwise)."""
    try:
        from AppKit import NSScreen          # type: ignore[import]
        s = NSScreen.mainScreen()
        if s is not None:
            return float(s.backingScaleFactor())
    except Exception:
        pass
    return 1.0


# Logical-screen size helpers (used for screenshot metadata)
def _macos_logical_size() -> tuple[int, int]:
    """Return (logical_w, logical_h) in CSS / cliclick points."""
    # AppKit is the primary source — no Automation permission needed.
    try:
        from AppKit import NSScreen          # type: ignore[import]
        s = NSScreen.mainScreen()
        if s is not None:
            f = s.frame()
            return int(f.size.width), int(f.size.height)
    except Exception:
        pass
    # Pure-Python Quartz fallback — also needs no Automation permission.
    try:
        import Quartz                        # type: ignore[import]
        did = Quartz.CGMainDisplayID()
        w   = Quartz.CGDisplayPixelsWide(did)
        h   = Quartz.CGDisplayPixelsHigh(did)
        scale = _macos_scale_factor()
        return int(w / scale), int(h / scale)
    except Exception:
        pass
    return 0, 0


# (scale factor only used inside _screenshot for the sips resize step)


# ── Shared: key-name normalisation ────────────────────────────────────────────

# Canonical names used internally; each backend maps FROM these.
_KEY_NORM: dict[str, str] = {
    # enter / whitespace
    "return": "enter",   "Return": "enter",
    "backspace": "backspace", "BackSpace": "backspace",
    "delete": "delete",  "Delete": "delete",
    "escape": "escape",  "Escape": "escape",
    "tab": "tab",        "Tab": "tab",
    "space": "space",
    # arrows / navigation
    "up": "up",    "Up": "up",
    "down": "down","Down": "down",
    "left": "left","Left": "left",
    "right": "right","Right": "right",
    "home": "home","Home": "home",
    "end": "end",  "End": "end",
    "pageup": "pageup",  "Prior": "pageup",
    "pagedown": "pagedown","Next": "pagedown",
    # modifiers
    "ctrl": "ctrl",   "control": "ctrl", "Control": "ctrl",
    "Control_L": "ctrl", "Control_R": "ctrl",
    "shift": "shift", "Shift": "shift",
    "Shift_L": "shift","Shift_R": "shift",
    "alt": "alt",     "Alt": "alt", "Alt_L": "alt", "Alt_R": "alt",
    "option": "alt",  "Option": "alt",
    # command / cmd  (macOS ⌘) — silently ignored on Linux/Windows
    "cmd": "cmd", "Cmd": "cmd",
    "command": "cmd", "Command": "cmd",
    "meta": "cmd", "Meta": "cmd", "Meta_L": "cmd",
    # super / win  (Linux/Windows ⊞)
    "super": "super", "Super": "super", "Super_L": "super",
    "win": "super",   "windows": "super",
}
for _i in range(1, 13):
    _KEY_NORM[f"F{_i}"] = f"f{_i}"

def _norm_key(k: str) -> str:
    return _KEY_NORM.get(k, k.lower())

def _norm_combo(raw: str) -> list[str]:
    """Split 'cmd+shift+a' → ['cmd','shift','a'] with normalised names."""
    return [_norm_key(p) for p in raw.split("+")]


# ── Shared: screenshot ─────────────────────────────────────────────────────────


_XVFB_PROC = None   # keep alive at module level

def _ensure_display() -> None:
    """On Linux, guarantee $DISPLAY is set; auto-start Xvfb if needed."""
    global _XVFB_PROC
    if _SYSTEM != "Linux":
        return

    def _probe(display: str) -> bool:
        try:
            return subprocess.run(
                ["xdpyinfo", "-display", display],
                capture_output=True, timeout=3,
            ).returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return False

    current = os.environ.get("DISPLAY", "")
    if current and _probe(current):
        return
    for candidate in (":0", ":1", ":2", ":10", ":99"):
        if _probe(candidate):
            os.environ["DISPLAY"] = candidate
            return
    if shutil.which("Xvfb") is None:
        raise RuntimeError(
            "No display server found and Xvfb is not installed.\n"
            "  Debian/Ubuntu: sudo apt-get install -y xvfb\n"
            "  RHEL/CentOS:   sudo yum install -y xorg-x11-server-Xvfb"
        )
    _XVFB_PROC = subprocess.Popen(
        ["Xvfb", ":99", "-screen", "0", "1920x1080x24", "-ac"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if _probe(":99"):
            os.environ["DISPLAY"] = ":99"
            return
        time.sleep(0.2)
    _XVFB_PROC.terminate()
    raise RuntimeError("Xvfb started but did not become reachable within 5 s.")


# ── Captures folder ──────────────────────────────────────────────────────────────
# All screenshots and zoom crops are written here with a timestamp prefix so
# they accumulate in order and can be reviewed later.

_CAPTURES_DIR = os.path.join(tempfile.gettempdir(), "cua-captures")


def _capture_path(label: str) -> str:
    """Return a timestamped file path inside <captures>/<session-id>/."""
    session_id = os.environ.get("CUA_SESSION_ID", "no-session")
    folder = os.path.join(_CAPTURES_DIR, session_id)
    os.makedirs(folder, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S-%f")[:-3]  # millisecond precision
    return os.path.join(folder, f"{ts}-{label}.png")


# ── Coordinate grid overlay ──────────────────────────────────────────────────────────
#
# Draws axis rulers on every screenshot so the vision model can read exact
# pixel coordinates directly from the image instead of guessing positions.
# offset_x / offset_y shift the displayed numbers (used by zoom so labels
# show absolute screen coordinates rather than image-local ones).

def _add_grid_overlay(
    img_path: str,
    grid_px: int = 200,
    offset_x: int = 0,
    offset_y: int = 0,
) -> None:
    """Annotate an image file in-place with a semi-transparent coordinate grid."""
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore[import]
    except ImportError:
        return  # Pillow not available — skip silently

    img  = Image.open(img_path).convert("RGBA")
    grid = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(grid)
    w, h = img.size

    # Try a legible system font; fall back to PIL default
    font: ImageFont.ImageFont | ImageFont.FreeTypeFont
    for font_path in (
        "/System/Library/Fonts/Helvetica.ttc",           # macOS
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",  # Linux
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ):
        try:
            font = ImageFont.truetype(font_path, 14)
            break
        except (OSError, IOError):
            pass
    else:
        font = ImageFont.load_default()

    GRID    = (255,  80,  80,  70)   # red lines
    TEXT    = (255, 255, 255, 255)   # white labels
    TEXT_BG = (  0,   0,   0, 200)   # opaque dark background

    def _label(x: int, y: int, text: str) -> None:
        try:
            bbox = font.getbbox(text)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        except AttributeError:
            tw, th = draw.textsize(text, font=font)  # type: ignore[attr-defined]
        pad = 2
        draw.rectangle([x, y, x + tw + pad * 2, y + th + pad * 2], fill=TEXT_BG)
        draw.text((x + pad, y + pad), text, fill=TEXT, font=font)

    for x in range(0, w, grid_px):
        draw.line([(x, 0), (x, h)], fill=GRID, width=1)
        _label(x + 2, 2, str(x + offset_x))

    for y in range(0, h, grid_px):
        draw.line([(0, y), (w, y)], fill=GRID, width=1)
        _label(2, y + 2, str(y + offset_y))

    merged = Image.alpha_composite(img, grid).convert("RGB")
    merged.save(img_path, "PNG")


def _screenshot() -> dict:
    path = _capture_path("screenshot")

    if _SYSTEM == "Darwin":
        scale = _macos_scale_factor()
        lw, lh = _macos_logical_size()
        # -C includes the cursor so the AI can see where the mouse is.
        # After capture, resize to LOGICAL resolution so that every pixel
        # in the returned image maps 1:1 to a cliclick coordinate.
        # The AI model reports coordinates in logical/visual space regardless
        # of the raw image resolution — returning native (2×) caused clicks
        # to land at half the intended position.
        r = subprocess.run(["screencapture", "-C", "-x", "-t", "png", path],
                           capture_output=True)
        if r.returncode != 0:
            err = r.stderr.decode(errors="replace").strip()
            raise PermissionError(
                f"screencapture failed: {err or '(no stderr)'}\n"
                "Grant Screen Recording: System Settings → Privacy & Security "
                "→ Screen Recording → add your terminal app → restart runner."
            )
        # Resize native capture to LOGICAL resolution so every pixel in the
        # returned image maps 1:1 to a click coordinate (matches MCP server).
        if lw and lw > 0:
            r2 = subprocess.run(["sips", "-g", "pixelWidth", path],
                                capture_output=True, text=True)
            native_w = 0
            for line in r2.stdout.splitlines():
                if "pixelWidth:" in line:
                    try: native_w = int(line.split(":")[1].strip())
                    except ValueError: pass
            if native_w and native_w > lw:
                subprocess.run(
                    ["sips", "--resampleWidth", str(lw), path, "--out", path],
                    capture_output=True,
                )

    elif _SYSTEM == "Linux":
        _ensure_display()
        display = os.environ.get("DISPLAY", ":99")
        env = {**os.environ, "DISPLAY": display}
        errors: list[str] = []
        captured = False

        if not captured and shutil.which("scrot"):
            r = subprocess.run(["scrot", path], env=env, capture_output=True)
            if r.returncode == 0:
                captured = True
            else:
                errors.append("scrot: " + r.stderr.decode(errors="replace").strip())

        if not captured and shutil.which("import"):
            r = subprocess.run(["import", "-window", "root", path],
                               env=env, capture_output=True)
            if r.returncode == 0:
                captured = True
            else:
                errors.append("import: " + r.stderr.decode(errors="replace").strip())

        if not captured and shutil.which("xwd") and shutil.which("convert"):
            xwd = subprocess.run(
                ["xwd", "-root", "-silent", "-display", display],
                env=env, capture_output=True)
            if xwd.returncode == 0:
                conv = subprocess.run(
                    ["convert", "xwd:-", f"png:{path}"],
                    input=xwd.stdout, capture_output=True)
                if conv.returncode == 0:
                    captured = True
                else:
                    errors.append("xwd+convert: " + conv.stderr.decode(errors="replace").strip())
            else:
                errors.append("xwd: " + xwd.stderr.decode(errors="replace").strip())

        if not captured:
            raise RuntimeError(
                f"All screenshot methods failed on display {display!r}.\n"
                + "\n".join(f"  • {e}" for e in errors)
                + "\nInstall one of: scrot, imagemagick, xwd."
            )
    else:
        import pyautogui  # noqa: PLC0415
        pyautogui.screenshot(path)

    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()

    return {"type": "image", "data": data, "path": path}


# ── Model image resolution ────────────────────────────────────────────────
#
# Vision APIs (Claude, GPT-4o) silently downscale large images to fit their
# budget (Claude: <=1568px long edge AND <=~1.15 MP). The model then reports
# coordinates in that DOWNSCALED space. If we send a full Retina-logical
# screenshot (e.g. 1728x1117 = 1.9 MP) the API shrinks it and every returned
# coordinate is off by 25-35%.
#
# Fix (matches Anthropic's computer-use reference): send screenshots at a fixed
# WXGA-class resolution the API will NOT further resize, and scale the model's
# returned coordinates back up to logical screen pixels before clicking.

MODEL_MAX_W = 1280
MODEL_MAX_H = 800


def _model_scale() -> float:
    """Downscale factor from logical screen -> model image (<=1.0).
    Model coords are in the downscaled space; divide by this to get logical."""
    lw, lh = _macos_logical_size()
    if lw <= 0 or lh <= 0:
        return 1.0
    return min(1.0, MODEL_MAX_W / lw, MODEL_MAX_H / lh)


def _to_logical(x: int, y: int) -> tuple[int, int]:
    # The screenshot is returned at LOGICAL resolution, so coordinates the model
    # reports map 1:1 to click coordinates. Pass them straight through.
    # (This matches the MCP server path, which is known to click accurately.)
    return x, y


# ── Backend: cliclick (macOS) ─────────────────────────────────────────────────
#
#   Install: brew install cliclick
#   Docs:    https://github.com/BlueM/cliclick

# Canonical key → cliclick key name
_CLICLICK_KEYS: dict[str, str] = {
    "enter": "return", "backspace": "delete", "delete": "forwarddelete",
    "escape": "escape", "tab": "tab", "space": "space",
    "up": "arrow-up", "down": "arrow-down",
    "left": "arrow-left", "right": "arrow-right",
    "home": "home", "end": "end",
    "pageup": "page-up", "pagedown": "page-down",
    "cmd": "cmd", "ctrl": "ctrl", "shift": "shift", "alt": "alt",
}
for _i in range(1, 13):
    _CLICLICK_KEYS[f"f{_i}"] = f"f{_i}"


def _cliclick(*args: str) -> None:
    if not shutil.which("cliclick"):
        raise RuntimeError(
            "cliclick is not installed.\n"
            "  brew install cliclick\n"
            "Then restart the runner."
        )
    r = subprocess.run(["cliclick"] + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"cliclick error: {r.stderr.strip() or r.stdout.strip()}")


def _cliclick_key(name: str) -> str:
    """Map a canonical key name to cliclick format."""
    return _CLICLICK_KEYS.get(name, name)


def _cliclick_cursor() -> tuple[int, int]:
    """Return current cursor position using Quartz (no extra deps needed)."""
    try:
        import Quartz                              # type: ignore[import]
        from AppKit import NSScreen                # type: ignore[import]
        pos = Quartz.NSEvent.mouseLocation()
        h   = NSScreen.mainScreen().frame().size.height
        return int(pos.x), int(h - pos.y)
    except Exception:
        return (-1, -1)



# ── Shared: macOS Quartz keyboard helper ─────────────────────────────────────
#
# CGEventPost is the lowest-level API for synthetic input on macOS.
# It requires Accessibility permission but is far more reliable than
# cliclick or pyautogui for modifier key combinations.

# macOS virtual keycodes (same across all keyboard layouts)
_MAC_KEYCODES: dict[str, int] = {
    'a': 0,  's': 1,  'd': 2,  'f': 3,  'h': 4,  'g': 5,  'z': 6,  'x': 7,
    'c': 8,  'v': 9,  'b': 11, 'q': 12, 'w': 13, 'e': 14, 'r': 15, 'y': 16,
    't': 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24,
    '9': 25, '7': 26, '-': 27, '8': 28, '0': 29, ']': 30, 'o': 31, 'u': 32,
    '[': 33, 'i': 34, 'p': 35, 'l': 37, 'j': 38, "'": 39, 'k': 40, ';': 41,
    '\\': 42, ',': 43, '/': 44, 'n': 45, 'm': 46, '.': 47,
    'tab': 48, 'space': 49, '`': 50, 'backspace': 51, 'delete': 51,
    'escape': 53, 'return': 36, 'enter': 36,
    'forwarddelete': 117, 'home': 115, 'end': 119,
    'pageup': 116, 'pagedown': 121,
    'up': 126, 'down': 125, 'left': 123, 'right': 124,
    'f1': 122, 'f2': 120, 'f3': 99,  'f4': 118, 'f5': 96,  'f6': 97,
    'f7': 98,  'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
}

# CGEventFlags bit masks
_MAC_MODIFIER_FLAGS: dict[str, int] = {
    'cmd':     0x00100000,   # kCGEventFlagMaskCommand
    'command': 0x00100000,
    'shift':   0x00020000,   # kCGEventFlagMaskShift
    'ctrl':    0x00040000,   # kCGEventFlagMaskControl
    'control': 0x00040000,
    'alt':     0x00080000,   # kCGEventFlagMaskAlternate
    'option':  0x00080000,
}


def _parse_combo(raw: str) -> tuple[int, int]:
    """
    Parse a key combo string in either format:
      cross-platform : "cmd+shift+t"  (plus-separated, canonical names)
      cliclick native: "kp:cmd-shift-t" or "kp:return"
    Returns (flags, keycode) for Quartz.
    """
    # Strip cliclick kp:/kd:/ku: prefix and convert dashes to pluses
    if raw.startswith(("kp:", "kd:", "ku:")):
        combo = raw[3:].replace("-", "+")
    else:
        combo = raw

    parts = _norm_combo(combo)   # normalise each token
    flags   = 0
    keycode = None
    for part in parts:
        if part in _MAC_MODIFIER_FLAGS:
            flags |= _MAC_MODIFIER_FLAGS[part]
        else:
            kc = _MAC_KEYCODES.get(part)
            if kc is None:
                raise ValueError(
                    f"Unknown key {part!r} in combo {raw!r}.\n"
                    f"Supported keys: {sorted(_MAC_KEYCODES)}"
                )
            keycode = kc
    if keycode is None:
        raise ValueError(f"No non-modifier key found in combo {raw!r}")
    return flags, keycode


def _quartz_key(combo: str) -> None:
    """
    Send a key or key combo via Quartz CGEventPost (macOS only).
    Accepts both  "cmd+l"  and  "kp:cmd-l"  notation.
    Requires Accessibility permission (same as cliclick / pyautogui).
    """
    import Quartz  # noqa: PLC0415
    flags, keycode = _parse_combo(combo)
    down = Quartz.CGEventCreateKeyboardEvent(None, keycode, True)
    up   = Quartz.CGEventCreateKeyboardEvent(None, keycode, False)
    if flags:
        Quartz.CGEventSetFlags(down, flags)
        Quartz.CGEventSetFlags(up,   flags)
    Quartz.CGEventPost(Quartz.kCGSessionEventTap, down)
    time.sleep(0.02)   # tiny gap so the target app registers the press
    Quartz.CGEventPost(Quartz.kCGSessionEventTap, up)


# ── pyautogui keyboard helper (cliclick backend uses this for key/type) ──────
#
# cliclick handles mouse reliably.  For keyboard we use pyautogui instead of
# osascript because:
#   - osascript requires Automation → System Events permission (often not granted)
#   - pyautogui only needs Accessibility (already required for mouse anyway)
#   - pyautogui keyboard via CGEventPost works on all macOS GUI sessions

_PG_KEYS: dict[str, str] = {
    "enter": "enter", "return": "enter",
    "backspace": "backspace", "delete": "delete",
    "escape": "escape", "tab": "tab", "space": "space",
    "up": "up", "down": "down", "left": "left", "right": "right",
    "home": "home", "end": "end", "pageup": "pageup", "pagedown": "pagedown",
    "ctrl": "ctrl",  "shift": "shift", "alt": "alt",
    "cmd": "command", "command": "command",
    "super": "win",
}
for _i in range(1, 13):
    _PG_KEYS[f"f{_i}"] = f"f{_i}"


def _pg_key(name: str) -> str:
    return _PG_KEYS.get(name, name)


def _pyautogui_key(combo: str) -> None:
    """Send a key or key combo via pyautogui (CGEventPost, needs Accessibility)."""
    import pyautogui          # noqa: PLC0415
    pyautogui.FAILSAFE = False
    parts = _norm_combo(combo)
    keys  = [_pg_key(p) for p in parts]
    if len(keys) == 1:
        pyautogui.press(keys[0])
    else:
        pyautogui.hotkey(*keys)


def _pyautogui_type(text: str) -> None:
    """Paste text via clipboard + Quartz Cmd+V (macOS only)."""
    subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)
    time.sleep(0.05)
    _quartz_key("cmd+v")


def _backend_cliclick(t: str, action: dict) -> dict:
    if t == "cursor_position":
        x, y = _cliclick_cursor()
        return {"type": "text", "text": f"Cursor at {x},{y}", "x": x, "y": y}

    if t == "mouse_move":
        x, y = _coord(t, action, "coordinate")
        _cliclick(f"m:{x},{y}")
        cx, cy = _cliclick_cursor()
        return {"type": "text", "text": f"Moved mouse to {x},{y} [cursor at {cx},{cy}]"}

    if t == "left_click":
        x, y = _coord(t, action, "coordinate")
        _cliclick(f"c:{x},{y}")
        return {"type": "text", "text": f"Left-clicked at {x},{y}"}

    if t == "double_click":
        x, y = _coord(t, action, "coordinate")
        _cliclick(f"dc:{x},{y}")
        return {"type": "text", "text": f"Double-clicked at {x},{y}"}

    if t == "right_click":
        x, y = _coord(t, action, "coordinate")
        _cliclick(f"rc:{x},{y}")
        return {"type": "text", "text": f"Right-clicked at {x},{y}"}

    if t == "left_click_drag":
        sx, sy = _coord(t, action, "start_coordinate")
        ex, ey = _coord(t, action, "coordinate")
        # drag-down at start, move, drag-up at end
        _cliclick(f"dd:{sx},{sy}", f"m:{ex},{ey}", f"du:{ex},{ey}")
        return {"type": "text", "text": f"Dragged {sx},{sy} → {ex},{ey}"}

    if t == "type":
        text = action.get("text", "")
        _pyautogui_type(text)   # pbcopy + cmd+v via pyautogui (no Automation needed)
        return {"type": "text", "text": f"Typed: {text!r}"}

    if t == "key":
        raw = action.get("text", "")
        # Use Quartz for all keyboard combos on macOS — it is more reliable
        # than cliclick for modifier key combinations and does not require a
        # separate accessibility grant beyond what the runner already holds.
        _quartz_key(raw)
        return {"type": "text", "text": f"Pressed key: {raw}"}

    if t == "scroll":
        x, y  = (action.get("coordinate") or [0, 0])
        x, y  = int(x), int(y)
        dirn  = action["scroll_direction"]
        amt   = int(action["scroll_amount"])
        # Move cursor first, then post scroll via Quartz (cliclick has no scroll)
        _cliclick(f"m:{x},{y}")
        time.sleep(0.05)
        try:
            import Quartz                          # type: ignore[import]
            dx = amt if dirn == "right" else (-amt if dirn == "left" else 0)
            dy = amt if dirn == "up"    else (-amt if dirn == "down"  else 0)
            ev = Quartz.CGEventCreateScrollWheelEvent(
                None, Quartz.kCGScrollEventUnitLine, 2,
                dy, dx,
            )
            Quartz.CGEventPost(Quartz.kCGSessionEventTap, ev)
        except Exception as exc:
            raise RuntimeError(f"scroll failed: {exc}") from exc
        return {"type": "text", "text": f"Scrolled {dirn} ×{amt}"}

    raise ValueError(f"Unknown action type for cliclick backend: {t!r}")


# ── Backend: xdotool (Linux) ──────────────────────────────────────────────────
#
#   Install: sudo apt-get install xdotool   (Debian/Ubuntu)
#            sudo yum install xdotool       (RHEL/CentOS)

# Canonical key → X11 key symbol (xdotool format)
_XDOTOOL_KEYS: dict[str, str] = {
    "enter": "Return", "backspace": "BackSpace", "delete": "Delete",
    "escape": "Escape", "tab": "Tab", "space": "space",
    "up": "Up", "down": "Down", "left": "Left", "right": "Right",
    "home": "Home", "end": "End",
    "pageup": "Page_Up", "pagedown": "Page_Down",
    # modifiers
    "ctrl": "ctrl", "shift": "shift", "alt": "alt",
    # cmd/super: macOS → Linux ctrl mapping for common shortcuts
    "cmd": "ctrl",   "super": "super",
}
for _i in range(1, 13):
    _XDOTOOL_KEYS[f"f{_i}"] = f"F{_i}"


def _xdo(*args: str) -> str:
    if not shutil.which("xdotool"):
        raise RuntimeError(
            "xdotool is not installed.\n"
            "  sudo apt-get install xdotool   # Debian/Ubuntu\n"
            "  sudo yum install xdotool       # RHEL/CentOS\n"
            "Then restart the runner."
        )
    _ensure_display()
    env = {**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":0")}
    r = subprocess.run(["xdotool"] + list(args), capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise RuntimeError(f"xdotool error: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout


def _xdo_key(name: str) -> str:
    return _XDOTOOL_KEYS.get(name, name)


def _backend_xdotool(t: str, action: dict) -> dict:
    if t == "cursor_position":
        out = _xdo("getmouselocation", "--shell")
        info = {k: v for k, v in (line.split("=", 1)
                for line in out.strip().splitlines() if "=" in line)}
        x, y = int(info.get("X", 0)), int(info.get("Y", 0))
        return {"type": "text", "text": f"Cursor at {x},{y}", "x": x, "y": y}

    if t == "mouse_move":
        x, y = _coord(t, action, "coordinate")
        _xdo("mousemove", str(x), str(y))
        return {"type": "text", "text": f"Moved mouse to {x},{y}"}

    if t == "left_click":
        x, y = _coord(t, action, "coordinate")
        _xdo("mousemove", str(x), str(y))
        _xdo("click", "--clearmodifiers", "1")
        return {"type": "text", "text": f"Left-clicked at {x},{y}"}

    if t == "double_click":
        x, y = _coord(t, action, "coordinate")
        _xdo("mousemove", str(x), str(y))
        _xdo("click", "--clearmodifiers", "--repeat", "2", "--delay", "100", "1")
        return {"type": "text", "text": f"Double-clicked at {x},{y}"}

    if t == "right_click":
        x, y = _coord(t, action, "coordinate")
        _xdo("mousemove", str(x), str(y))
        _xdo("click", "--clearmodifiers", "3")
        return {"type": "text", "text": f"Right-clicked at {x},{y}"}

    if t == "left_click_drag":
        sx, sy = _coord(t, action, "start_coordinate")
        ex, ey = _coord(t, action, "coordinate")
        _xdo("mousemove", str(sx), str(sy))
        _xdo("mousedown", "1")
        time.sleep(0.1)
        _xdo("mousemove", "--sync", str(ex), str(ey))
        time.sleep(0.1)
        _xdo("mouseup", "1")
        return {"type": "text", "text": f"Dragged {sx},{sy} → {ex},{ey}"}

    if t == "type":
        text = action.get("text", "")
        _xdo("type", "--clearmodifiers", "--", text)
        return {"type": "text", "text": f"Typed: {text!r}"}

    if t == "key":
        raw   = action.get("text", "")
        parts = _norm_combo(raw)
        combo = "+".join(_xdo_key(p) for p in parts)
        _xdo("key", "--clearmodifiers", combo)
        return {"type": "text", "text": f"Pressed key: {raw}"}

    if t == "scroll":
        x, y  = (action.get("coordinate") or [0, 0])
        x, y  = int(x), int(y)
        dirn  = action["scroll_direction"]
        amt   = int(action["scroll_amount"])
        # xdotool button 4=up 5=down 6=left 7=right
        btn   = {"up": "4", "down": "5", "left": "6", "right": "7"}[dirn]
        _xdo("mousemove", str(x), str(y))
        _xdo("click", "--clearmodifiers", "--repeat", str(amt), btn)
        return {"type": "text", "text": f"Scrolled {dirn} ×{amt}"}

    raise ValueError(f"Unknown action type for xdotool backend: {t!r}")


# ── Backend: pyautogui (Windows / fallback) ───────────────────────────────────

def _backend_pyautogui(t: str, action: dict) -> dict:
    import pyautogui  # noqa: PLC0415
    pyautogui.FAILSAFE = False

    # Patch mouse events to use kCGSessionEventTap on macOS
    if _SYSTEM == "Darwin":
        try:
            import pyautogui._pyautogui_osx as _osx
            import Quartz                          # type: ignore[import]
            def _patched(ev, x, y, button):
                event = Quartz.CGEventCreateMouseEvent(None, ev, (x, y), button)
                Quartz.CGEventPost(1, event)       # 1 = kCGSessionEventTap
            _osx._sendMouseEvent = _patched
        except Exception:
            pass

    _PG_KEYS: dict[str, str] = {
        "enter": "enter", "backspace": "backspace", "delete": "delete",
        "escape": "escape", "tab": "tab", "space": "space",
        "up": "up", "down": "down", "left": "left", "right": "right",
        "home": "home", "end": "end", "pageup": "pageup", "pagedown": "pagedown",
        "ctrl": "ctrl", "shift": "shift", "alt": "alt",
        "cmd": "command", "super": "win",
    }
    for _i in range(1, 13):
        _PG_KEYS[f"f{_i}"] = f"f{_i}"

    def _pg_key(n: str) -> str:
        return _PG_KEYS.get(n, n)

    if t == "cursor_position":
        x, y = pyautogui.position()
        return {"type": "text", "text": f"Cursor at {x},{y}", "x": x, "y": y}

    if t == "mouse_move":
        x, y = _coord(t, action, "coordinate")
        pyautogui.moveTo(x, y)
        time.sleep(0.05)
        cx, cy = pyautogui.position()
        ok = abs(cx - x) <= 8 and abs(cy - y) <= 8
        tag = f" [cursor at {cx},{cy}]" if ok else f" [⚠ cursor at {cx},{cy}, expected {x},{y}]"
        return {"type": "text", "text": f"Moved mouse to {x},{y}{tag}"}

    if t == "left_click":
        x, y = _coord(t, action, "coordinate")
        pyautogui.click(x, y)
        return {"type": "text", "text": f"Left-clicked at {x},{y}"}

    if t == "double_click":
        x, y = _coord(t, action, "coordinate")
        pyautogui.doubleClick(x, y)
        return {"type": "text", "text": f"Double-clicked at {x},{y}"}

    if t == "right_click":
        x, y = _coord(t, action, "coordinate")
        pyautogui.click(x, y, button="right")
        return {"type": "text", "text": f"Right-clicked at {x},{y}"}

    if t == "left_click_drag":
        sx, sy = _coord(t, action, "start_coordinate")
        ex, ey = _coord(t, action, "coordinate")
        pyautogui.moveTo(sx, sy)
        pyautogui.dragTo(ex, ey, button="left", duration=0.4)
        return {"type": "text", "text": f"Dragged {sx},{sy} → {ex},{ey}"}

    if t == "type":
        text = action.get("text", "")
        if _SYSTEM == "Darwin":
            subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)
            time.sleep(0.05)
            _quartz_key("cmd+v")  # reliable Cmd+V via Quartz
        else:
            pyautogui.write(text, interval=0.02)
        return {"type": "text", "text": f"Typed: {text!r}"}

    if t == "key":
        raw   = action.get("text", "")
        parts = _norm_combo(raw)
        keys  = [_pg_key(p) for p in parts]
        if len(keys) == 1:
            pyautogui.press(keys[0])
        else:
            pyautogui.hotkey(*keys)
        return {"type": "text", "text": f"Pressed key: {raw}"}

    if t == "scroll":
        x, y  = (action.get("coordinate") or [0, 0])
        x, y  = int(x), int(y)
        dirn  = action["scroll_direction"]
        amt   = int(action["scroll_amount"])
        if x or y:
            pyautogui.moveTo(x, y)
        if dirn == "up":
            pyautogui.scroll(amt)
        elif dirn == "down":
            pyautogui.scroll(-amt)
        elif dirn == "right":
            pyautogui.hscroll(amt)
        elif dirn == "left":
            pyautogui.hscroll(-amt)
        return {"type": "text", "text": f"Scrolled {dirn} ×{amt}"}

    raise ValueError(f"Unknown action type for pyautogui backend: {t!r}")


# ── Shared helpers ─────────────────────────────────────────────────────────────

def _coord(action_type: str, action: dict, key: str) -> tuple[int, int]:
    val = action.get(key)
    if val is None:
        raise ValueError(
            f"Action '{action_type}' requires a '{key}' field, e.g. {{\"coordinate\": [x, y]}}"
        )
    # Convert from native screenshot pixels → logical screen points.
    # When the screenshot is at 2× Retina resolution the AI reads native pixel
    # coords; _to_logical divides by the scale factor so cliclick / xdotool
    # receive the correct logical coordinates.
    return _to_logical(int(val[0]), int(val[1]))


# ── zoom ──────────────────────────────────────────────────────────────────────

def _zoom(action: dict) -> dict:
    """
    Capture and return an enlarged view of a screen region.
    Use when you need to click precisely on a small target:
      1. Take a full screenshot → identify the approximate area.
      2. Call zoom with coordinate=[cx, cy], width, height around that area.
      3. Read exact pixel coordinates from the zoomed image.
      4. Compute screen coords: screen_x = region_x + pixel_x_in_zoom.
      5. Click at those screen coords.

    Fields:
        coordinate : [cx, cy]  – centre of the region (logical px)
        width      : int       – region width  in logical px  (default 400)
        height     : int       – region height in logical px  (default 300)
    """
    cx, cy = _coord("zoom", action, "coordinate")
    rw     = int(action.get("width",  400))
    rh     = int(action.get("height", 300))

    if _SYSTEM == "Darwin":
        lw, lh = _macos_logical_size()
    else:
        lw, lh = 1920, 1080

    x1 = max(0, min(cx - rw // 2, lw - rw))
    y1 = max(0, min(cy - rh // 2, lh - rh))
    x2 = min(lw, x1 + rw)
    y2 = min(lh, y1 + rh)
    aw, ah = x2 - x1, y2 - y1

    path = _capture_path("zoom")

    if _SYSTEM == "Darwin":
        r = subprocess.run(
            ["screencapture", "-C", "-x", "-R", f"{x1},{y1},{aw},{ah}", "-t", "png", path],
            capture_output=True,
        )
        if r.returncode != 0:
            raise RuntimeError(
                f"screencapture zoom failed: {r.stderr.decode(errors='replace').strip()}"
            )
        # Resize Retina output back to logical so pixel coords = screen coords
        subprocess.run(
            ["sips", "--resampleWidth", str(aw), path, "--out", path],
            capture_output=True,
        )
    elif _SYSTEM == "Linux":
        _ensure_display()
        env = {**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":0")}
        if shutil.which("scrot"):
            subprocess.run(
                ["scrot", "-a", f"{x1},{y1},{aw},{ah}", path],
                env=env, capture_output=True, check=True,
            )
        else:
            raise RuntimeError("zoom on Linux requires scrot: sudo apt-get install scrot")
    else:
        raise RuntimeError(f"zoom not implemented for {_SYSTEM}")

    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()

    return {
        "type":     "image",
        "data":     data,
        "path":     path,
        "region_x": x1,
        "region_y": y1,
        "region_w": aw,
        "region_h": ah,
        "note": (
            f"Zoomed region: top-left=({x1},{y1}) size={aw}x{ah}. "
            f"To get screen coords from this image: "
            f"screen_x = {x1} + pixel_x,  screen_y = {y1} + pixel_y."
        ),
    }


# ── Main dispatcher ────────────────────────────────────────────────────────────

def _ocr_screen() -> list[dict]:
    """OCR the screen; return [{text, cx, cy, w, h}] in logical top-left pixels."""
    if _SYSTEM != "Darwin":
        raise RuntimeError("click_text / find_text is currently macOS-only")
    try:
        import Vision                              # type: ignore[import]
        from Cocoa import NSURL                    # type: ignore[import]
        from Quartz import CIImage                 # type: ignore[import]
    except ImportError as exc:
        raise RuntimeError(
            "OCR needs the Vision framework: pip install pyobjc-framework-Vision"
        ) from exc

    lw, lh = _macos_logical_size()
    path = os.path.join(tempfile.gettempdir(), "cua-ocr.png")
    r = subprocess.run(["screencapture", "-x", "-t", "png", path], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("screencapture failed for OCR")

    url = NSURL.fileURLWithPath_(path)
    ci  = CIImage.imageWithContentsOfURL_(url)
    handler = Vision.VNImageRequestHandler.alloc().initWithCIImage_options_(ci, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(1)   # 1 = accurate
    req.setUsesLanguageCorrection_(True)
    handler.performRequests_error_([req], None)

    regions: list[dict] = []
    for obs in (req.results() or []):
        box = obs.boundingBox()   # normalised, bottom-left origin
        ncx = box.origin.x + box.size.width  / 2
        ncy = box.origin.y + box.size.height / 2
        regions.append({
            "text": obs.text(),
            "cx": int(ncx * lw),
            "cy": int((1 - ncy) * lh),   # flip Y -> top-left origin
            "w":  int(box.size.width  * lw),
            "h":  int(box.size.height * lh),
        })
    return regions


def _match_text(target: str, regions: list[dict]) -> list[dict]:
    """Rank OCR regions by match quality against target."""
    import difflib
    t = target.strip().lower()
    scored: list[tuple[float, dict]] = []
    for reg in regions:
        rt = reg["text"].strip().lower()
        if not rt:
            continue
        if rt == t:
            score = 1.0
        elif t in rt or rt in t:
            score = 0.9
        else:
            score = difflib.SequenceMatcher(None, t, rt).ratio()
        scored.append((score, reg))
    scored.sort(key=lambda s: s[0], reverse=True)
    return [dict(reg, score=round(score, 3)) for score, reg in scored]


def _find_text(action: dict) -> dict:
    target = action.get("text", "").strip()
    if not target:
        raise ValueError("`text` is required for find_text")
    matches = _match_text(target, _ocr_screen())[:8]
    if not matches:
        return {"type": "text", "text": f"No text found matching {target!r}"}
    lines = [f"{m['text']!r} at ({m['cx']},{m['cy']})  score={m['score']}" for m in matches]
    return {"type": "text", "text": "Matches:\n" + "\n".join(lines)}


def _click_text(action: dict) -> dict:
    target = action.get("text", "").strip()
    if not target:
        raise ValueError("`text` is required for click_text")
    button = action.get("button", "left")
    matches = _match_text(target, _ocr_screen())
    if not matches or matches[0]["score"] < 0.5:
        found = matches[0]["text"] if matches else "(nothing)"
        raise RuntimeError(
            f"Could not confidently locate {target!r}. Closest: {found!r}. "
            f"Take a screenshot to check the exact label."
        )
    best = matches[0]
    x, y = best["cx"], best["cy"]
    click_map = {"left": "c", "right": "rc", "double": "dc"}
    _cliclick(f"{click_map.get(button, 'c')}:{x},{y}")
    return {"type": "text",
            "text": f"Clicked {best['text']!r} at ({x},{y})  (score {best['score']})"}


def execute(action: dict) -> dict:
    t = action.get("type")

    # ── screenshot: always native (no backend needed) ─────────────────────────
    if t == "screenshot":
        return _screenshot()

    # ── zoom: enlarged region for precise clicking ────────────────────────────
    if t == "zoom":
        return _zoom(action)

    # OCR-based precise clicking by text label
    if t == "click_text":
        return _click_text(action)
    if t == "find_text":
        return _find_text(action)

    # ── wait: pure sleep ──────────────────────────────────────────────────────
    if t == "wait":
        duration = min(float(action.get("duration", 1)), 10)
        time.sleep(duration)
        return {"type": "text", "text": f"Waited {duration}s"}

    # ── shell: run a command ──────────────────────────────────────────────────
    # (handled by executor.ts but keep a local path for direct testing)
    if t == "shell":
        import os as _os
        cmd = action.get("command", "").strip()
        if not cmd:
            raise ValueError("`command` is required for shell actions")
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
        return {"type": "text",
                "text": "\n".join(filter(None, [r.stdout.strip(), r.stderr.strip()])) or "(no output)",
                "exitCode": r.returncode}

    # ── mouse / keyboard: delegate to selected backend ────────────────────────
    _ensure_display()

    if _BACKEND == "cliclick":
        return _backend_cliclick(t, action)
    elif _BACKEND == "xdotool":
        return _backend_xdotool(t, action)
    else:
        return _backend_pyautogui(t, action)


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        payload = base64.b64decode(sys.argv[1])
        action  = json.loads(payload)
        result  = execute(action)
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"type": "error", "error": str(exc)}))
        sys.exit(1)
