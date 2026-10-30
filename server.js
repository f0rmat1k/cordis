import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { startTurn } from './turn.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODELS_DIR = path.join(root, 'models');

// ICE servers sent to clients. STUN is enough for most home networks;
// set TURN_URL/TURN_USER/TURN_PASS if a call connects but there is no sound.
// Two different providers on purpose: some routers send Google traffic out
// through another uplink (e.g. a VPN), so Google's STUN alone reports an
// address peers can't reach; the second one finds the regular address.
const iceServers = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL.split(','),
    username: process.env.TURN_USER,
    credential: process.env.TURN_PASS,
  });
}

// Built-in TURN relay for peers that can't reach each other directly. Needs UDP
// TURN_PORT and TURN_MIN_PORT..TURN_MAX_PORT forwarded to this machine; clients
// reach it by the site's host name unless TURN_HOST says otherwise. TURN=off disables it.
const turn = process.env.TURN === 'off' ? null : startTurn({
  port: Number(process.env.TURN_PORT) || 3478,
  minPort: Number(process.env.TURN_MIN_PORT) || 50000,
  maxPort: Number(process.env.TURN_MAX_PORT) || 50199,
  externalIp: process.env.TURN_EXTERNAL_IP,
  allowPrivatePeers: process.env.TURN_ALLOW_PRIVATE === '1',
});

// ---------- http ----------
const app = express();
app.use(express.static(path.join(root, 'public')));
app.use('/ns', express.static(path.join(root, 'node_modules/@sapphi-red/web-noise-suppressor/dist')));
app.use('/dfn3', express.static(path.join(root, 'node_modules/deepfilternet3-noise-filter/dist')));
app.use('/models/dfn3', express.static(path.join(MODELS_DIR, 'dfn3'), { maxAge: '30d', immutable: true }));
app.get('/models/dfn3/ready', (req, res) => res.json({ ready: dfn3Ready }));

// ---------- DeepFilterNet3 assets ----------
// ~24 MB, too big for git: downloaded once in the background and served
// from our own origin so clients never hit a third-party CDN.
const DFN3_CDN = 'https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3';
const DFN3_FILES = ['v3/pkg/df_bg.wasm', 'v3/models/DeepFilterNet3_onnx.tar.gz'];
let dfn3Ready = false;

async function fetchDfn3() {
  for (const file of DFN3_FILES) {
    const dest = path.join(MODELS_DIR, 'dfn3', file);
    if (existsSync(dest)) continue;
    console.log(`dfn3: downloading ${file}`);
    const res = await fetch(`${DFN3_CDN}/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()));
    renameSync(dest + '.part', dest);
  }
  dfn3Ready = true;
}
fetchDfn3().catch((e) => console.error('dfn3: download failed:', e.message));
const server = createServer(app);

// ---------- signaling ----------
// One shared call: everyone who has the page open is in it. The server only
// keeps the participant list and relays WebRTC messages; audio goes peer-to-peer.
const peers = new Map(); // id -> { ws, name, muted }
const wss = new WebSocketServer({ server, path: '/ws' });

const send = (ws, msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
const info = (id) => ({ id, name: peers.get(id).name, muted: peers.get(id).muted });
function broadcast(msg, except) {
  for (const [id, p] of peers) if (id !== except) send(p.ws, msg);
}
const cleanName = (name) => String(name || '').replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Гость';

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = ws.id;

    switch (msg.type) {
      case 'join': {
        if (me) return;
        const others = [...peers.keys()].map(info);
        const id = randomBytes(6).toString('hex');
        ws.id = id;
        peers.set(id, { ws, name: cleanName(msg.name), muted: !!msg.muted });
        const relay = turn && { host: process.env.TURN_HOST, port: turn.port, ...turn.credentials(id) };
        send(ws, { type: 'welcome', id, iceServers, turn: relay, peers: others });
        broadcast({ type: 'peer-joined', peer: info(id) }, id);
        break;
      }
      case 'update': {
        const p = me && peers.get(me);
        if (!p) return;
        if ('name' in msg) p.name = cleanName(msg.name);
        if ('muted' in msg) p.muted = !!msg.muted;
        broadcast({ type: 'peer-updated', peer: info(me) }, me);
        break;
      }
      case 'signal': {
        if (!me) return;
        send(peers.get(msg.to)?.ws, { type: 'signal', from: me, data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!ws.id) return;
    peers.delete(ws.id);
    broadcast({ type: 'peer-left', id: ws.id });
  });
});

// Drop dead connections so the participant list stays accurate.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(PORT, () => console.log(`cordis: http://localhost:${PORT}`));
