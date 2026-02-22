const WebSocket = require('ws');
const token = 'cb36f7fcc32031848067accd51b7767e90299818634cb788f2ecf2ceeeccdb53';
const RELAY_URL = 'wss://clawatar-relay.dongpingchen0612.workers.dev/ws/gateway';
const LOCAL_WS = 'ws://localhost:8765';

let relayWs = null;
let localWs = null;

function connectRelay() {
  console.log('[relay] Connecting to relay gateway...');
  relayWs = new WebSocket(RELAY_URL, { headers: { 'x-session-token': token } });
  
  relayWs.on('open', () => {
    console.log('[relay] Connected as gateway!');
  });
  
  relayWs.on('message', (data) => {
    const msg = data.toString();
    console.log('[relay] recv:', msg.slice(0, 200));
    // Forward client messages to local ws-server
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type && !parsed.type.startsWith('relay:')) {
        if (localWs && localWs.readyState === WebSocket.OPEN) {
          localWs.send(msg);
          console.log('[relay→local] forwarded:', parsed.type);
        }
      }
    } catch {}
  });
  
  relayWs.on('close', (code, reason) => {
    console.log('[relay] Disconnected:', code, reason.toString());
    setTimeout(connectRelay, 3000);
  });
  
  relayWs.on('error', (e) => {
    console.log('[relay] Error:', e.message);
  });
  
  // Respond to relay pings
  relayWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'relay:ping') {
        relayWs.send(JSON.stringify({ type: 'relay:pong', ts: Date.now() }));
      }
    } catch {}
  });
}

function connectLocal() {
  console.log('[local] Connecting to local ws-server...');
  localWs = new WebSocket(LOCAL_WS);
  
  localWs.on('open', () => {
    console.log('[local] Connected!');
  });
  
  localWs.on('message', (data) => {
    const msg = data.toString();
    // Forward local responses to relay (to iOS client)
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type && !parsed.type.startsWith('relay:')) {
        if (relayWs && relayWs.readyState === WebSocket.OPEN) {
          relayWs.send(msg);
          console.log('[local→relay] forwarded:', parsed.type);
        }
      }
    } catch {}
  });
  
  localWs.on('close', () => {
    console.log('[local] Disconnected, reconnecting...');
    setTimeout(connectLocal, 3000);
  });
  
  localWs.on('error', (e) => {
    console.log('[local] Error:', e.message);
  });
}

connectRelay();
connectLocal();

// Keep alive
setInterval(() => {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify({ type: 'relay:pong', ts: Date.now() }));
  }
}, 30000);

console.log('[bridge] Relay ↔ Local bridge started');
