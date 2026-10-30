import { MicPipeline, MODES, DEFAULT_STRENGTH, levelOf } from './audio.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const mic = new MicPipeline();
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// One shared call: everyone with the page open is connected to everyone else
// (full mesh). The peer with the smaller id sends the offer.
let ws;
let myId = null;
let iceServers = [];
const peers = new Map(); // id -> { id, name, muted, pc, pending, queue, audio, analyser, state }
let micState = 'starting'; // 'starting' | 'on' | 'denied'
let muted = false;

// Event log for the ?debug panel (kept always, it's tiny).
const debugLog = [];
function dbg(text) {
  debugLog.push(`${new Date().toTimeString().slice(0, 8)} ${text}`);
  if (debugLog.length > 60) debugLog.shift();
}

// ---------- UI helpers ----------
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function tile(id, name, { you, muted, note }) {
  const li = document.createElement('li');
  li.dataset.id = id;
  li.innerHTML = `<div class="avatar"></div><div class="name"></div><div class="muted small note"></div>`;
  li.querySelector('.avatar').textContent = (name[0] || '?').toUpperCase();
  li.querySelector('.name').textContent = name + (you ? ' (вы)' : '');
  li.querySelector('.note').textContent = note || '';
  li.classList.toggle('is-muted', !!muted);
  return li;
}

function render() {
  const ul = $('#tiles');
  ul.innerHTML = '';
  const selfNote = { starting: 'включаю микрофон…', denied: 'нет микрофона' }[micState] || (muted ? 'микрофон выкл.' : '');
  ul.append(tile(myId || 'me', myName, { you: true, muted: muted || micState !== 'on', note: selfNote }));
  for (const p of peers.values()) {
    const note = p.state === 'connected' ? (p.muted ? 'микрофон выкл.' : '')
      : p.state === 'failed' ? 'нет соединения' : 'соединение…';
    ul.append(tile(p.id, p.name, { muted: p.muted, note }));
  }
  const n = peers.size + 1;
  $('#call-title').textContent = myId ? `В звонке: ${n}` : 'Подключение…';
  $('#alone').classList.toggle('hidden', !myId || peers.size > 0);
  $('#mic-retry').classList.toggle('hidden', micState !== 'denied');
  $('#mute').classList.toggle('hidden', micState === 'denied');
  $('#mute').textContent = muted ? 'Вкл. микрофон' : 'Выкл. микрофон';
  $('#mute').classList.toggle('active', muted);
}

// ---------- name ----------
const ADJECTIVES = ['Весёлый', 'Хитрый', 'Сонный', 'Быстрый', 'Тихий', 'Смелый', 'Добрый', 'Ловкий',
  'Мудрый', 'Рыжий', 'Шустрый', 'Важный', 'Бодрый', 'Пушистый', 'Звонкий', 'Ясный'];
const ANIMALS = ['Ёж', 'Лис', 'Барсук', 'Енот', 'Кот', 'Волк', 'Филин', 'Бобр', 'Медведь', 'Заяц',
  'Сокол', 'Тюлень', 'Пингвин', 'Хомяк', 'Олень', 'Дельфин'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randomName = () => pick(ADJECTIVES) + pick(ANIMALS) + Math.floor(10 + Math.random() * 90);

let myName = store.get('name') || randomName();
store.set('name', myName);
$('#name').value = myName;

function setName(name) {
  name = name.trim().slice(0, 24);
  if (!name || name === myName) return;
  myName = name;
  store.set('name', name);
  $('#name').value = name;
  sendMsg({ type: 'update', name });
  render();
}
$('#name').onchange = () => setName($('#name').value);
$('#name').onkeydown = (e) => e.key === 'Enter' && e.target.blur();
$('#name-random').onclick = () => setName(randomName());

$('#copy-link').onclick = async () => {
  const link = location.origin + '/';
  try {
    await navigator.clipboard.writeText(link);
    toast('Ссылка скопирована — отправьте её друзьям');
  } catch {
    prompt('Скопируйте ссылку:', link);
  }
};

// ---------- noise suppression settings ----------
// ('ns-mode2': the default changed to DeepFilterNet3, so old saved choices are dropped.)
mic.mode = store.get('ns-mode2') || 'dfn3';
mic.strength = Number(store.get('ns-strength')) || DEFAULT_STRENGTH;

function syncNsUI() {
  for (const sel of $$('.ns-select')) sel.value = mic.mode;
  for (const r of $$('.ns-strength')) r.value = mic.strength;
  for (const v of $$('.ns-strength-value')) v.textContent = mic.strength >= 100 ? 'макс.' : `${mic.strength} дБ`;
  for (const l of $$('label.strength')) l.classList.toggle('hidden', mic.mode !== 'dfn3');
}

for (const sel of $$('.ns-select')) {
  for (const [value, label] of Object.entries(MODES)) sel.add(new Option(label, value));
  sel.onchange = async () => {
    const prev = mic.mode;
    store.set('ns-mode2', sel.value);
    try {
      if (mic.stream) await withLoadingToast(mic.setMode(sel.value));
      else await mic.setMode(sel.value);
    } catch (e) {
      toast('Не удалось включить режим: ' + e.message);
      mic.mode = prev;
    }
    syncNsUI();
  };
}
for (const r of $$('.ns-strength')) {
  r.oninput = () => {
    mic.setStrength(Number(r.value));
    store.set('ns-strength', r.value);
    syncNsUI();
  };
}
syncNsUI();

async function refreshDevices() {
  const sel = $('#mic-select');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const current = store.get('mic') || '';
  sel.length = 1;
  for (const d of devices) {
    if (d.deviceId === 'default' || !d.deviceId) continue;
    sel.add(new Option(d.label || 'Микрофон', d.deviceId));
  }
  sel.value = devices.some((d) => d.deviceId === current) ? current : '';
}
$('#mic-select').onchange = async (e) => {
  store.set('mic', e.target.value);
  if (mic.stream) await mic.start(mic.mode, e.target.value || undefined);
};
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);

