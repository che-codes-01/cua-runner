// ─── Runner logger (mirrors computer-actions-service/src/logger.ts) ───────────────────
const ts = () => new Date().toISOString();

export const log = {
  info:  (...args: unknown[]) => console.log( `\x1b[32m[INFO ]\x1b[0m ${ts()}`, ...args),
  warn:  (...args: unknown[]) => console.warn( `\x1b[33m[WARN ]\x1b[0m ${ts()}`, ...args),
  error: (...args: unknown[]) => console.error(`\x1b[31m[ERROR]\x1b[0m ${ts()}`, ...args),
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG) console.log(`\x1b[90m[DEBUG]\x1b[0m ${ts()}`, ...args);
  },
};
