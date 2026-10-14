import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(root, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');
const MODELS_DIR = path.join(root, 'models');

// ICE servers sent to clients. STUN is enough for most home networks;
// set TURN_URL/TURN_USER/TURN_PASS if a call connects but there is no sound.
const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) {
  iceServers.push({
    urls: process.env.TURN_URL.split(','),
    username: process.env.TURN_USER,
    credential: process.env.TURN_PASS,
  });
}

// ---------- storage ----------
// users: { [name]: { token, contacts: string[] } }
let users = {};
if (existsSync(DB_FILE)) users = JSON.parse(readFileSync(DB_FILE, 'utf8'));
const save = () => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
};

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
const sockets = new Map(); // name -> ws
const wss = new WebSocketServer({ server, path: '/ws' });

const send = (ws, msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
const isOnline = (name) => sockets.has(name);
const contactList = (name) => users[name].contacts.map((c) => ({ name: c, online: isOnline(c) }));

function notifyPresence(name, online) {
  for (const c of users[name].contacts) send(sockets.get(c), { type: 'presence', name, online });
}

function login(ws, name) {
  const prev = sockets.get(name);
  if (prev && prev !== ws) {
    send(prev, { type: 'error', message: 'Вы вошли с другого устройства' });
    prev.user = null;
    prev.close();
  }
  ws.user = name;
  sockets.set(name, ws);
  send(ws, { type: 'welcome', name, token: users[name].token, contacts: contactList(name), iceServers });
  notifyPresence(name, true);
}

const NAME_RE = /^[\p{L}\p{N}_.-]{2,24}$/u;

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = ws.user;

    switch (msg.type) {
      case 'register': {
        const name = String(msg.name || '').trim();
        if (!NAME_RE.test(name)) return send(ws, { type: 'error', message: 'Имя: 2–24 символа, буквы/цифры/_.-' });
        if (users[name]) return send(ws, { type: 'error', message: 'Это имя уже занято' });
        users[name] = { token: randomBytes(24).toString('hex'), contacts: [] };
        save();
        return login(ws, name);
      }
      case 'auth': {
        const name = Object.keys(users).find((n) => users[n].token === msg.token);
        if (!name) return send(ws, { type: 'auth-failed' });
        return login(ws, name);
      }
    }

    if (!me) return;

    switch (msg.type) {
      case 'add-contact': {
        const other = String(msg.name || '').trim();
        if (other === me) return send(ws, { type: 'error', message: 'Нельзя добавить самого себя' });
        if (!users[other]) return send(ws, { type: 'error', message: `Пользователь «${other}» не найден` });
        // Contacts are mutual: adding someone adds you to their list too.
        if (!users[me].contacts.includes(other)) users[me].contacts.push(other);
        if (!users[other].contacts.includes(me)) users[other].contacts.push(me);
        save();
        send(ws, { type: 'contacts', contacts: contactList(me) });
        send(sockets.get(other), { type: 'contacts', contacts: contactList(other) });
        break;
      }
      case 'remove-contact': {
        const other = String(msg.name || '');
        users[me].contacts = users[me].contacts.filter((c) => c !== other);
        if (users[other]) users[other].contacts = users[other].contacts.filter((c) => c !== me);
        save();
        send(ws, { type: 'contacts', contacts: contactList(me) });
        if (users[other]) send(sockets.get(other), { type: 'contacts', contacts: contactList(other) });
        break;
      }
      case 'signal': {
        // Relay WebRTC/call-control messages, but only between contacts.
        if (!users[me].contacts.includes(msg.to)) return;
        const target = sockets.get(msg.to);
        if (!target) {
          if (msg.data?.kind === 'invite') send(ws, { type: 'signal', from: msg.to, data: { kind: 'unavailable' } });
          return;
        }
        send(target, { type: 'signal', from: me, data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    const me = ws.user;
    if (me && sockets.get(me) === ws) {
      sockets.delete(me);
      notifyPresence(me, false);
    }
  });
});

// Drop dead connections so presence stays accurate.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(PORT, () => console.log(`cordis: http://localhost:${PORT}`));
