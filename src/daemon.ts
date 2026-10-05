// ─── CUA Persistent Daemon Manager ────────────────────────────────────────────
//
// Finding 1 – Per-action subprocess → persistent Python daemon
//
// Spawns cua_daemon.py ONCE at runner start and keeps it alive.
// All CUA actions are sent over stdin/stdout as JSON-RPC lines, avoiding the
// 300-600ms cold-start cost of launching a new Python process per action.
//
import { spawn, ChildProcess } from 'child_process';
import { createInterface }     from 'readline';
import { randomUUID }          from 'crypto';
import path                    from 'path';
import { log }                 from './logger';

// ── Types ──────────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve:       (result: unknown) => void;
  reject:        (error: Error)    => void;
  timeoutHandle: NodeJS.Timeout;
}

interface DaemonLine {
  id?:    string;
  ready?: boolean;
  result?: unknown;
  error?:  string | null;
}

// ── CuaDaemon ──────────────────────────────────────────────────────────────────

export class CuaDaemon {
  private proc:         ChildProcess | null = null;
  private pending       = new Map<string, PendingRequest>();
  private isReady       = false;
  private startPromise: Promise<void> | null = null;
  private readonly scriptPath:     string;
  private readonly actionTimeoutMs: number;

  constructor(actionTimeoutMs = 35_000) {
    this.scriptPath      = path.resolve(__dirname, '..', 'scripts', 'cua_daemon.py');
    this.actionTimeoutMs = actionTimeoutMs;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Send a CUA action to the daemon; returns the result JSON. */
  async sendAction(action: unknown, sessionId?: string): Promise<unknown> {
    await this.ensureRunning();

    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();

      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[daemon] action timed out after ${this.actionTimeoutMs / 1000}s`));
      }, this.actionTimeoutMs);

      this.pending.set(id, { resolve, reject, timeoutHandle });

      const line = JSON.stringify({ id, action, session_id: sessionId ?? '' });
      this.proc!.stdin!.write(line + '\n');
    });
  }

  /** Gracefully stop the daemon (drains pending requests first). */
  async shutdown(): Promise<void> {
    if (!this.proc) return;
    this.proc.stdin?.end();
    await new Promise<void>(r => this.proc!.once('close', r));
    this.proc    = null;
    this.isReady = false;
    log.info('[daemon] Shut down');
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async ensureRunning(): Promise<void> {
    if (this.proc && !this.proc.killed && this.isReady) return;
    if (!this.startPromise) {
      this.startPromise = this._boot().finally(() => { this.startPromise = null; });
    }
    return this.startPromise;
  }

  private _boot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      log.info('[daemon] Booting cua_daemon.py …');

      const proc = spawn('python3', [this.scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env:   process.env,
      });
      this.proc    = proc;
      this.isReady = false;

      // ── stdout: JSON-RPC responses ────────────────────────────────────────
      const rl = createInterface({ input: proc.stdout! });
      let startupDone = false;

      rl.on('line', (raw) => {
        let msg: DaemonLine;
        try { msg = JSON.parse(raw) as DaemonLine; }
        catch {
          log.warn('[daemon] Unparseable line:', raw.slice(0, 200));
          return;
        }

        // First message: readiness handshake
        if (!startupDone) {
          startupDone = true;
          if (msg.ready) {
            this.isReady = true;
            log.info('[daemon] Ready ✓');
            resolve();
          } else {
            const err = new Error(`[daemon] Failed to start: ${msg.error ?? 'unknown'}`);
            proc.kill();
            reject(err);
          }
          return;
        }

        // Subsequent messages: match by request ID
        if (!msg.id) return;
        const pending = this.pending.get(msg.id);
        if (!pending) return;

        clearTimeout(pending.timeoutHandle);
        this.pending.delete(msg.id);

        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      });

      // ── stderr: Python warnings / tracebacks (log, don't fail) ───────────
      proc.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) log.warn('[daemon stderr]', text);
      });

      // ── process death: reject all in-flight requests ──────────────────────
      proc.on('error', (err) => {
        log.error('[daemon] Process error:', err.message);
        this.isReady = false;
        this._rejectAll(err);
        if (!startupDone) { startupDone = true; reject(err); }
      });

      proc.on('close', (code) => {
        log.warn(`[daemon] Process exited (code ${code})`);
        this.isReady = false;
        this.proc    = null;
        const err = new Error(`[daemon] Exited with code ${code}`);
        this._rejectAll(err);
        if (!startupDone) { startupDone = true; reject(err); }
      });

      // Startup timeout (15 s)
      setTimeout(() => {
        if (!startupDone) {
          proc.kill();
          reject(new Error('[daemon] Did not become ready within 15 s'));
        }
      }, 15_000);
    });
  }

  private _rejectAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────
// Shared across all action executions in this runner process.

export const cuaDaemon = new CuaDaemon();
