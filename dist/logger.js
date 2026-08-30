"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = void 0;
// ─── Runner logger (mirrors computer-actions-service/src/logger.ts) ───────────────────
const ts = () => new Date().toISOString();
exports.log = {
    info: (...args) => console.log(`\x1b[32m[INFO ]\x1b[0m ${ts()}`, ...args),
    warn: (...args) => console.warn(`\x1b[33m[WARN ]\x1b[0m ${ts()}`, ...args),
    error: (...args) => console.error(`\x1b[31m[ERROR]\x1b[0m ${ts()}`, ...args),
    debug: (...args) => {
        if (process.env.DEBUG)
            console.log(`\x1b[90m[DEBUG]\x1b[0m ${ts()}`, ...args);
    },
};
