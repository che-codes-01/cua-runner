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
function parseArgs() {
    const args = {};
    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i].startsWith('--')) {
            const key = process.argv[i].slice(2);
            const value = process.argv[i + 1];
            if (value && !value.startsWith('--')) {
                args[key] = value;
                i++;
            }
        }
    }
    return args;
}
const cliArgs = parseArgs();
function requireEnv(name, value) {
    if (!value) {
        console.error(`[ERROR] env var ${name} is required`);
        process.exit(1);
    }
    return value;
}
function optionalEnv(name, value, defaultValue) {
    return value || defaultValue;
}
exports.config = {
    /** WebSocket URL of the Computer Actions Service (http → ws, https → wss automatically) */
    serviceUrl: optionalEnv('COMPUTER_ACTIONS_SERVICE_URL', cliArgs['service-url'] || process.env.COMPUTER_ACTIONS_SERVICE_URL, 'https://cua-service.vercel.app')
        .replace(/\/+$/, '') // strip trailing slashes
        .replace(/^https/, 'wss') // https → wss
        .replace(/^http(?!s)/, 'ws'), // http  → ws  (not https)
    /** Tenant API key – given to the customer by the owner */
    apiKey: requireEnv('COMPUTER_ACTIONS_SERVICE_API_KEY', cliArgs['api-key'] || process.env.COMPUTER_ACTIONS_SERVICE_API_KEY),
    /** Stable identity – persist this across restarts so sessions survive reconnects */
    runnerId: process.env.RUNNER_ID || (0, crypto_1.randomUUID)(),
    runnerName: process.env.RUNNER_NAME || os_1.default.hostname(),
    labels: (process.env.RUNNER_LABELS || '').split(',').filter(Boolean),
    version: '1.0.0',
};
