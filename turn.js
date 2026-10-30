// Minimal TURN server (RFC 8656 subset) so calls work when peers can't reach
// each other directly. UDP only. Logins use the "TURN REST API" scheme:
// username = "<expiry>:<id>", password = HMAC(secret, username), so the
// signaling server hands them out and nothing has to be stored.
import dgram from 'node:dgram';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MAGIC = 0x2112a442;
const METHOD = { binding: 0x001, allocate: 0x003, refresh: 0x004, send: 0x006, data: 0x007, createPermission: 0x008, channelBind: 0x009 };
const CLASS = { request: 0, indication: 1, success: 2, error: 3 };
const ATTR = {
  username: 0x0006, integrity: 0x0008, errorCode: 0x0009, channelNumber: 0x000c, lifetime: 0x000d,
  peer: 0x0012, data: 0x0013, realm: 0x0014, nonce: 0x0015, relayed: 0x0016, transport: 0x0019,
  mapped: 0x0020, reservationToken: 0x0022,
};

const DEFAULT_LIFETIME = 600; // seconds
const MAX_LIFETIME = 3600;
const PERMISSION_LIFETIME = 300;
const CHANNEL_LIFETIME = 600;
const NONCE_LIFETIME = 3600;
const CREDENTIAL_TTL = 24 * 3600;
const MAX_ALLOCATIONS_PER_USER = 30;

// ---------- STUN message encoding ----------
const msgType = (method, cls) =>
  (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);

function parse(buf) {
  if (buf.length < 20 || buf[0] & 0xc0 || buf.readUInt32BE(4) !== MAGIC) return null;
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  if (20 + len > buf.length || len % 4) return null;
  const msg = {
    method: (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2),
    cls: ((type & 0x0010) >> 4) | ((type & 0x0100) >> 7),
    tid: buf.subarray(8, 20),
    attrs: new Map(),
    peers: [], // CreatePermission may carry several XOR-PEER-ADDRESS
    integrityAt: -1,
    raw: buf,
  };
  for (let i = 20; i + 4 <= 20 + len;) {
    const t = buf.readUInt16BE(i);
    const l = buf.readUInt16BE(i + 2);
    if (i + 4 + l > 20 + len) return null;
    // Everything after MESSAGE-INTEGRITY (except FINGERPRINT) must be ignored.
    if (msg.integrityAt < 0) {
      const v = buf.subarray(i + 4, i + 4 + l);
      if (t === ATTR.peer) msg.peers.push(v);
      if (!msg.attrs.has(t)) msg.attrs.set(t, v);
      if (t === ATTR.integrity) msg.integrityAt = i;
    }
    i += 4 + l + ((4 - (l % 4)) % 4);
  }
  return msg;
}

