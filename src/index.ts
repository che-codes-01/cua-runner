#!/usr/bin/env node
// ─── Runner Agent – main entry point ─────────────────────────────────────────
//
// Enhanced with:
//   Finding 3 – Per-session serial action queue (no race conditions)
//   Finding 5 – NDJSON session trace recorder
//
// Architecture:
//   1. Connects to Computer Actions Service via WebSocket
//   2. Registers itself (name, labels, version)
//   3. Accepts incoming session requests, dispatches actions
//   4. Reconnects automatically (exponential back-off)
//   5. Serializes actions per-session via a promise chain (Finding 3)
//   6. Records every action to $TMPDIR/cua-captures/<session>/trace.ndjson (Finding 5)
//
import WebSocket from 'ws';
import { config }        from './config';
import { log }           from './logger';
import { executeAction } from './executor';
import { cuaDaemon }     from './daemon';
import { getTracer, closeTracer } from './tracer';

// ── Protocol types ─────────────────────────────────────────────────────────────

interface ServiceMsg {
  type: string;
  [key: string]: unknown;
}

// ── Finding 3: Per-session state ──────────────────────────────────────────────

interface SessionState {
  queue:        Promise<void>;   // serial execution chain
  totalActions: number;
  errors:       number;
  startTime:    number;          // epoch ms
}

const sessions = new Map<string, SessionState>();

function getSession(sessionId: string): SessionState {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      queue:        Promise.resolve(),
      totalActions: 0,
      errors:       0,
      startTime:    Date.now(),
    });
    // Also create the tracer so it records the session open timestamp
    getTracer(sessionId);
  }
  return sessions.get(sessionId)!;
}

// ── WebSocket state ───────────────────────────────────────────────────────────

let ws:             WebSocket;
let reconnectDelay  = 2_000;
let heartbeatTimer: NodeJS.Timeout | null = null;
let pongTimeout:    NodeJS.Timeout | null = null;   // detects half-open TCP
let awaitingPong    = false;

function clearTimers(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer);  heartbeatTimer = null; }
  if (pongTimeout)    { clearTimeout(pongTimeout);       pongTimeout    = null; }
  awaitingPong = false;
}

function connect(): void {
  const url = `${config.serviceUrl}/runner/ws?apiKey=${config.apiKey}&runnerId=${config.runnerId}`;
  log.info(`Connecting…  runnerId: ${config.runnerId}`);

  ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectDelay = 2_000;
    awaitingPong   = false;
    log.info('✓ Connected');

    // Send an application heartbeat + WS protocol ping every 20 s.
    // The protocol ping detects half-open TCP connections that the runner
    // cannot detect any other way (OS hasn't flushed the socket yet).
    heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearTimers();
        return;
      }

      // If the last ping never got a pong the connection is dead
      if (awaitingPong) {
        log.warn('⚠ Ping timeout — connection is half-open. Forcing reconnect.');
        clearTimers();
        ws.terminate();
        return;
      }

      send({ type: 'heartbeat' });   // application-level (updates DB last_seen)
      ws.ping();                      // WS protocol-level (detects dead TCP)
      awaitingPong = true;

      // If no pong within 15 s, force reconnect
      pongTimeout = setTimeout(() => {
        if (awaitingPong) {
          log.warn('⚠ No pong in 15 s — terminating dead connection.');
          clearTimers();
          ws.terminate();
        }
      }, 15_000);
    }, 20_000);
  });

  ws.on('pong', () => {
    awaitingPong = false;
    if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
    log.debug('pong ✓ (WS-level)');
  });

  ws.on('message', async (raw) => {
    try {
      await handleMessage(JSON.parse(raw.toString()) as ServiceMsg);
    } catch (err) {
      log.error('Failed to handle service message:', err);
    }
  });

  ws.on('close', (code, reason) => {
    clearTimers();
    log.warn(`Disconnected (${code}: ${reason || 'no reason'}). Reconnecting in ${reconnectDelay / 1000}s…`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });

  ws.on('error', (err) => log.error('WebSocket error:', err.message));
}

// ── Message handler ────────────────────────────────────────────────────────────

