"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeCuaAction = executeCuaAction;
// ─── CUA Action Executor (daemon-backed) ──────────────────────────────────────
//
// Finding 1 – No more per-action subprocess!
// All CUA actions are now routed through the persistent CuaDaemon singleton
// (cua_daemon.py) which keeps all Python modules loaded between calls.
//
const daemon_1 = require("./daemon");
const logger_1 = require("./logger");
// ── Executor ──────────────────────────────────────────────────────────────────
async function executeCuaAction(action, sessionId) {
    logger_1.log.info(`CUA → ${JSON.stringify(action).slice(0, 120)}`);
    const result = await daemon_1.cuaDaemon.sendAction(action, sessionId);
    if (result.type === 'error') {
        throw new Error(result.error);
    }
    if (result.type === 'image') {
        const kb = Math.round((result.data.length * 3) / 4 / 1024);
        const file = result.path ?? '(path unknown)';
        logger_1.log.info(`${action.type} → ${file}  (~${kb} KB)`);
    }
    return result;
}
