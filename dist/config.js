"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
// ─── Runner configuration ─────────────────────────────────────────────────────
const dotenv_1 = __importDefault(require("dotenv"));
const crypto_1 = require("crypto");
const os_1 = __importDefault(require("os"));
dotenv_1.default.config();
function requireEnv(name, value) {
    if (!value) {
        console.error(`[ERROR] env var ${name} is required`);
        process.exit(1);
    }
    return value;
}
exports.config = {
    /** WebSocket URL of the Computer Actions Service (http → ws, https → wss automatically) */
    serviceUrl: requireEnv('COMPUTER_ACTIONS_SERVICE_URL', process.env.COMPUTER_ACTIONS_SERVICE_URL)
        .replace(/^http/, 'ws'),
    /** Tenant API key – given to the customer by the owner */
    apiKey: requireEnv('COMPUTER_ACTIONS_SERVICE_API_KEY', process.env.COMPUTER_ACTIONS_SERVICE_API_KEY),
    /** Stable identity – persist this across restarts so sessions survive reconnects */
    runnerId: process.env.RUNNER_ID || (0, crypto_1.randomUUID)(),
    runnerName: process.env.RUNNER_NAME || os_1.default.hostname(),
    labels: (process.env.RUNNER_LABELS || '').split(',').filter(Boolean),
    version: '1.0.0',
};
