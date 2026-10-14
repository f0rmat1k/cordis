import { MicPipeline, MODES, DEFAULT_STRENGTH } from './audio.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const mic = new MicPipeline();
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

let ws;
let me = null;
let contacts = [];
let iceServers = [];
let call = null; // { peer, state: 'outgoing'|'incoming'|'connecting'|'active', pc, pending: [], startedAt }

// Invite link: ?add=<name> adds that person to contacts after login.
const pendingAdd = new URLSearchParams(location.search).get('add');

// ---------- UI helpers ----------
function show(id) {
  for (const s of ['login', 'main']) $('#' + s).classList.toggle('hidden', s !== id);
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function renderContacts() {
  const ul = $('#contacts');
  ul.innerHTML = '';
  $('#contacts-empty').classList.toggle('hidden', contacts.length > 0);
  const sorted = [...contacts].sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
  for (const c of sorted) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot"></span><span class="name"></span>
      <button class="call">Позвонить</button><button class="icon ghost" title="Удалить">✕</button>`;
    li.querySelector('.dot').classList.toggle('online', c.online);
    li.querySelector('.name').textContent = c.name;
    const callBtn = li.querySelector('.call');
    callBtn.disabled = !c.online || !!call;
    callBtn.title = c.online ? '' : 'Не в сети';
    callBtn.onclick = () => startCall(c.name);
    li.querySelector('.icon').onclick = () => {
      if (confirm(`Удалить ${c.name} из контактов?`)) sendMsg({ type: 'remove-contact', name: c.name });
    };
    ul.append(li);
  }
}

// Noise-suppression selects (one in settings, one in the call window).
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
    if (sel.value === 'dfn3' && !mic.dfn3Registered && mic.stream) toast('Загружаю модель DeepFilterNet3 (~24 МБ, только в первый раз)…');
    try {
      await mic.setMode(sel.value);
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

// Level meters.
(function meterLoop() {
  const level = mic.stream ? mic.level() : 0;
  for (const m of $$('.meter-fill')) m.style.width = `${Math.round(level * 100)}%`;
  requestAnimationFrame(meterLoop);
})();

async function ensureMic() {
  if (!window.isSecureContext) throw new Error('Микрофон доступен только по HTTPS');
  if (mic.mode === 'dfn3' && !mic.dfn3Registered) toast('Загружаю модель DeepFilterNet3 (~24 МБ, только в первый раз)…');
  try {
    await mic.start(mic.mode, store.get('mic') || undefined);
  } catch (e) {
    if (mic.mode !== 'dfn3' || e.name === 'NotAllowedError' || e.name === 'NotFoundError') throw e;
    // Model unavailable (e.g. the server is still downloading it): don't block the call.
    toast('DeepFilterNet3 не загрузилась, включаю GTCRN');
    await mic.start('gtcrn', store.get('mic') || undefined);
    syncNsUI();
  }
  refreshDevices();
}

let testing = false;
$('#mic-test').onclick = async () => {
  const btn = $('#mic-test');
  if (testing) {
    testing = false;
    mic.monitor = false;
    if (!call) mic.stop();
    btn.textContent = 'Проверить микрофон';
    btn.classList.remove('active');
    return;
  }
  try {
    await ensureMic();
    mic.monitor = true;
    testing = true;
    btn.textContent = 'Остановить проверку';
    btn.classList.add('active');
  } catch (e) {
    toast('Нет доступа к микрофону: ' + e.message);
  }
};

function stopMicTest() {
  if (!testing) return;
  testing = false;
  mic.monitor = false;
  $('#mic-test').textContent = 'Проверить микрофон';
  $('#mic-test').classList.remove('active');
}

// ---------- tones ----------
const tones = {
  ctx: null,
  timer: null,
  beep(freqs, dur) {
    this.ctx ??= new AudioContext();
    this.ctx.resume().catch(() => {});
    const t0 = this.ctx.currentTime;
    for (const f of freqs) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
      g.gain.setValueAtTime(0.08, t0 + dur - 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t0);
      o.stop(t0 + dur);
    }
  },
  ringback() { this.stop(); const p = () => this.beep([425], 1); p(); this.timer = setInterval(p, 4000); },
  ring() { this.stop(); const p = () => { this.beep([660, 880], 0.4); setTimeout(() => this.beep([660, 880], 0.4), 500); }; p(); this.timer = setInterval(p, 2500); },
  stop() { clearInterval(this.timer); this.timer = null; },
};

// ---------- signaling ----------
function sendMsg(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }
const signal = (to, data) => sendMsg({ type: 'signal', to, data });

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    const token = store.get('token');
    if (token) sendMsg({ type: 'auth', token });
    else showLogin();
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (call) endCall('Соединение с сервером потеряно');
    setTimeout(connect, 2000);
  };
}

// Random name so you can just press «Войти»; must fit the server's NAME_RE (≤ 24 chars).
const ADJECTIVES = ['Весёлый', 'Хитрый', 'Сонный', 'Быстрый', 'Тихий', 'Смелый', 'Добрый', 'Ловкий',
  'Мудрый', 'Рыжий', 'Шустрый', 'Важный', 'Бодрый', 'Пушистый', 'Звонкий', 'Ясный'];
const ANIMALS = ['Ёж', 'Лис', 'Барсук', 'Енот', 'Кот', 'Волк', 'Филин', 'Бобр', 'Медведь', 'Заяц',
  'Сокол', 'Тюлень', 'Пингвин', 'Хомяк', 'Олень', 'Дельфин'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randomName = () => pick(ADJECTIVES) + pick(ANIMALS) + Math.floor(10 + Math.random() * 90);
let generatedName = null; // name in the field, if we made it up

function fillRandomName() {
  generatedName = randomName();
  $('#login-name').value = generatedName;
  $('#login-name').select();
}

function showLogin() {
  show('login');
  $('#login-hint').textContent = pendingAdd ? `После входа ${pendingAdd} появится в ваших контактах.` : '';
  if (!$('#login-name').value) fillRandomName();
  $('#login-name').focus();
  $('#login-name').select();
}

$('#login-random').onclick = () => {
  fillRandomName();
  $('#login-name').focus();
};

$('#login-form').onsubmit = (e) => {
  e.preventDefault();
  sendMsg({ type: 'register', name: $('#login-name').value.trim() });
};

$('#add-form').onsubmit = (e) => {
  e.preventDefault();
  sendMsg({ type: 'add-contact', name: $('#add-name').value.trim() });
  $('#add-name').value = '';
};

$('#copy-link').onclick = async () => {
  const link = `${location.origin}/?add=${encodeURIComponent(me)}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Ссылка скопирована — отправьте её другу');
  } catch {
    prompt('Скопируйте ссылку:', link);
  }
};

