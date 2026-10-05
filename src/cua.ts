// ─── CUA Action Executor (daemon-backed) ──────────────────────────────────────
//
// Finding 1 – No more per-action subprocess!
// All CUA actions are now routed through the persistent CuaDaemon singleton
// (cua_daemon.py) which keeps all Python modules loaded between calls.
//
import { cuaDaemon } from './daemon';
import { log }       from './logger';

// ── Action types (mirror Anthropic computer-use tool spec) ────────────────────

export type CuaAction =
  // ── Core observation ──────────────────────────────────────────────────────
  | { type: 'screenshot' }
  | { type: 'zoom';            coordinate: [number, number]; width?: number; height?: number }
  | { type: 'cursor_position' }

  // ── Timing ────────────────────────────────────────────────────────────────
  | { type: 'wait';            duration: number }

  // ── Standard click / move ─────────────────────────────────────────────────
  | { type: 'left_click';      coordinate: [number, number]; delay?: number }
  | { type: 'double_click';    coordinate: [number, number]; delay?: number }
  | { type: 'right_click';     coordinate: [number, number]; delay?: number }
  | { type: 'mouse_move';      coordinate: [number, number]; delay?: number }

  // ── Finding 4: precision mouse – separate down / up ───────────────────────
  | { type: 'mouse_down';      coordinate: [number, number]; button?: 'left' | 'right' | 'middle'; delay?: number }
  | { type: 'mouse_up';        coordinate: [number, number]; button?: 'left' | 'right' | 'middle'; delay?: number }

  // ── Drag ─────────────────────────────────────────────────────────────────
  | { type: 'left_click_drag'; start_coordinate: [number, number]; coordinate: [number, number]; delay?: number }
  // Finding 4: multi-waypoint drag path
  | { type: 'drag';            path: [number, number][]; button?: 'left' | 'right'; duration?: number; delay?: number }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  | { type: 'type';            text: string; delay?: number }
  | { type: 'key';             text: string; delay?: number }
  // Finding 4: explicit simultaneous multi-key press
  | { type: 'hotkey';          keys: string[]; delay?: number }

  // ── Scroll ────────────────────────────────────────────────────────────────
  | { type: 'scroll';          coordinate?: [number, number]; scroll_direction: 'up' | 'down' | 'left' | 'right'; scroll_amount: number; delay?: number }

  // ── OCR helpers ───────────────────────────────────────────────────────────
  | { type: 'click_text';      text: string; button?: 'left' | 'right' | 'double'; delay?: number }
  | { type: 'find_text';       text: string }

  // ── Finding 4: OS-level window / app management ───────────────────────────
  | { type: 'open';            target: string; delay?: number }
  | { type: 'launch';          app: string; args?: string[]; delay?: number }
  | { type: 'focus_window';    app?: string; title?: string; delay?: number }

  // ── Assertion checkpoint nodes ──────────────────────────────────────────────────
  // Throw AssertionError when condition not met — stops workflow at that step.
  | { type: 'assert_text_visible';     text: string; min_score?: number; message?: string }
  | { type: 'assert_text_not_visible'; text: string; max_score?: number; message?: string }
  | { type: 'assert_result_contains';  expected: string; previous_result?: string; case_sensitive?: boolean; message?: string };

export type CuaResult =
  | { type: 'image'; data: string; path?: string }
  | { type: 'text';  text: string; [k: string]: unknown }
  | { type: 'error'; error: string };

// ── Executor ──────────────────────────────────────────────────────────────────

export async function executeCuaAction(
  action: CuaAction,
  sessionId?: string,
): Promise<CuaResult> {
  log.info(`CUA → ${JSON.stringify(action).slice(0, 120)}`);

  const result = await cuaDaemon.sendAction(action, sessionId) as CuaResult;

  if (result.type === 'error') {
    throw new Error(result.error);
  }

  if (result.type === 'image') {
    const kb   = Math.round((result.data.length * 3) / 4 / 1024);
    const file = result.path ?? '(path unknown)';
    log.info(`${action.type} → ${file}  (~${kb} KB)`);
  }

  return result;
}