function encode(method, cls, tid, attrs, key) {
  const parts = [];
  for (const [t, v] of attrs) {
    const h = Buffer.alloc(4);
    h.writeUInt16BE(t, 0);
    h.writeUInt16BE(v.length, 2);
    parts.push(h, v, Buffer.alloc((4 - (v.length % 4)) % 4));
  }
  let body = Buffer.concat(parts);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(msgType(method, cls), 0);
  header.writeUInt32BE(MAGIC, 4);
  tid.copy(header, 8);
  if (key) {
    // The HMAC covers the header with a length that already includes MESSAGE-INTEGRITY.
    header.writeUInt16BE(body.length + 24, 2);
    const mac = createHmac('sha1', key).update(header).update(body).digest();
    const h = Buffer.alloc(4);
    h.writeUInt16BE(ATTR.integrity, 0);
    h.writeUInt16BE(20, 2);
    body = Buffer.concat([body, h, mac]);
  }
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function integrityOk(msg, key) {
  const { raw, integrityAt } = msg;
  const signed = Buffer.from(raw.subarray(0, integrityAt));
  signed.writeUInt16BE(integrityAt - 20 + 24, 2);
  const mac = createHmac('sha1', key).update(signed).digest();
  const got = raw.subarray(integrityAt + 4, integrityAt + 24);
  return got.length === 20 && timingSafeEqual(mac, got);
}

// IPv4 only: the relay sockets are udp4.
function xorAddr(ip, port) {
  const v = Buffer.alloc(8);
  v[1] = 0x01;
  v.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const n = ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
  v.writeUInt32BE((n ^ MAGIC) >>> 0, 4);
  return v;
}

function readXorAddr(v) {
  if (!v || v.length < 8 || v[1] !== 0x01) return null;
  const n = (v.readUInt32BE(4) ^ MAGIC) >>> 0;
  return { ip: [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.'), port: v.readUInt16BE(2) ^ (MAGIC >>> 16) };
}

function u32(n) {
  const v = Buffer.alloc(4);
  v.writeUInt32BE(n, 0);
  return v;
}

function errorAttr(code, reason) {
  const r = Buffer.from(reason);
  const v = Buffer.alloc(4 + r.length);
  v[2] = Math.floor(code / 100);
  v[3] = code % 100;
  r.copy(v, 4);
  return [ATTR.errorCode, v];
}

// The relay sits in a home network: never let it reach LAN or loopback addresses.
function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128);
}

// Public address of this machine as the internet sees it (for XOR-RELAYED-ADDRESS).
export function detectPublicIp(server = 'stun.cloudflare.com', port = 3478) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const tid = randomBytes(12);
    const timer = setTimeout(() => { s.close(); reject(new Error('STUN timeout')); }, 3000);
    s.on('message', (buf) => {
      const msg = parse(buf);
      if (!msg || !msg.tid.equals(tid)) return;
      clearTimeout(timer);
      s.close();
      const addr = readXorAddr(msg.attrs.get(ATTR.mapped));
      addr ? resolve(addr.ip) : reject(new Error('no XOR-MAPPED-ADDRESS'));
    });
    s.on('error', (e) => { clearTimeout(timer); s.close(); reject(e); });
    s.send(encode(METHOD.binding, CLASS.request, tid, []), port, server);
  });
}

