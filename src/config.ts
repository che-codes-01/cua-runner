// ─── Runner configuration ─────────────────────────────────────────────────────
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import os from 'os';

dotenv.config();

function requireEnv(name: string, value: string | undefined): string {
  if (!value) { console.error(`[ERROR] env var ${name} is required`); process.exit(1); }
  return value;
}

export const config = {
  /** WebSocket URL of the Computer Actions Service (http → ws, https → wss automatically) */
  serviceUrl:  requireEnv('COMPUTER_ACTIONS_SERVICE_URL', process.env.COMPUTER_ACTIONS_SERVICE_URL)
                 .replace(/^http/, 'ws'),

  /** Tenant API key – given to the customer by the owner */
  apiKey:      requireEnv('COMPUTER_ACTIONS_SERVICE_API_KEY', process.env.COMPUTER_ACTIONS_SERVICE_API_KEY),

  /** Stable identity – persist this across restarts so sessions survive reconnects */
  runnerId:    process.env.RUNNER_ID   || randomUUID(),

  runnerName:  process.env.RUNNER_NAME || os.hostname(),
  labels:      (process.env.RUNNER_LABELS || '').split(',').filter(Boolean),
  version:     '1.0.0',
};
