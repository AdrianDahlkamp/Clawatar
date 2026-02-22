const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const RELAY_URL = process.env.RELAY_GATEWAY_URL || 'wss://clawatar-relay.dongpingchen0612.workers.dev/ws/gateway';
const LOCAL_WS_URL = process.env.LOCAL_WS_URL || 'ws://localhost:8765';
const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const KEEPALIVE_MS = Number(process.env.RELAY_BRIDGE_KEEPALIVE_MS || 25000);
const MAX_BACKOFF_MS = Number(process.env.RELAY_BRIDGE_MAX_BACKOFF_MS || 30000);

function jitter(ms) {
  const delta = Math.floor(ms * 0.2);
  return ms + Math.floor(Math.random() * (delta * 2 + 1)) - delta;
}

function loadJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveConfig() {
  const home = os.homedir();
  const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH || path.join(home, '.openclaw', 'openclaw.json');
  const bridgeConfigPath = process.env.RELAY_BRIDGE_CONFIG || path.join(process.cwd(), 'relay-bridge.config.json');

  const openclawConfig = loadJsonSafe(openclawConfigPath) || {};
  const bridgeConfig = loadJsonSafe(bridgeConfigPath) || {};

  const sessionToken = process.env.RELAY_SESSION_TOKEN
    || bridgeConfig.sessionToken
    || bridgeConfig.token
    || openclawConfig.relay?.sessionToken
    || null;

  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN
    || bridgeConfig.openclawGatewayToken
    || openclawConfig.gateway?.auth?.token
    || null;

  return {
    openclawConfigPath,
    bridgeConfigPath,
    sessionToken,
    gatewayToken,
  };
}

const config = resolveConfig();
if (!config.sessionToken) {
  console.error('[bridge] Missing relay session token. Set RELAY_SESSION_TOKEN or relay-bridge.config.json');
  process.exit(1);
}
if (!config.gatewayToken) {
  console.warn('[bridge] Missing OpenClaw gateway token. Device notifications to Reze will be skipped.');
}

let relayWs = null;
let localWs = null;
let relayBackoffMs = 1000;
let localBackoffMs = 1000;
let relayReconnectTimer = null;
let localReconnectTimer = null;
let keepaliveTimer = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function isOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function parseJson(data) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function shouldForwardRelayToLocal(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const type = typeof msg.type === 'string' ? msg.type : '';
  if (!type) return true;

  if (type.startsWith('relay:')) {
    return false;
  }

  // Explicitly allow user speech/action command families
  if (type === 'user_speech' || type === 'action' || type === 'chat' || type === 'command') {
    return true;
  }

  return true;
}

