#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const ws_1 = __importDefault(require("ws"));
const config_1 = require("./config");
const logger_1 = require("./logger");
const executor_1 = require("./executor");
const daemon_1 = require("./daemon");
const tracer_1 = require("./tracer");
const sessions = new Map();
function getSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            queue: Promise.resolve(),
            totalActions: 0,
            errors: 0,
            startTime: Date.now(),
        });
        // Also create the tracer so it records the session open timestamp
        (0, tracer_1.getTracer)(sessionId);
    }
    return sessions.get(sessionId);
}
// ── WebSocket state ───────────────────────────────────────────────────────────
let ws;
let reconnectDelay = 2000;
let heartbeatTimer = null;
let pongTimeout = null; // detects half-open TCP
let awaitingPong = false;
function clearTimers() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
    }
    awaitingPong = false;
}
function connect() {
    const url = `${config_1.config.serviceUrl}/runner/ws?apiKey=${config_1.config.apiKey}&runnerId=${config_1.config.runnerId}`;
    logger_1.log.info(`Connecting…  runnerId: ${config_1.config.runnerId}`);
    ws = new ws_1.default(url);
    ws.on('open', () => {
        reconnectDelay = 2000;
        awaitingPong = false;
        logger_1.log.info('✓ Connected');
        // Send an application heartbeat + WS protocol ping every 20 s.
        // The protocol ping detects half-open TCP connections that the runner
        // cannot detect any other way (OS hasn't flushed the socket yet).
        heartbeatTimer = setInterval(() => {
            if (ws.readyState !== ws_1.default.OPEN) {
                clearTimers();
                return;
            }
            // If the last ping never got a pong the connection is dead
            if (awaitingPong) {
                logger_1.log.warn('⚠ Ping timeout — connection is half-open. Forcing reconnect.');
                clearTimers();
                ws.terminate();
                return;
            }
            send({ type: 'heartbeat' }); // application-level (updates DB last_seen)
            ws.ping(); // WS protocol-level (detects dead TCP)
            awaitingPong = true;
            // If no pong within 15 s, force reconnect
            pongTimeout = setTimeout(() => {
                if (awaitingPong) {
                    logger_1.log.warn('⚠ No pong in 15 s — terminating dead connection.');
                    clearTimers();
                    ws.terminate();
                }
            }, 15000);
        }, 20000);
    });
    ws.on('pong', () => {
        awaitingPong = false;
        if (pongTimeout) {
            clearTimeout(pongTimeout);
            pongTimeout = null;
        }
        logger_1.log.debug('pong ✓ (WS-level)');
    });
    ws.on('message', async (raw) => {
        try {
            await handleMessage(JSON.parse(raw.toString()));
        }
        catch (err) {
            logger_1.log.error('Failed to handle service message:', err);
        }
    });
    ws.on('close', (code, reason) => {
        clearTimers();
        logger_1.log.warn(`Disconnected (${code}: ${reason || 'no reason'}). Reconnecting in ${reconnectDelay / 1000}s…`);
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });
    ws.on('error', (err) => logger_1.log.error('WebSocket error:', err.message));
}
// ── Message handler ────────────────────────────────────────────────────────────
async function handleMessage(msg) {
    logger_1.log.debug(`← ${msg.type}`);
    switch (msg.type) {
        // ── Service confirms connection + authentication ─────────────────────────
        case 'connected':
            logger_1.log.info(`Authenticated  workspaceId: ${msg.workspaceId}`);
            send({
                type: 'register',
                name: config_1.config.runnerName,
                labels: config_1.config.labels,
                version: config_1.config.version,
            });
            break;
        // ── Service confirms registration ────────────────────────────────────────
        case 'registered':
            logger_1.log.info(`Registered as "${msg.name}"  id: ${msg.runnerId}`);
            logger_1.log.info('Waiting for session requests…');
            break;
        // ── Heartbeat ack ────────────────────────────────────────────────────────
        case 'pong':
            logger_1.log.debug('pong');
            break;
        // ── A user wants to start a session on this runner ───────────────────────
        case 'session_request': {
            const { sessionId, userEmail } = msg;
            logger_1.log.info(`Session request: ${sessionId}  from: ${userEmail}`);
            // Pre-initialise session state + tracer so timestamps are accurate
            getSession(sessionId);
            send({ type: 'session_accepted', sessionId });
            logger_1.log.info(`Session accepted: ${sessionId}`);
            break;
        }
        // ── Service relays an action from the user ───────────────────────────────
        case 'action': {
            const { actionId, sessionId, payload } = msg;
            const actionType = payload?.type ?? 'unknown';
            logger_1.log.info(`Action queued  id: ${actionId}  session: ${sessionId}  type: ${actionType}`);
            // ── Finding 3: serial queue per session ──────────────────────────────
            const state = getSession(sessionId);
            state.totalActions++;
            const next = state.queue.then(async () => {
                const startMs = Date.now();
                try {
                    const result = await (0, executor_1.executeAction)(payload, sessionId);
                    const durationMs = Date.now() - startMs;
                    // ── Finding 5: trace ─────────────────────────────────────────────
                    (0, tracer_1.getTracer)(sessionId).record({
                        ts: new Date().toISOString(),
                        actionId,
                        sessionId,
                        actionType,
                        durationMs,
                        success: true,
                        resultType: result?.type ?? 'unknown',
                    });
                    send({ type: 'action_result', actionId, sessionId, result, error: null });
                    logger_1.log.info(`Action done  id: ${actionId}  ${durationMs}ms`);
                }
                catch (err) {
                    const durationMs = Date.now() - startMs;
                    const error = err instanceof Error ? err.message : String(err);
                    state.errors++;
                    // ── Finding 5: trace error ───────────────────────────────────────
                    (0, tracer_1.getTracer)(sessionId).record({
                        ts: new Date().toISOString(),
                        actionId,
                        sessionId,
                        actionType,
                        durationMs,
                        success: false,
                        errorMessage: error,
                    });
                    send({ type: 'action_result', actionId, sessionId, result: null, error });
                    logger_1.log.warn(`Action failed  id: ${actionId} — ${error}`);
                }
            }).catch(() => { });
            // Replace session queue with the new tail so next action serialises after this one
            state.queue = next;
            break;
        }
        // ── Service instructs runner to close a session ──────────────────────────
        case 'close_session': {
            const { sessionId } = msg;
            logger_1.log.info(`Session closing: ${sessionId}`);
            // Acknowledge immediately; clean up after the queue drains
            send({ type: 'session_closed', sessionId });
            const state = sessions.get(sessionId);
            if (state) {
                // ── Finding 5: write summary after queue drains ──────────────────
                state.queue.finally(() => {
                    (0, tracer_1.closeTracer)(sessionId, {
                        totalActions: state.totalActions,
                        errors: state.errors,
                        durationMs: Date.now() - state.startTime,
                    });
                    sessions.delete(sessionId);
                    logger_1.log.info(`Session cleanup done: ${sessionId}`);
                });
            }
            break;
        }
        default:
            logger_1.log.warn(`Unknown message type: "${msg.type}"`);
    }
}
// ── Helpers ────────────────────────────────────────────────────────────────────
function send(data) {
    if (ws.readyState === ws_1.default.OPEN) {
        logger_1.log.debug(`→ ${data.type}`);
        ws.send(JSON.stringify(data));
    }
}
// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
    logger_1.log.info(`Received ${signal} — shutting down…`);
    if (ws)
        ws.close(1000, 'runner shutdown');
    await daemon_1.cuaDaemon.shutdown();
    process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// ── Start ──────────────────────────────────────────────────────────────────────
logger_1.log.info(`Runner Agent starting  name: ${config_1.config.runnerName}  labels: [${config_1.config.labels}]`);
connect();