// ---------- server ----------
export function startTurn({ port = 3478, minPort = 50000, maxPort = 50199, externalIp, allowPrivatePeers = false, realm = 'cordis', log = console.log }) {
  const secret = randomBytes(32);
  const allocations = new Map(); // client "ip:port" -> allocation
  const pending = new Set(); // clients whose Allocate is still binding a relay port
  const freePorts = [];
  for (let p = minPort; p <= maxPort; p++) freePorts.push(p);
  let publicIp = externalIp;

  // Home IPs change: re-detect regularly unless it was given explicitly.
  if (!externalIp) {
    const detect = () => detectPublicIp().then((ip) => {
      if (ip !== publicIp) log(`turn: public IP ${ip}`);
      publicIp = ip;
    }).catch((e) => log(`turn: can't detect public IP: ${e.message}`));
    detect();
    setInterval(detect, 10 * 60 * 1000).unref();
  }

  const passwordFor = (username) => createHmac('sha1', secret).update(username).digest('base64');
  const nonceSig = (ts) => createHmac('sha1', secret).update('nonce' + ts).digest('hex').slice(0, 16);
  const newNonce = () => {
    const ts = Math.floor(Date.now() / 1000).toString(16);
    return `${ts}-${nonceSig(ts)}`;
  };
  const nonceOk = (nonce) => {
    const [ts, sig] = (nonce || '').split('-');
    return sig === nonceSig(ts) && Date.now() / 1000 - parseInt(ts, 16) < NONCE_LIFETIME;
  };

  const sock = dgram.createSocket('udp4');
  sock.on('error', (e) => log(`turn: ${e.message}`));
  sock.on('message', (buf, rinfo) => {
    try { onPacket(buf, rinfo); } catch (e) { log(`turn: ${e.stack || e}`); }
  });
  sock.bind(port, () => log(`turn: listening on udp ${port}, relay ports ${minPort}-${maxPort}`));

  function free(a) {
    allocations.delete(a.key5);
    a.relay.close();
    freePorts.push(a.relayPort);
  }

  setInterval(() => {
    const now = Date.now();
    for (const a of allocations.values()) {
      if (a.expires < now) { free(a); continue; }
      for (const [ip, exp] of a.perms) if (exp < now) a.perms.delete(ip);
      for (const [num, ch] of a.channels) {
        if (ch.expires < now) {
          a.channels.delete(num);
          a.peerChannels.delete(`${ch.ip}:${ch.port}`);
        }
      }
    }
  }, 10000).unref();

  function bindRelay(tries = 5) {
    return new Promise((resolve, reject) => {
      const p = freePorts.shift();
      if (p === undefined) return reject(new Error('no free relay ports'));
      const s = dgram.createSocket('udp4');
      s.once('error', () => {
        // Port taken by something else: put it back at the end and try another.
        s.close();
        freePorts.push(p);
        if (tries > 1) bindRelay(tries - 1).then(resolve, reject);
        else reject(new Error('relay bind failed'));
      });
      s.bind(p, () => {
        s.removeAllListeners('error');
        s.on('error', (e) => log(`turn: relay ${p}: ${e.message}`));
        resolve({ relay: s, relayPort: p });
      });
    });
  }

  function lifetimeOf(msg) {
    const v = msg.attrs.get(ATTR.lifetime);
    if (!v || v.length < 4) return DEFAULT_LIFETIME;
    const requested = v.readUInt32BE(0);
    return requested === 0 ? 0 : Math.min(Math.max(requested, DEFAULT_LIFETIME), MAX_LIFETIME);
  }

  // Long-term credential check. Returns { username, key } or answers with 401/438 itself.
  function authenticate(msg, reply) {
    const challenge = (code, reason) => reply(CLASS.error, [
      errorAttr(code, reason),
      [ATTR.realm, Buffer.from(realm)],
      [ATTR.nonce, Buffer.from(newNonce())],
    ]);
    const username = msg.attrs.get(ATTR.username)?.toString();
    if (msg.integrityAt < 0 || !username) return challenge(401, 'Unauthorized');
    if (!nonceOk(msg.attrs.get(ATTR.nonce)?.toString())) return challenge(438, 'Stale Nonce');
    if (!(Number(username.split(':')[0]) > Date.now() / 1000)) return challenge(401, 'Unauthorized');
    const key = createHash('md5').update(`${username}:${realm}:${passwordFor(username)}`).digest();
    if (!integrityOk(msg, key)) return challenge(401, 'Unauthorized');
    return { username, key };
  }

  function onPacket(buf, rinfo) {
    const key5 = `${rinfo.address}:${rinfo.port}`;

    // ChannelData: the compact framing for media once a channel is bound.
    if (buf.length >= 4 && (buf[0] & 0xc0) === 0x40) {
      const a = allocations.get(key5);
      const ch = a?.channels.get(buf.readUInt16BE(0));
      const len = buf.readUInt16BE(2);
      if (ch && 4 + len <= buf.length) a.relay.send(buf.subarray(4, 4 + len), ch.port, ch.ip);
      return;
    }

    const msg = parse(buf);
    if (!msg) return;
    const reply = (cls, attrs, key) => sock.send(encode(msg.method, cls, msg.tid, attrs, key), rinfo.port, rinfo.address);

    if (msg.method === METHOD.binding && msg.cls === CLASS.request) {
      return reply(CLASS.success, [[ATTR.mapped, xorAddr(rinfo.address, rinfo.port)]]);
    }

    const a = allocations.get(key5);
    if (msg.cls === CLASS.indication) {
      if (msg.method !== METHOD.send || !a) return;
      const peer = readXorAddr(msg.attrs.get(ATTR.peer));
      const data = msg.attrs.get(ATTR.data);
      if (peer && data && a.perms.get(peer.ip) > Date.now()) a.relay.send(data, peer.port, peer.ip);
      return;
    }
    if (msg.cls !== CLASS.request || pending.has(key5)) return;

    const auth = authenticate(msg, reply);
    if (!auth) return;
    const ok = (attrs = []) => reply(CLASS.success, attrs, auth.key);
    const fail = (code, reason) => reply(CLASS.error, [errorAttr(code, reason)], auth.key);
    const checkPeer = (peer) => {
      if (!peer) fail(443, 'Peer Address Family Mismatch');
      else if (isPrivate(peer.ip) && !allowPrivatePeers) fail(403, 'Forbidden');
      else return true;
      return false;
    };

    if (msg.method === METHOD.allocate) return allocate(msg, rinfo, key5, a, auth, ok, fail);
    if (!a) return fail(437, 'Allocation Mismatch');
    if (a.username !== auth.username) return fail(441, 'Wrong Credentials');

    switch (msg.method) {
      case METHOD.refresh: {
        const lifetime = lifetimeOf(msg);
        if (lifetime === 0) free(a);
        else a.expires = Date.now() + lifetime * 1000;
        return ok([[ATTR.lifetime, u32(lifetime)]]);
      }
      case METHOD.createPermission: {
        const peers = msg.peers.map(readXorAddr);
        if (!peers.length) return fail(400, 'Bad Request');
        if (!peers.every(checkPeer)) return;
        for (const p of peers) a.perms.set(p.ip, Date.now() + PERMISSION_LIFETIME * 1000);
        return ok();
      }
      case METHOD.channelBind: {
        const num = msg.attrs.get(ATTR.channelNumber)?.readUInt16BE(0);
        const peer = readXorAddr(msg.attrs.get(ATTR.peer));
        if (!(num >= 0x4000 && num <= 0x7fff)) return fail(400, 'Bad Request');
        if (!checkPeer(peer)) return;
        const peerKey = `${peer.ip}:${peer.port}`;
        const bound = a.channels.get(num);
        const boundNum = a.peerChannels.get(peerKey);
        if ((bound && `${bound.ip}:${bound.port}` !== peerKey) || (boundNum !== undefined && boundNum !== num)) {
          return fail(400, 'Bad Request');
        }
        a.channels.set(num, { ...peer, expires: Date.now() + CHANNEL_LIFETIME * 1000 });
        a.peerChannels.set(peerKey, num);
        a.perms.set(peer.ip, Date.now() + PERMISSION_LIFETIME * 1000);
        return ok();
      }
      default:
        return fail(400, 'Bad Request');
    }
  }

  function allocate(msg, rinfo, key5, existing, auth, ok, fail) {
    const allocAttrs = (a) => [
      [ATTR.relayed, xorAddr(a.relayIp, a.relayPort)],
      [ATTR.lifetime, u32(Math.max(0, Math.round((a.expires - Date.now()) / 1000)))],
      [ATTR.mapped, xorAddr(rinfo.address, rinfo.port)],
    ];
    if (existing) {
      // A retransmitted Allocate gets the same answer; anything else is a mismatch.
      return existing.tid.equals(msg.tid) ? ok(allocAttrs(existing)) : fail(437, 'Allocation Mismatch');
    }
    const transport = msg.attrs.get(ATTR.transport);
    if (!transport) return fail(400, 'Bad Request');
    if (transport[0] !== 17) return fail(442, 'Unsupported Transport Protocol');
    if (msg.attrs.has(ATTR.reservationToken)) return fail(508, 'Insufficient Capacity');
    if (!publicIp) return fail(508, 'Insufficient Capacity');
    let mine = 0;
    for (const x of allocations.values()) if (x.username === auth.username) mine++;
    if (mine >= MAX_ALLOCATIONS_PER_USER) return fail(486, 'Allocation Quota Reached');

    pending.add(key5);
    bindRelay().then(({ relay, relayPort }) => {
      pending.delete(key5);
      const a = {
        key5, relay, relayPort, relayIp: publicIp, username: auth.username, tid: Buffer.from(msg.tid),
        client: { ip: rinfo.address, port: rinfo.port },
        expires: Date.now() + (lifetimeOf(msg) || DEFAULT_LIFETIME) * 1000,
        perms: new Map(), // peer ip -> expiry
        channels: new Map(), // channel number -> { ip, port, expires }
        peerChannels: new Map(), // "ip:port" -> channel number
      };
      allocations.set(key5, a);
      relay.on('message', (data, from) => {
        if (!(a.perms.get(from.address) > Date.now())) return;
        const num = a.peerChannels.get(`${from.address}:${from.port}`);
        if (num !== undefined) {
          const head = Buffer.alloc(4);
          head.writeUInt16BE(num, 0);
          head.writeUInt16BE(data.length, 2);
          sock.send([head, data], a.client.port, a.client.ip);
        } else {
          sock.send(encode(METHOD.data, CLASS.indication, randomBytes(12), [
            [ATTR.peer, xorAddr(from.address, from.port)],
            [ATTR.data, data],
          ]), a.client.port, a.client.ip);
        }
      });
      ok(allocAttrs(a));
    }, (e) => {
      pending.delete(key5);
      log(`turn: ${e.message}`);
      fail(508, 'Insufficient Capacity');
    });
  }

  return {
    port,
    credentials(id) {
      const username = `${Math.floor(Date.now() / 1000) + CREDENTIAL_TTL}:${id}`;
      return { username, credential: passwordFor(username) };
    },
  };
}