// The model normally comes from the browser cache in a fraction of a second;
// only mention the download when it is actually taking a while.
async function withLoadingToast(promise) {
  let shown = false;
  const timer = setTimeout(() => {
    if (mic.mode === 'dfn3' && !mic.dfn3Registered) {
      shown = true;
      toast('Загружаю модель DeepFilterNet3 (~24 МБ)…');
    }
  }, 1000);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    if (shown) $('#toast').classList.add('hidden');
  }
}

async function ensureMic() {
  if (!window.isSecureContext) throw new Error('Микрофон доступен только по HTTPS');
  try {
    await withLoadingToast(mic.start(mic.mode, store.get('mic') || undefined));
  } catch (e) {
    if (mic.mode !== 'dfn3' || e.name === 'NotAllowedError' || e.name === 'NotFoundError') throw e;
    // Model unavailable (e.g. the server is still downloading it): don't block the call.
    toast('DeepFilterNet3 не загрузилась, включаю GTCRN');
    await mic.start('gtcrn', store.get('mic') || undefined);
    syncNsUI();
  }
  refreshDevices();
}

async function startMic() {
  micState = 'starting';
  render();
  try {
    await ensureMic();
    micState = 'on';
    dbg(`микрофон: ок, шумодав ${mic.mode}`);
  } catch (e) {
    micState = 'denied';
    dbg(`микрофон: ${e.name} ${e.message}`);
    toast('Нет доступа к микрофону: ' + e.message);
  }
  render();
}
$('#mic-retry').onclick = startMic;

$('#mute').onclick = () => {
  muted = !muted;
  mic.muted = muted;
  sendMsg({ type: 'update', muted });
  render();
};

let monitoring = false;
$('#mic-test').onclick = () => {
  monitoring = !monitoring;
  mic.monitor = monitoring;
  $('#mic-test').classList.toggle('active', monitoring);
};

// ---------- sound unlock ----------
// Browsers keep audio suspended until the first click on the page. Until then
// we neither hear the others nor send them our voice, so ask for that click.
let playBlocked = false;
function updateSoundBanner() {
  const blocked = playBlocked || mic.ctx?.state === 'suspended';
  $('#sound-banner').classList.toggle('hidden', !blocked);
}
function unlockSound() {
  mic.ctx?.resume().catch(() => {});
  playBlocked = false;
  for (const p of peers.values()) p.audio?.play().catch(() => (playBlocked = true));
  setTimeout(updateSoundBanner, 100);
}
document.addEventListener('pointerdown', unlockSound);
document.addEventListener('keydown', unlockSound);

// ---------- meters / speaking indicators ----------
const SPEAKING = 0.06;
(function meterLoop() {
  const level = mic.stream ? mic.level() : 0;
  for (const m of $$('.meter-fill')) m.style.width = `${Math.round(level * 100)}%`;
  for (const li of $$('#tiles li')) {
    const p = peers.get(li.dataset.id);
    const l = p ? levelOf(p.analyser) : level;
    li.classList.toggle('speaking', l > SPEAKING);
  }
  requestAnimationFrame(meterLoop);
})();

