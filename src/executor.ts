// ─── Action Executor ──────────────────────────────────────────────────────────
//
// Receives the action payload relayed by the service and dispatches it.
//
// Enhanced with (findings):
//   Finding 2: run_task   – high-level LLM-driven computer-use agent loop
//   Finding 4: mouse_down/up, drag (path), hotkey, open, launch, focus_window
//
import { exec }          from 'child_process';
import { promisify }     from 'util';
import os                from 'os';
import { executeCuaAction, CuaAction } from './cua';
import { runTask }       from './agent';

const execAsync = promisify(exec);

// ── Action payload types ───────────────────────────────────────────────────────

export type ActionPayload =
  // ── Utility ───────────────────────────────────────────────────────────────
  | { type: 'echo';     message: string }
  | { type: 'info' }
  | { type: 'shell';    command: string }
  // ── Finding 2: high-level autonomous task ─────────────────────────────────
  | { type: 'run_task'; task: string; model?: string; maxSteps?: number; systemPrompt?: string }
  // ── All CUA low-level actions (Finding 4 types included via CuaAction) ────
  | CuaAction;

// ── Executor ──────────────────────────────────────────────────────────────────

export async function executeAction(payload: unknown, sessionId?: string): Promise<unknown> {
  const action = payload as ActionPayload;

  switch (action.type) {

    // ── echo ──────────────────────────────────────────────────────────────────
    case 'echo':
      return { echo: action.message, runner: os.hostname(), ts: new Date().toISOString() };

    // ── info ──────────────────────────────────────────────────────────────────
    case 'info': {
      let permissions: Record<string, unknown> = {};
      if (process.platform === 'darwin') {
        try {
          const { execFileSync } = await import('child_process');
          const out = execFileSync('python3', ['-c',
            'import ctypes; lib=ctypes.cdll.LoadLibrary(' +
            '"/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"); ' +
            'print("accessibility_trusted:", bool(lib.AXIsProcessTrusted()))'
          ], { encoding: 'utf8', timeout: 3000 }).trim();
          permissions = { accessibility_trusted: out.includes('True') };
        } catch { permissions = { accessibility_trusted: 'unknown' }; }
      }
      return {
        hostname:    os.hostname(),
        platform:    process.platform,
        arch:        process.arch,
        cpus:        os.cpus().length,
        totalMem:    os.totalmem(),
        freeMem:     os.freemem(),
        uptime:      os.uptime(),
        pid:         process.pid,
        cua_backend: process.env.CUA_BACKEND ?? 'auto',
        permissions,
        ts:          new Date().toISOString(),
      };
    }

    // ── shell ─────────────────────────────────────────────────────────────────
    // ⚠ CAUTION: In production, restrict allowed commands or run inside a sandbox.
    case 'shell': {
      if (!action.command?.trim()) throw new Error('`command` is required for shell actions');
      try {
        const { stdout, stderr } = await execAsync(action.command, { timeout: 30_000 });
        return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout:   (e.stdout  ?? '').trimEnd(),
          stderr:   (e.stderr  ?? '').trimEnd(),
          exitCode: typeof e.code === 'number' ? e.code : 1,
        };
      }
    }

    // ── Finding 2: run_task – autonomous LLM-driven agent ────────────────────
    case 'run_task': {
      const { task, model, maxSteps, systemPrompt } = action;
      if (!task?.trim()) throw new Error('`task` is required for run_task');
      return runTask(task, sessionId ?? 'default', { model, maxSteps, systemPrompt });
    }

    // ── CUA low-level actions (including Finding 4 new types) ─────────────────
    case 'screenshot':
    case 'zoom':
    case 'cursor_position':
    case 'wait':
    case 'left_click':
    case 'double_click':
    case 'right_click':
    case 'mouse_move':
    case 'mouse_down':        // Finding 4
    case 'mouse_up':          // Finding 4
    case 'left_click_drag':
    case 'drag':              // Finding 4
    case 'type':
    case 'key':
    case 'hotkey':            // Finding 4
    case 'scroll':
    case 'click_text':
    case 'find_text':
    case 'open':              // Finding 4
    case 'launch':            // Finding 4
    case 'focus_window':      // Finding 4
    case 'assert_text_visible':     // Assertion
    case 'assert_text_not_visible': // Assertion
    case 'assert_result_contains':  // Assertion
      return executeCuaAction(action as CuaAction, sessionId);

    default: {
      const t = (action as { type: string }).type;
      throw new Error(`Unknown action type: "${t}"`);
    }
  }
}
