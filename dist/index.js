"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// ─── Runner Agent – main entry point ─────────────────────────────────────────
//
// 1. Connects to the Computer Actions Service via WebSocket
// 2. Registers itself (name, labels, version)
// 3. Accepts incoming session requests and dispatches actions
// 4. Reconnects automatically on disconnect (exponential back-off)
//
const ws_1 = __importDefault(require("ws"));
const config_1 = require("./config");
const logger_1 = require("./logger");
const executor_1 = require("./executor");
// ── Agent ──────────────────────────────────────────────────────────────────────
let ws;
let reconnectDelay = 2000; // starts at 2s, doubles up to 30s
let heartbeatTimer = null;
function connect() {
    const url = `${config_1.config.serviceUrl}/runner/ws?apiKey=${config_1.config.apiKey}&runnerId=${config_1.config.runnerId}`;
    logger_1.log.info(`Connecting to Computer Actions Service…  (runnerId: ${config_1.config.runnerId})`);
    ws = new ws_1.default(url);
    ws.on('open', () => {
        reconnectDelay = 2000; // reset back-off on successful connect
        logger_1.log.info('✓ Connected');
        // register is sent after the service confirms auth via the `connected` message
        // Send a heartbeat every 30 s so the service knows we're alive
        heartbeatTimer = setInterval(() => {
            if (ws.readyState === ws_1.default.OPEN) {
                send({ type: 'heartbeat' });
            }
            else {
                if (heartbeatTimer)
                    clearInterval(heartbeatTimer);
            }
        }, 30000);
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
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
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
            // Now that auth is confirmed, register this machine
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
            // In production you could implement an approval policy here.
            // For the POC we auto-accept every request.
            send({ type: 'session_accepted', sessionId });
            logger_1.log.info(`Session accepted: ${sessionId}`);
            break;
        }
        // ── Service relays an action from the user ───────────────────────────────
        case 'action': {
            const { actionId, sessionId, payload } = msg;
            logger_1.log.info(`Action  id: ${actionId}  session: ${sessionId}  payload: ${JSON.stringify(payload)}`);
            try {
                const result = await (0, executor_1.executeAction)(payload, sessionId);
                send({ type: 'action_result', actionId, sessionId, result, error: null });
                logger_1.log.info(`Action done: ${actionId}`);
            }
            catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                send({ type: 'action_result', actionId, sessionId, result: null, error });
                logger_1.log.warn(`Action failed: ${actionId} — ${error}`);
            }
            break;
        }
        // ── Service instructs runner to close a session ──────────────────────────
        case 'close_session': {
            const { sessionId } = msg;
            logger_1.log.info(`Session closed: ${sessionId}`);
            send({ type: 'session_closed', sessionId });
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
// ── Start ──────────────────────────────────────────────────────────────────────
logger_1.log.info(`Runner Agent starting  name: ${config_1.config.runnerName}  labels: [${config_1.config.labels}]`);
connect();