// ---------- join / leave sounds ----------
function beep(freqs) {
  const ctx = mic.ctx;
  if (ctx?.state !== 'running') return;
  let t = ctx.currentTime;
  for (const f of freqs) {
    const o = new OscillatorNode(ctx, { frequency: f });
    const g = new GainNode(ctx, { gain: 0.0001 });
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.16);
    t += 0.12;
  }
}

// ---------- signaling ----------
function sendMsg(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }
const signal = (to, data) => sendMsg({ type: 'signal', to, data });

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    dbg('сервер: подключено');
    sendMsg({ type: 'join', name: myName, muted });
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    dbg('сервер: соединение потеряно');
    for (const id of [...peers.keys()]) removePeer(id);
    myId = null;
    render();
    setTimeout(connect, 2000);
  };
}

function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = msg.id;
      iceServers = msg.iceServers;
      dbg(`мой id ${myId}, в звонке ещё ${msg.peers.length}`);
      for (const p of msg.peers) addPeer(p);
      render();
      break;
    case 'peer-joined':
      addPeer(msg.peer);
      beep([660, 880]);
      render();
      break;
    case 'peer-left':
      if (peers.has(msg.id)) beep([880, 660]);
      removePeer(msg.id);
      render();
      break;
    case 'peer-updated': {
      const p = peers.get(msg.peer.id);
      if (p) Object.assign(p, { name: msg.peer.name, muted: msg.peer.muted });
      render();
      break;
    }
    case 'signal': {
      const p = peers.get(msg.from);
      // Process each peer's messages strictly in order: an ICE candidate must
      // not overtake the offer it belongs to.
      if (p) p.queue = p.queue.then(() => onSignal(p, msg.data)).catch((e) => dbg(`${p.name}: ошибка ${e.name} ${e.message}`));
      break;
    }
  }
}

// ---------- peers ----------
function addPeer({ id, name, muted }) {
  if (peers.has(id)) return;
  const p = { id, name, muted, pending: [], queue: Promise.resolve(), restarts: 0, state: 'new', local: {}, remote: {} };
  peers.set(id, p);
  dbg(`+ ${name} (${id})`);
  p.pc = createPC(p);
  if (myId < id) p.queue = p.queue.then(() => sendOffer(p));
}

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  peers.delete(id);
  dbg(`- ${p.name}`);
  clearTimeout(p.retry);
  p.pc.close();
  p.source?.disconnect();
  p.audio?.remove();
}

function createPC(p) {
  mic.init();
  const pc = new RTCPeerConnection({ iceServers });
  pc.addTrack(mic.out.stream.getAudioTracks()[0], mic.out.stream);
  pc.onicecandidate = (e) => {
    if (!e.candidate) return dbg(`${p.name}: свои кандидаты собраны (${fmtTypes(p.local)})`);
    countType(p.local, e.candidate.candidate);
    signal(p.id, { kind: 'ice', candidate: e.candidate });
  };
  pc.oniceconnectionstatechange = () => dbg(`${p.name}: ice ${pc.iceConnectionState}`);
  pc.ontrack = (e) => attachAudio(p, e.streams[0]);
  pc.onconnectionstatechange = () => {
    if (peers.get(p.id) !== p) return;
    p.state = pc.connectionState;
    dbg(`${p.name}: ${p.state}`);
    if (p.state === 'connected') {
      p.restarts = 0;
      tuneSender(pc);
    }
    // The offering side retries with an ICE restart a few times (network switch, Wi-Fi hiccup).
    if (p.state === 'failed' && myId < p.id && p.restarts < 3) {
      p.restarts++;
      p.retry = setTimeout(() => (p.queue = p.queue.then(() => sendOffer(p, true))), 2000);
    }
    if (p.state === 'failed' && p.restarts >= 3) toast(`Нет связи с ${p.name} (нужен TURN-сервер?)`);
    render();
  };
  return pc;
}

function attachAudio(p, stream) {
  if (!p.audio) {
    p.audio = document.createElement('audio');
    p.audio.autoplay = true;
    $('#audios').append(p.audio);
  }
  p.audio.srcObject = stream;
  p.audio.play().catch(() => { playBlocked = true; updateSoundBanner(); });
  // Speaking indicator: tap the remote stream (it still plays through the <audio>).
  p.source?.disconnect();
  p.source = mic.ctx.createMediaStreamSource(stream);
  p.analyser ??= new AnalyserNode(mic.ctx, { fftSize: 512 });
  p.source.connect(p.analyser);
}

