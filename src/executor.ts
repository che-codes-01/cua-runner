// ─── Action Executor ──────────────────────────────────────────────────────────
//
// Receives the action payload sent by the user through the service and executes
// the appropriate work on this machine.
//
import { exec }          from 'child_process';
import { promisify }     from 'util';
import os                from 'os';
import { executeCuaAction, CuaAction } from './cua';

const execAsync = promisify(exec);

// ── Action payload types ───────────────────────────────────────────────────────

export type ActionPayload =
  // ── Utility actions ───────────────────────────────────────────────────────
  | { type: 'echo';  message: string }
  | { type: 'info' }
  | { type: 'shell'; command: string }
  // ── CUA (Computer Use Agent) actions ──────────────────────────────────────
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
        // execAsync throws when the command exits non-zero.  The actual output
        // lives in err.stdout / err.stderr — return it instead of re-throwing so
        // the MCP client sees the real command output rather than a 502 error.
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout:   (e.stdout  ?? '').trimEnd(),
          stderr:   (e.stderr  ?? '').trimEnd(),
          exitCode: typeof e.code === 'number' ? e.code : 1,
        };
      }
    }

    // ── CUA tools ─────────────────────────────────────────────────────────────
    case 'screenshot':
    case 'zoom':
    case 'cursor_position':
    case 'wait':
    case 'left_click':
    case 'double_click':
    case 'right_click':
    case 'mouse_move':
    case 'left_click_drag':
    case 'type':
    case 'key':
    case 'scroll':
    case 'click_text':
    case 'find_text':
      return executeCuaAction(action as CuaAction, sessionId);

    default: {
      const t = (action as { type: string }).type;
      throw new Error(`Unknown action type: "${t}"`);
    }
  }
}
