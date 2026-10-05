"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cuaDaemon = exports.CuaDaemon = void 0;
// ─── CUA Persistent Daemon Manager ────────────────────────────────────────────
//
// Finding 1 – Per-action subprocess → persistent Python daemon
//
// Spawns cua_daemon.py ONCE at runner start and keeps it alive.
// All CUA actions are sent over stdin/stdout as JSON-RPC lines, avoiding the
// 300-600ms cold-start cost of launching a new Python process per action.
//
const child_process_1 = require("child_process");
const readline_1 = require("readline");
const crypto_1 = require("crypto");
const path_1 = __importDefault(require("path"));
const logger_1 = require("./logger");
// ── CuaDaemon ──────────────────────────────────────────────────────────────────
class CuaDaemon {
    constructor(actionTimeoutMs = 35000) {
        this.proc = null;
        this.pending = new Map();
        this.isReady = false;
        this.startPromise = null;
        this.scriptPath = path_1.default.resolve(__dirname, '..', 'scripts', 'cua_daemon.py');
        this.actionTimeoutMs = actionTimeoutMs;
    }
    // ── Public API ──────────────────────────────────────────────────────────────
    /** Send a CUA action to the daemon; returns the result JSON. */
    async sendAction(action, sessionId) {
        await this.ensureRunning();
        return new Promise((resolve, reject) => {
            const id = (0, crypto_1.randomUUID)();
            const timeoutHandle = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`[daemon] action timed out after ${this.actionTimeoutMs / 1000}s`));
            }, this.actionTimeoutMs);
            this.pending.set(id, { resolve, reject, timeoutHandle });
            const line = JSON.stringify({ id, action, session_id: sessionId ?? '' });
            this.proc.stdin.write(line + '\n');
        });
    }
    /** Gracefully stop the daemon (drains pending requests first). */
    async shutdown() {
        if (!this.proc)
            return;
        this.proc.stdin?.end();
        await new Promise(r => this.proc.once('close', r));
        this.proc = null;
        this.isReady = false;
        logger_1.log.info('[daemon] Shut down');
    }
    // ── Private ─────────────────────────────────────────────────────────────────
    async ensureRunning() {
        if (this.proc && !this.proc.killed && this.isReady)
            return;
        if (!this.startPromise) {
            this.startPromise = this._boot().finally(() => { this.startPromise = null; });
        }
        return this.startPromise;
    }
    _boot() {
        return new Promise((resolve, reject) => {
            logger_1.log.info('[daemon] Booting cua_daemon.py …');
            const proc = (0, child_process_1.spawn)('python3', [this.scriptPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env,
            });
            this.proc = proc;
            this.isReady = false;
            // ── stdout: JSON-RPC responses ────────────────────────────────────────
            const rl = (0, readline_1.createInterface)({ input: proc.stdout });
            let startupDone = false;
            rl.on('line', (raw) => {
                let msg;
                try {
                    msg = JSON.parse(raw);
                }
                catch {
                    logger_1.log.warn('[daemon] Unparseable line:', raw.slice(0, 200));
                    return;
                }
                // First message: readiness handshake
                if (!startupDone) {
                    startupDone = true;
                    if (msg.ready) {
                        this.isReady = true;
                        logger_1.log.info('[daemon] Ready ✓');
                        resolve();
                    }
                    else {
                        const err = new Error(`[daemon] Failed to start: ${msg.error ?? 'unknown'}`);
                        proc.kill();
                        reject(err);
                    }
                    return;
                }
                // Subsequent messages: match by request ID
                if (!msg.id)
                    return;
                const pending = this.pending.get(msg.id);
                if (!pending)
                    return;
                clearTimeout(pending.timeoutHandle);
                this.pending.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(msg.error));
                }
                else {
                    pending.resolve(msg.result);
                }
            });
            // ── stderr: Python warnings / tracebacks (log, don't fail) ───────────
            proc.stderr.on('data', (chunk) => {
                const text = chunk.toString().trim();
                if (text)
                    logger_1.log.warn('[daemon stderr]', text);
            });
            // ── process death: reject all in-flight requests ──────────────────────
            proc.on('error', (err) => {
                logger_1.log.error('[daemon] Process error:', err.message);
                this.isReady = false;
                this._rejectAll(err);
                if (!startupDone) {
                    startupDone = true;
                    reject(err);
                }
            });
            proc.on('close', (code) => {
                logger_1.log.warn(`[daemon] Process exited (code ${code})`);
                this.isReady = false;
                this.proc = null;
                const err = new Error(`[daemon] Exited with code ${code}`);
                this._rejectAll(err);
                if (!startupDone) {
                    startupDone = true;
                    reject(err);
                }
            });
            // Startup timeout (15 s)
            setTimeout(() => {
                if (!startupDone) {
                    proc.kill();
                    reject(new Error('[daemon] Did not become ready within 15 s'));
                }
            }, 15000);
        });
    }
    _rejectAll(err) {
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timeoutHandle);
            pending.reject(err);
            this.pending.delete(id);
        }
    }
}
exports.CuaDaemon = CuaDaemon;
// ── Singleton ──────────────────────────────────────────────────────────────────
// Shared across all action executions in this runner process.
exports.cuaDaemon = new CuaDaemon();
