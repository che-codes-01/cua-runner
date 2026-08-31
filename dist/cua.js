"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeCuaAction = executeCuaAction;
// ─── CUA (Computer Use Agent) tool executor ──────────────────────────────────
//
// Delegates every CUA action to runner/scripts/cua.py via a child process.
// The Python helper handles the platform differences (macOS vs Linux).
//
// Action shapes mirror the Anthropic computer-use tool spec so the same
// payload that comes from Claude can be relayed directly to the runner.
//
const child_process_1 = require("child_process");
const util_1 = require("util");
const path_1 = __importDefault(require("path"));
const logger_1 = require("./logger");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
// Resolve the helper script relative to this source file so it works in both
// `tsx watch` (src/) and compiled (dist/) modes.
const CUA_SCRIPT = path_1.default.resolve(__dirname, '..', 'scripts', 'cua.py');
// ── Executor ──────────────────────────────────────────────────────────────────
async function executeCuaAction(action, sessionId) {
    // Log the outgoing action so the runner console shows what is being dispatched
    logger_1.log.info(`Action → ${JSON.stringify(action)}`);
    // Pass the payload as base64 to avoid any shell-quoting issues
    const b64 = Buffer.from(JSON.stringify(action)).toString('base64');
    // CUA_SESSION_ID lets cua.py place captures in a per-session subfolder
    const env = { ...process.env, ...(sessionId ? { CUA_SESSION_ID: sessionId } : {}) };
    let stdout;
    let stderr;
    try {
        ({ stdout, stderr } = await execFileAsync('python3', [CUA_SCRIPT, b64], {
            timeout: 35000,
            maxBuffer: 20 * 1024 * 1024, // 20 MB — screenshots can be several MB as base64
            env,
        }));
    }
    catch (raw) {
        // execFileAsync rejects on non-zero exit.  cua.py always writes
        // {"type":"error","error":"..."} to **stdout** before calling sys.exit(1),
        // but Node puts that in err.stdout — NOT in err.message.  Unwrap it so the
        // caller (and the runner log) sees the real Python error instead of the
        // generic "Command failed: python3 ..." string.
        const e = raw;
        // Surface any Python warnings that arrived on stderr
        if (e.stderr?.trim()) {
            process.stderr.write(`[cua.py stderr] ${e.stderr}`);
        }
        // Try to extract the structured error from stdout
        let detail = e.message;
        if (e.stdout?.trim()) {
            try {
                const parsed = JSON.parse(e.stdout.trim());
                if (parsed.type === 'error')
                    detail = parsed.error;
            }
            catch {
                // stdout wasn't JSON — append it raw for extra context
                detail = `${e.message}\n${e.stdout.trim()}`;
            }
        }
        throw new Error(detail);
    }
    if (stderr.trim()) {
        // Python warnings (e.g. pyautogui deprecation notices) go to stderr — log but don't fail
        process.stderr.write(`[cua.py stderr] ${stderr}`);
    }
    const result = JSON.parse(stdout.trim());
    if (result.type === 'error') {
        throw new Error(result.error);
    }
    // For image results log the on-disk path so the operator can open it
    if (result.type === 'image') {
        const file = result.path ?? '(path unknown)';
        const kb = Math.round((result.data.length * 3) / 4 / 1024);
        logger_1.log.info(`${action.type} saved → ${file}  (~${kb} KB)`);
    }
    return result;
}