async function notifyOpenClaw(message) {
  if (!config.gatewayToken) return;

  try {
    const res = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.gatewayToken}`,
        'x-openclaw-agent-id': 'main',
        'x-openclaw-session-key': 'main',
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log('[notify] OpenClaw notification failed:', res.status, text.slice(0, 200));
      return;
    }
    log('[notify] OpenClaw notified');
  } catch (err) {
    log('[notify] OpenClaw notification error:', err?.message || String(err));
  }
}

function handleRelayInternalMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'relay:ping') {
    if (isOpen(relayWs)) {
      relayWs.send(JSON.stringify({ type: 'relay:pong', ts: Date.now() }));
    }
    return;
  }

  if (msg.type === 'relay:device_connected') {
    log(`[relay] device connected: ${msg.deviceName || 'Unknown'} (${msg.deviceType || 'unknown'}) id=${msg.deviceId || 'unknown'}`);
    void notifyOpenClaw(`[System Event] Device connected: ${msg.deviceName || 'Unknown'} (${msg.deviceType || 'unknown'}) via relay. Device ID: ${msg.deviceId || 'unknown'}`);
    return;
  }

  if (msg.type === 'relay:device_disconnected') {
    log(`[relay] device disconnected: ${msg.deviceName || 'Unknown'} (${msg.deviceType || 'unknown'}) id=${msg.deviceId || 'unknown'}`);
    void notifyOpenClaw(`[System Event] Device disconnected: ${msg.deviceName || 'Unknown'} (${msg.deviceType || 'unknown'}) via relay. Device ID: ${msg.deviceId || 'unknown'}`);
    return;
  }

  if (msg.type.startsWith('relay:')) {
    log('[relay] internal:', msg.type);
  }
}

function connectRelay() {
  if (relayReconnectTimer) {
    clearTimeout(relayReconnectTimer);
    relayReconnectTimer = null;
  }

  log('[relay] connecting:', RELAY_URL);
  relayWs = new WebSocket(RELAY_URL, {
    headers: { 'x-session-token': config.sessionToken },
  });

  relayWs.on('open', () => {
    log('[relay] connected as gateway');
    relayBackoffMs = 1000;
  });

  relayWs.on('message', (data) => {
    const msg = parseJson(data);
    if (msg && typeof msg.type === 'string' && msg.type.startsWith('relay:')) {
      handleRelayInternalMessage(msg);
      if (!shouldForwardRelayToLocal(msg)) return;
    }

    if (!isOpen(localWs)) return;
    try {
      localWs.send(typeof data === 'string' ? data : data.toString());
    } catch (err) {
      log('[relay->local] forward failed:', err?.message || String(err));
    }
  });

  relayWs.on('close', (code, reason) => {
    log('[relay] closed:', code, reason?.toString?.() || '');
    scheduleRelayReconnect();
  });

  relayWs.on('error', (err) => {
    log('[relay] error:', err?.message || String(err));
  });
}

function connectLocal() {
  if (localReconnectTimer) {
    clearTimeout(localReconnectTimer);
    localReconnectTimer = null;
  }

  log('[local] connecting:', LOCAL_WS_URL);
  localWs = new WebSocket(LOCAL_WS_URL);

  localWs.on('open', () => {
    log('[local] connected');
    localBackoffMs = 1000;
  });

  localWs.on('message', (data) => {
    if (!isOpen(relayWs)) return;

    const msg = parseJson(data);
    if (msg && typeof msg.type === 'string' && msg.type.startsWith('relay:')) {
      return;
    }

    try {
      relayWs.send(typeof data === 'string' ? data : data.toString());
    } catch (err) {
      log('[local->relay] forward failed:', err?.message || String(err));
    }
  });

  localWs.on('close', (code, reason) => {
    log('[local] closed:', code, reason?.toString?.() || '');
    scheduleLocalReconnect();
  });

  localWs.on('error', (err) => {
    log('[local] error:', err?.message || String(err));
  });
}

function scheduleRelayReconnect() {
  if (relayReconnectTimer) return;
  const delay = jitter(relayBackoffMs);
  log(`[relay] reconnecting in ${delay}ms`);
  relayReconnectTimer = setTimeout(() => {
    relayReconnectTimer = null;
    connectRelay();
  }, delay);
  relayBackoffMs = Math.min(relayBackoffMs * 2, MAX_BACKOFF_MS);
}

function scheduleLocalReconnect() {
  if (localReconnectTimer) return;
  const delay = jitter(localBackoffMs);
  log(`[local] reconnecting in ${delay}ms`);
  localReconnectTimer = setTimeout(() => {
    localReconnectTimer = null;
    connectLocal();
  }, delay);
  localBackoffMs = Math.min(localBackoffMs * 2, MAX_BACKOFF_MS);
}

function startKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = setInterval(() => {
    if (!isOpen(relayWs)) return;
    try {
      relayWs.send(JSON.stringify({ type: 'relay:ping', ts: Date.now() }));
    } catch (err) {
      log('[keepalive] relay ping failed:', err?.message || String(err));
    }
  }, KEEPALIVE_MS);
}

function shutdown() {
  log('[bridge] shutting down');
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  if (relayReconnectTimer) clearTimeout(relayReconnectTimer);
  if (localReconnectTimer) clearTimeout(localReconnectTimer);

  try { relayWs?.close(); } catch {}
  try { localWs?.close(); } catch {}
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('[bridge] starting relay bridge');
log('[bridge] openclaw config:', config.openclawConfigPath);
log('[bridge] bridge config:', config.bridgeConfigPath);
connectRelay();
connectLocal();
startKeepalive();
