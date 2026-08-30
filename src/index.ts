// ─── Runner Agent – main entry point ─────────────────────────────────────────
//
// 1. Connects to the Computer Actions Service via WebSocket
// 2. Registers itself (name, labels, version)
// 3. Accepts incoming session requests and dispatches actions
// 4. Reconnects automatically on disconnect (exponential back-off)
//
import WebSocket from 'ws';
import { config }         from './config';
import { log }            from './logger';
import { executeAction }  from './executor';

// ── Protocol types ─────────────────────────────────────────────────────────────

interface ServiceMsg {
  type: string;
  [key: string]: unknown;
}

// ── Agent ──────────────────────────────────────────────────────────────────────

let ws:             WebSocket;
let reconnectDelay  = 2_000;   // starts at 2s, doubles up to 30s
let heartbeatTimer: NodeJS.Timeout | null = null;

function connect(): void {
  const url = `${config.serviceUrl}/runner/ws?apiKey=${config.apiKey}&runnerId=${config.runnerId}`;
  log.info(`Connecting to Computer Actions Service…  (runnerId: ${config.runnerId})`);

  ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectDelay = 2_000;    // reset back-off on successful connect
    log.info('✓ Connected');

    // Register this machine with the service
    send({
      type:    'register',
      name:    config.runnerName,
      labels:  config.labels,
      version: config.version,
    });

    // Send a heartbeat every 30 s so the service knows we're alive
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        send({ type: 'heartbeat' });
      } else {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    }, 30_000);
  });

  ws.on('message', async (raw) => {
    try {
      await handleMessage(JSON.parse(raw.toString()) as ServiceMsg);
    } catch (err) {
      log.error('Failed to handle service message:', err);
    }
  });

  ws.on('close', (code, reason) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
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

    // ── Service confirms connection ──────────────────────────────────────────
    case 'connected':
      log.info(`Authenticated  tenant: ${msg.tenantName}  (${msg.tenantId})`);
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

      // In production you could implement an approval policy here.
      // For the POC we auto-accept every request.
      send({ type: 'session_accepted', sessionId });
      log.info(`Session accepted: ${sessionId}`);
      break;
    }

    // ── Service relays an action from the user ───────────────────────────────
    case 'action': {
      const { actionId, sessionId, payload } = msg as {
        type: string; actionId: string; sessionId: string; payload: unknown;
      };
      log.info(`Action  id: ${actionId}  session: ${sessionId}  payload: ${JSON.stringify(payload)}`);

      try {
        const result = await executeAction(payload, sessionId);
        send({ type: 'action_result', actionId, sessionId, result, error: null });
        log.info(`Action done: ${actionId}`);
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        send({ type: 'action_result', actionId, sessionId, result: null, error });
        log.warn(`Action failed: ${actionId} — ${error}`);
      }
      break;
    }

    // ── Service instructs runner to close a session ──────────────────────────
    case 'close_session': {
      const { sessionId } = msg as { type: string; sessionId: string };
      log.info(`Session closed: ${sessionId}`);
      send({ type: 'session_closed', sessionId });
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

// ── Start ──────────────────────────────────────────────────────────────────────

log.info(`Runner Agent starting  name: ${config.runnerName}  labels: [${config.labels}]`);
connect();
