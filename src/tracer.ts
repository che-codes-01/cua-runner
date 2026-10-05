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
import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { log } from './logger';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TraceEntry {
  ts:           string;     // ISO timestamp
  actionId:     string;
  sessionId:    string;
  actionType:   string;
  durationMs:   number;
  success:      boolean;
  resultType?:  string;     // 'image' | 'text' | 'task_result' | …
  errorMessage?: string;
}

export interface SessionSummary {
  sessionId:    string;
  openedAt:     string;
  closedAt:     string;
  durationMs:   number;
  totalActions: number;
  errors:       number;
  tracePath:    string;
}

// ── SessionTracer ──────────────────────────────────────────────────────────────

export class SessionTracer {
  private readonly tracePath:   string;
  readonly sessionDir:          string;
  private readonly openedAt:    string;

  constructor(private readonly sessionId: string) {
    this.sessionDir = path.join(os.tmpdir(), 'cua-captures', sessionId);
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.tracePath = path.join(this.sessionDir, 'trace.ndjson');
    this.openedAt  = new Date().toISOString();
    log.info(`[tracer] ${sessionId} → ${this.tracePath}`);
  }

  /** Append one trace entry (non-blocking append). */
  record(entry: TraceEntry): void {
    try {
      fs.appendFileSync(this.tracePath, JSON.stringify(entry) + '\n');
    } catch (err) {
      log.warn('[tracer] Write failed:', err);
    }
  }

  /** Write a summary.json when the session closes. */
  close(stats: { totalActions: number; errors: number; durationMs: number }): void {
    try {
      const summary: SessionSummary = {
        sessionId:    this.sessionId,
        openedAt:     this.openedAt,
        closedAt:     new Date().toISOString(),
        durationMs:   stats.durationMs,
        totalActions: stats.totalActions,
        errors:       stats.errors,
        tracePath:    this.tracePath,
      };
      fs.writeFileSync(
        path.join(this.sessionDir, 'summary.json'),
        JSON.stringify(summary, null, 2),
      );
      log.info(
        `[tracer] ${this.sessionId} closed — ` +
        `${stats.totalActions} actions, ${stats.errors} errors, ` +
        `${(stats.durationMs / 1000).toFixed(1)}s`,
      );
    } catch { /* best-effort */ }
  }
}

// ── Registry ───────────────────────────────────────────────────────────────────

const registry = new Map<string, SessionTracer>();

export function getTracer(sessionId: string): SessionTracer {
  if (!registry.has(sessionId)) {
    registry.set(sessionId, new SessionTracer(sessionId));
  }
  return registry.get(sessionId)!;
}

export function closeTracer(
  sessionId: string,
  stats: { totalActions: number; errors: number; durationMs: number },
): void {
  const tracer = registry.get(sessionId);
  if (tracer) {
    tracer.close(stats);
    registry.delete(sessionId);
  }
}