function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      me = msg.name;
      contacts = msg.contacts;
      iceServers = msg.iceServers;
      store.set('token', msg.token);
      $('#me-name').textContent = me;
      show('main');
      renderContacts();
      if (pendingAdd && pendingAdd !== me && !contacts.some((c) => c.name === pendingAdd)) {
        sendMsg({ type: 'add-contact', name: pendingAdd });
      }
      if (pendingAdd) history.replaceState(null, '', '/');
      break;
    case 'auth-failed':
      store.del('token');
      showLogin();
      break;
    case 'contacts':
      contacts = msg.contacts;
      renderContacts();
      break;
    case 'presence': {
      const c = contacts.find((c) => c.name === msg.name);
      if (c) c.online = msg.online;
      renderContacts();
      if (!msg.online && call?.peer === msg.name) endCall(`${msg.name} отключился`);
      break;
    }
    case 'signal':
      onSignal(msg.from, msg.data);
      break;
    case 'error':
      // Made-up name collided with an existing one — quietly try another.
      if (msg.message === 'Это имя уже занято' && !me && $('#login-name').value === generatedName) {
        fillRandomName();
        sendMsg({ type: 'register', name: generatedName });
        break;
      }
      toast(msg.message);
      break;
  }
}

// ---------- calls ----------
function setCallUI() {
  const ov = $('#call');
  if (!call) { ov.classList.add('hidden'); document.title = 'cordis'; renderContacts(); return; }
  ov.classList.remove('hidden');
  $('#call-peer').textContent = call.peer;
  $('#call-avatar').textContent = call.peer[0].toUpperCase();
  const status = {
    outgoing: 'Вызов…',
    incoming: 'Входящий звонок',
    connecting: 'Соединение…',
    active: '',
  }[call.state];
  if (status) $('#call-status').textContent = status;
  $('#call-incoming-actions').classList.toggle('hidden', call.state !== 'incoming');
  $('#call-active-actions').classList.toggle('hidden', call.state === 'incoming');
  document.title = call.state === 'incoming' ? `📞 ${call.peer} звонит` : 'cordis';
  renderContacts();
}

async function startCall(peer) {
  if (call) return;
  try {
    await ensureMic();
  } catch (e) {
    return toast('Нет доступа к микрофону: ' + e.message);
  }
  stopMicTest();
  call = { peer, state: 'outgoing', pending: [] };
  call.timeout = setTimeout(() => { signal(peer, { kind: 'hangup' }); endCall('Нет ответа'); }, 45000);
  signal(peer, { kind: 'invite' });
  tones.ringback();
  setCallUI();
}

