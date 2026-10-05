"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionTracer = void 0;
exports.getTracer = getTracer;
exports.closeTracer = closeTracer;
// ─── Session Trace Recorder ────────────────────────────────────────────────────
//
// Finding 5 – Playwright-inspired session tracing.
//
// Each session gets an NDJSON trace file at:
//   $TMPDIR/cua-captures/<sessionId>/trace.ndjson
//
// Every action is recorded with timing, success/failure, and result type.
// When a session closes, a human-readable summary.json is written alongside.
//
// The trace directory is the same folder where cua.py writes screenshots,
// so you get a single per-session artefact directory with everything co-located.
//
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const logger_1 = require("./logger");
// ── SessionTracer ──────────────────────────────────────────────────────────────
class SessionTracer {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.sessionDir = path_1.default.join(os_1.default.tmpdir(), 'cua-captures', sessionId);
        fs_1.default.mkdirSync(this.sessionDir, { recursive: true });
        this.tracePath = path_1.default.join(this.sessionDir, 'trace.ndjson');
        this.openedAt = new Date().toISOString();
        logger_1.log.info(`[tracer] ${sessionId} → ${this.tracePath}`);
    }
    /** Append one trace entry (non-blocking append). */
    record(entry) {
        try {
            fs_1.default.appendFileSync(this.tracePath, JSON.stringify(entry) + '\n');
        }
        catch (err) {
            logger_1.log.warn('[tracer] Write failed:', err);
        }
    }
    /** Write a summary.json when the session closes. */
    close(stats) {
        try {
            const summary = {
                sessionId: this.sessionId,
                openedAt: this.openedAt,
                closedAt: new Date().toISOString(),
                durationMs: stats.durationMs,
                totalActions: stats.totalActions,
                errors: stats.errors,
                tracePath: this.tracePath,
            };
            fs_1.default.writeFileSync(path_1.default.join(this.sessionDir, 'summary.json'), JSON.stringify(summary, null, 2));
            logger_1.log.info(`[tracer] ${this.sessionId} closed — ` +
                `${stats.totalActions} actions, ${stats.errors} errors, ` +
                `${(stats.durationMs / 1000).toFixed(1)}s`);
        }
        catch { /* best-effort */ }
    }
}
exports.SessionTracer = SessionTracer;
// ── Registry ───────────────────────────────────────────────────────────────────
const registry = new Map();
function getTracer(sessionId) {
    if (!registry.has(sessionId)) {
        registry.set(sessionId, new SessionTracer(sessionId));
    }
    return registry.get(sessionId);
}
function closeTracer(sessionId, stats) {
    const tracer = registry.get(sessionId);
    if (tracer) {
        tracer.close(stats);
        registry.delete(sessionId);
    }
}