async function handleMessage(msg: ServiceMsg): Promise<void> {
  log.debug(`← ${msg.type}`);

  switch (msg.type) {

    // ── Service confirms connection + authentication ─────────────────────────
    case 'connected':
      log.info(`Authenticated  workspaceId: ${msg.workspaceId}`);
      send({
        type:    'register',
        name:    config.runnerName,
        labels:  config.labels,
        version: config.version,
      });
      break;

    // ── Service confirms registration ────────────────────────────────────────
    case 'registered':
      log.info(`Registered as "${msg.name}"  id: ${msg.runnerId}`);
      log.info('Waiting for session requests…');
      break;

    // ── Heartbeat ack ────────────────────────────────────────────────────────
    case 'pong':
      log.debug('pong');
      break;

    // ── A user wants to start a session on this runner ───────────────────────
    case 'session_request': {
      const { sessionId, userEmail } = msg as {
        type: string; sessionId: string; userId: string; userEmail: string;
      };
      log.info(`Session request: ${sessionId}  from: ${userEmail}`);

      // Pre-initialise session state + tracer so timestamps are accurate
      getSession(sessionId);

      send({ type: 'session_accepted', sessionId });
      log.info(`Session accepted: ${sessionId}`);
      break;
    }

    // ── Service relays an action from the user ───────────────────────────────
    case 'action': {
      const { actionId, sessionId, payload } = msg as {
        type: string; actionId: string; sessionId: string; payload: unknown;
      };
      const actionType = (payload as { type?: string })?.type ?? 'unknown';
      log.info(`Action queued  id: ${actionId}  session: ${sessionId}  type: ${actionType}`);

      // ── Finding 3: serial queue per session ──────────────────────────────
      const state = getSession(sessionId);
      state.totalActions++;

      const next = state.queue.then(async () => {
        const startMs = Date.now();

        try {
          const result = await executeAction(payload, sessionId);
          const durationMs = Date.now() - startMs;

          // ── Finding 5: trace ─────────────────────────────────────────────
          getTracer(sessionId).record({
            ts:         new Date().toISOString(),
            actionId,
            sessionId,
            actionType,
            durationMs,
            success:    true,
            resultType: (result as { type?: string })?.type ?? 'unknown',
          });

          send({ type: 'action_result', actionId, sessionId, result, error: null });
          log.info(`Action done  id: ${actionId}  ${durationMs}ms`);

        } catch (err: unknown) {
          const durationMs = Date.now() - startMs;
          const error = err instanceof Error ? err.message : String(err);
          state.errors++;

          // ── Finding 5: trace error ───────────────────────────────────────
          getTracer(sessionId).record({
            ts:           new Date().toISOString(),
            actionId,
            sessionId,
            actionType,
            durationMs,
            success:      false,
            errorMessage: error,
          });

          send({ type: 'action_result', actionId, sessionId, result: null, error });
          log.warn(`Action failed  id: ${actionId} — ${error}`);
        }
      }).catch(() => {/* absorb queue-level rejections */});

      // Replace session queue with the new tail so next action serialises after this one
      state.queue = next;
      break;
    }

    // ── Service instructs runner to close a session ──────────────────────────
    case 'close_session': {
      const { sessionId } = msg as { type: string; sessionId: string };
      log.info(`Session closing: ${sessionId}`);

      // Acknowledge immediately; clean up after the queue drains
      send({ type: 'session_closed', sessionId });

      const state = sessions.get(sessionId);
      if (state) {
        // ── Finding 5: write summary after queue drains ──────────────────
        state.queue.finally(() => {
          closeTracer(sessionId, {
            totalActions: state.totalActions,
            errors:       state.errors,
            durationMs:   Date.now() - state.startTime,
          });
          sessions.delete(sessionId);
          log.info(`Session cleanup done: ${sessionId}`);
        });
      }
      break;
    }

    default:
      log.warn(`Unknown message type: "${msg.type}"`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function send(data: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    log.debug(`→ ${(data as ServiceMsg).type}`);
    ws.send(JSON.stringify(data));
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log.info(`Received ${signal} — shutting down…`);
  if (ws) ws.close(1000, 'runner shutdown');
  await cuaDaemon.shutdown();
  process.exit(0);
}

process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ── Start ──────────────────────────────────────────────────────────────────────

log.info(`Runner Agent starting  name: ${config.runnerName}  labels: [${config.labels}]`);
connect();
