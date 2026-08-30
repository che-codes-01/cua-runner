"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeAction = executeAction;
// ─── Action Executor ──────────────────────────────────────────────────────────
//
// Receives the action payload sent by the user through the service and executes
// the appropriate work on this machine.
//
const child_process_1 = require("child_process");
const util_1 = require("util");
const os_1 = __importDefault(require("os"));
const cua_1 = require("./cua");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
// ── Executor ──────────────────────────────────────────────────────────────────
async function executeAction(payload, sessionId) {
    const action = payload;
    switch (action.type) {
        // ── echo ──────────────────────────────────────────────────────────────────
        case 'echo':
            return { echo: action.message, runner: os_1.default.hostname(), ts: new Date().toISOString() };
        // ── info ──────────────────────────────────────────────────────────────────
        case 'info': {
            let permissions = {};
            if (process.platform === 'darwin') {
                try {
                    const { execFileSync } = await Promise.resolve().then(() => __importStar(require('child_process')));
                    const out = execFileSync('python3', ['-c',
                        'import ctypes; lib=ctypes.cdll.LoadLibrary(' +
                            '"/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"); ' +
                            'print("accessibility_trusted:", bool(lib.AXIsProcessTrusted()))'
                    ], { encoding: 'utf8', timeout: 3000 }).trim();
                    permissions = { accessibility_trusted: out.includes('True') };
                }
                catch {
                    permissions = { accessibility_trusted: 'unknown' };
                }
            }
            return {
                hostname: os_1.default.hostname(),
                platform: process.platform,
                arch: process.arch,
                cpus: os_1.default.cpus().length,
                totalMem: os_1.default.totalmem(),
                freeMem: os_1.default.freemem(),
                uptime: os_1.default.uptime(),
                pid: process.pid,
                cua_backend: process.env.CUA_BACKEND ?? 'auto',
                permissions,
                ts: new Date().toISOString(),
            };
        }
        // ── shell ─────────────────────────────────────────────────────────────────
        // ⚠ CAUTION: In production, restrict allowed commands or run inside a sandbox.
        case 'shell': {
            if (!action.command?.trim())
                throw new Error('`command` is required for shell actions');
            try {
                const { stdout, stderr } = await execAsync(action.command, { timeout: 30000 });
                return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: 0 };
            }
            catch (err) {
                // execAsync throws when the command exits non-zero.  The actual output
                // lives in err.stdout / err.stderr — return it instead of re-throwing so
                // the MCP client sees the real command output rather than a 502 error.
                const e = err;
                return {
                    stdout: (e.stdout ?? '').trimEnd(),
                    stderr: (e.stderr ?? '').trimEnd(),
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
            return (0, cua_1.executeCuaAction)(action, sessionId);
        default: {
            const t = action.type;
            throw new Error(`Unknown action type: "${t}"`);
        }
    }
}
