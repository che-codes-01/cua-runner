// ─── Runner configuration ─────────────────────────────────────────────────────
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import os from 'os';

dotenv.config();

function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
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

function requireEnv(name: string, value: string | undefined): string {
  if (!value) { console.error(`[ERROR] env var ${name} is required`); process.exit(1); }
  return value;
}

function optionalEnv(name: string, value: string | undefined, defaultValue: string): string {
  return value || defaultValue;
}

export const config = {
  /** WebSocket URL of the Computer Actions Service (http → ws, https → wss automatically) */
  serviceUrl:  optionalEnv('COMPUTER_ACTIONS_SERVICE_URL', cliArgs['service-url'] || process.env.COMPUTER_ACTIONS_SERVICE_URL, 'https://cua-service.vercel.app')
                 .replace(/\/+$/, '')                 // strip trailing slashes
                 .replace(/^https/, 'wss')            // https → wss
                 .replace(/^http(?!s)/, 'ws'),        // http  → ws  (not https)

  /** Tenant API key – given to the customer by the owner */
  apiKey:      requireEnv('COMPUTER_ACTIONS_SERVICE_API_KEY', cliArgs['api-key'] || process.env.COMPUTER_ACTIONS_SERVICE_API_KEY),

  /** Stable identity – persist this across restarts so sessions survive reconnects */
  runnerId:    process.env.RUNNER_ID   || randomUUID(),

  runnerName:  process.env.RUNNER_NAME || os.hostname(),
  labels:      (process.env.RUNNER_LABELS || '').split(',').filter(Boolean),
  version:     '1.0.0',
};