// Give Opus more headroom than the default (~32 kbps) for clearer voice.
function tuneSender(pc) {
  for (const sender of pc.getSenders()) {
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    params.encodings[0].maxBitrate = 64000;
    sender.setParameters(params).catch(() => {});
  }
}

async function sendOffer(p, iceRestart = false) {
  if (peers.get(p.id) !== p) return;
  await p.pc.setLocalDescription(await p.pc.createOffer({ iceRestart }));
  signal(p.id, { kind: 'offer', sdp: p.pc.localDescription });
  dbg(`${p.name}: отправлен offer${iceRestart ? ' (ICE restart)' : ''}`);
}

async function flushCandidates(p) {
  for (const c of p.pending) await p.pc.addIceCandidate(c).catch(() => {});
  p.pending = [];
}

async function onSignal(p, data) {
  switch (data.kind) {
    case 'offer':
      dbg(`${p.name}: получен offer`);
      await p.pc.setRemoteDescription(data.sdp);
      await flushCandidates(p);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      signal(p.id, { kind: 'answer', sdp: p.pc.localDescription });
      dbg(`${p.name}: отправлен answer`);
      break;
    case 'answer':
      dbg(`${p.name}: получен answer`);
      await p.pc.setRemoteDescription(data.sdp);
      await flushCandidates(p);
      break;
    case 'ice':
      countType(p.remote, data.candidate?.candidate);
      if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate).catch(() => {});
      else p.pending.push(data.candidate);
      break;
  }
}

// ---------- ?debug panel ----------
// host = local network address, srflx = public address found via STUN,
// relay = via TURN. srflx on both sides but no connection means NAT needs TURN.
const candType = (c) => / typ (\w+)/.exec(c || '')?.[1];
function countType(map, c) {
  const t = candType(c);
  if (t) map[t] = (map[t] || 0) + 1;
}
const fmtTypes = (map) => Object.entries(map).map(([t, n]) => `${t}×${n}`).join(' ') || 'нет';

async function pairInfo(pc) {
  const stats = await pc.getStats();
  const states = {};
  let pair;
  stats.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    if (s.type !== 'candidate-pair') return;
    states[s.state] = (states[s.state] || 0) + 1;
    if (s.selected) pair ??= s; // Firefox has no transport stats
  });
  let line = `проверки пар: ${fmtTypes(states)}`;
  if (pair) {
    const l = stats.get(pair.localCandidateId);
    const r = stats.get(pair.remoteCandidateId);
    const kb = (b) => `${Math.round((b || 0) / 1024)} КБ`;
    line += `\n  выбрана пара: ${l?.candidateType}/${l?.protocol} ↔ ${r?.candidateType}, `
      + `отправлено ${kb(pair.bytesSent)}, получено ${kb(pair.bytesReceived)}`
      + (pair.currentRoundTripTime != null ? `, пинг ${Math.round(pair.currentRoundTripTime * 1000)} мс` : '');
  }
  return line;
}

async function debugReport() {
  const lines = [
    `мой id: ${myId || '—'}, сервер: ${['подключение', 'ок', 'закрывается', 'отключён'][ws?.readyState] ?? '—'}`,
    `микрофон: ${micState}, аудио: ${mic.ctx?.state}, автоплей заблокирован: ${playBlocked ? 'да' : 'нет'}`,
    `ICE-серверы: ${iceServers.flatMap((s) => [].concat(s.urls)).join(', ') || '—'}`,
    navigator.userAgent,
  ];
  for (const p of peers.values()) {
    const pc = p.pc;
    lines.push('', `▶ ${p.name} (${p.id}), offer шлёт: ${myId < p.id ? 'я' : 'он'}`,
      `  conn ${pc.connectionState}, ice ${pc.iceConnectionState}, сбор ${pc.iceGatheringState}, sdp ${pc.signalingState}`,
      `  кандидаты мои: ${fmtTypes(p.local)}; его: ${fmtTypes(p.remote)}`,
      `  ${await pairInfo(pc).catch((e) => 'getStats: ' + e.message)}`);
  }
  lines.push('', ...debugLog);
  return lines.join('\n');
}

if (new URLSearchParams(location.search).has('debug')) {
  $('#debug').classList.remove('hidden');
  setInterval(async () => ($('#debug-out').textContent = await debugReport()), 1000);
  $('#debug-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(await debugReport());
      toast('Скопировано');
    } catch {
      toast('Не получилось — выделите текст вручную');
    }
  };
}

// ---------- start ----------
mic.init();
mic.ctx.onstatechange = updateSoundBanner;
mic.muted = muted;
render();
updateSoundBanner();
connect();
startMic();