function createPC() {
  const pc = new RTCPeerConnection({ iceServers });
  pc.addTrack(mic.out.stream.getAudioTracks()[0], mic.out.stream);
  pc.onicecandidate = (e) => e.candidate && call && signal(call.peer, { kind: 'ice', candidate: e.candidate });
  pc.ontrack = (e) => {
    const audio = $('#remote-audio');
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (!call || call.pc !== pc) return;
    if (pc.connectionState === 'connected' && call.state !== 'active') {
      call.state = 'active';
      call.startedAt = Date.now();
      tuneSender(pc);
      setCallUI();
      call.clock = setInterval(() => {
        const s = Math.floor((Date.now() - call.startedAt) / 1000);
        $('#call-status').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 500);
      $('#call-status').textContent = '0:00';
    }
    if (pc.connectionState === 'failed') {
      signal(call.peer, { kind: 'hangup' });
      endCall('Не удалось соединиться (нужен TURN-сервер?)');
    }
  };
  return pc;
}

// Give Opus more headroom than the default (~32 kbps) for clearer voice.
function tuneSender(pc) {
  for (const sender of pc.getSenders()) {
    const p = sender.getParameters();
    if (!p.encodings?.length) continue;
    p.encodings[0].maxBitrate = 64000;
    sender.setParameters(p).catch(() => {});
  }
}

async function flushCandidates() {
  for (const c of call.pending) await call.pc.addIceCandidate(c).catch(() => {});
  call.pending = [];
}

async function onSignal(from, data) {
  if (data.kind === 'invite') {
    if (call) return signal(from, { kind: 'busy' });
    call = { peer: from, state: 'incoming', pending: [] };
    tones.ring();
    setCallUI();
    return;
  }
  if (!call || call.peer !== from) return;

  switch (data.kind) {
    case 'accept': {
      if (call.state !== 'outgoing') return;
      clearTimeout(call.timeout);
      tones.stop();
      call.state = 'connecting';
      setCallUI();
      call.pc = createPC();
      const offer = await call.pc.createOffer();
      await call.pc.setLocalDescription(offer);
      signal(from, { kind: 'offer', sdp: call.pc.localDescription });
      break;
    }
    case 'offer': {
      call.pc = createPC();
      await call.pc.setRemoteDescription(data.sdp);
      await flushCandidates();
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      signal(from, { kind: 'answer', sdp: call.pc.localDescription });
      break;
    }
    case 'answer':
      await call.pc.setRemoteDescription(data.sdp);
      await flushCandidates();
      break;
    case 'ice':
      if (call.pc?.remoteDescription) await call.pc.addIceCandidate(data.candidate).catch(() => {});
      else call.pending.push(data.candidate);
      break;
    case 'decline': endCall(`${from} отклонил звонок`); break;
    case 'busy': endCall(`${from} уже разговаривает`); break;
    case 'unavailable': endCall(`${from} не в сети`); break;
    case 'hangup': endCall(call.state === 'incoming' ? `Пропущенный звонок от ${from}` : 'Звонок завершён'); break;
  }
}

$('#call-accept').onclick = async () => {
  if (call?.state !== 'incoming') return;
  tones.stop();
  try {
    await ensureMic();
  } catch (e) {
    signal(call.peer, { kind: 'decline' });
    return endCall('Нет доступа к микрофону: ' + e.message);
  }
  stopMicTest();
  call.state = 'connecting';
  setCallUI();
  signal(call.peer, { kind: 'accept' });
};

$('#call-decline').onclick = () => {
  if (!call) return;
  signal(call.peer, { kind: 'decline' });
  endCall();
};

$('#call-hangup').onclick = () => {
  if (!call) return;
  signal(call.peer, { kind: 'hangup' });
  endCall('Звонок завершён');
};

let muted = false;
$('#call-mute').onclick = () => {
  muted = !muted;
  mic.muted = muted;
  $('#call-mute').textContent = muted ? 'Вкл. микрофон' : 'Выкл. микрофон';
  $('#call-mute').classList.toggle('active', muted);
};

function endCall(message) {
  if (!call) return;
  tones.stop();
  clearTimeout(call.timeout);
  clearInterval(call.clock);
  call.pc?.close();
  call = null;
  $('#remote-audio').srcObject = null;
  muted = false;
  mic.muted = false;
  $('#call-mute').textContent = 'Выкл. микрофон';
  $('#call-mute').classList.remove('active');
  if (!testing) mic.stop();
  setCallUI();
  if (message) toast(message);
}

window.addEventListener('beforeunload', () => call && signal(call.peer, { kind: 'hangup' }));

connect();
