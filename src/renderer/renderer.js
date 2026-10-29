import { createAvatar } from './avatar.js';

const api = window.companion;
const $ = (id) => document.getElementById(id);
const bubble = $('bubble'), statusEl = $('status'), panel = $('panel');
let bubbleTimer = null;

function showBubble(text, cls = '', ms) {
  bubble.textContent = text;
  bubble.className = cls;
  clearTimeout(bubbleTimer);
  const dur = ms ?? Math.min(20000, 4000 + text.length * 70);
  bubbleTimer = setTimeout(() => { bubble.className = 'hidden'; }, dur);
}

const STATUS = { idle: '', listening: '🎙 слушаю…', transcribing: '✍ распознаю…', thinking: '💭 думаю…', speaking: '' };

// ---------- audio + lip-sync ----------
const ctx = new AudioContext();
const analyser = ctx.createAnalyser();
analyser.fftSize = 1024;
analyser.connect(ctx.destination);
const buf = new Float32Array(analyser.fftSize);
let queue = [], playing = null, currentGen = -1, avatar = null;

async function enqueue({ gen, audio }) {
  if (gen !== currentGen) { stopAll(); currentGen = gen; }
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  try {
    const decoded = await ctx.decodeAudioData(ab);
    if (gen !== currentGen) return;
    queue.push(decoded);
    if (!playing) playNext();
  } catch (e) { api.log('decode failed: ' + e); }
}

function playNext() {
  const b = queue.shift();
  if (!b) { playing = null; avatar?.setSpeaking(false); return; }
  if (ctx.state === 'suspended') ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.connect(analyser);
  src.onended = () => { if (playing === src) playNext(); };
  playing = src;
  avatar?.setSpeaking(true);
  src.start();
}

function stopAll() {
  queue = [];
  if (playing) { const p = playing; playing = null; try { p.stop(); } catch { /* already stopped */ } }
  avatar?.setSpeaking(false);
}

function lipLoop() {
  if (avatar) {
    if (playing) {
      analyser.getFloatTimeDomainData(buf);
      let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const rms = Math.sqrt(s / buf.length);
      avatar.setMouth(Math.min(1, Math.max(0, (rms - 0.015) * 7)));
    } else avatar.setMouth(0);
  }
  requestAnimationFrame(lipLoop);
}

// ---------- UI ----------
function setInteractive(v) { panel.className = v ? '' : 'hidden'; if (v) setTimeout(() => $('input').focus(), 50); }

$('chat').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('input').value.trim();
  if (v) { api.sendText(v); $('input').value = ''; }
});
$('yes').onclick = () => api.confirm(true);
$('no').onclick = () => api.confirm(false);
const mic = $('mic');
mic.addEventListener('mousedown', () => api.ptt(true));
mic.addEventListener('mouseup', () => api.ptt(false));
mic.addEventListener('mouseleave', (e) => { if (e.buttons) api.ptt(false); });

api.on('status', ({ state }) => { statusEl.textContent = STATUS[state] ?? ''; });
api.on('bubble', ({ text }) => showBubble(text));
api.on('user-said', ({ text }) => showBubble('Ты: ' + text, 'user', 6000));
api.on('speak-chunk', enqueue);
api.on('stop-speech', () => { stopAll(); currentGen = -1; });
api.on('interactive', setInteractive);
api.on('interactive-hint', () => { /* confirmation also works by voice ("да"/"нет") or companion-ctl yes/no */ });
api.on('confirm', (c) => {
  const box = $('confirm');
  if (!c) { box.className = 'hidden'; return; }
  $('confirm-text').textContent = (c.dangerous ? '⚠ ' : '') + c.summary;
  box.className = '';
  if (panel.className === 'hidden') { panel.className = ''; }
});

(async () => {
  const init = await api.init();
  setInteractive(init.interactive);
  let vrmBuffer = null;
  if (init.vrmUrl) vrmBuffer = await api.loadVrm();
  avatar = await createAvatar($('stage'), { ...init.avatar, vrmBuffer });
  if (avatar.info.kind !== 'vrm') {
    const why = avatar.info.error ? `Не удалось загрузить VRM: ${avatar.info.error}` : `Модель не найдена (${init.vrmPath || 'avatar.vrm не задан'}). Положи .vrm файл и укажи путь в config.json.`;
    showBubble(why, '', 8000);
  }
  if (!init.hasKey) showBubble('Нет API-ключа: впиши его в .env и перезапусти меня.', '', 10000);
  lipLoop();
  api.avatarReady({ ...avatar.info, webgl: !!document.querySelector('canvas').getContext });
})().catch((e) => { api.log('init failed: ' + (e.stack || e)); showBubble('Ошибка запуска: ' + e.message); api.avatarReady({ kind: 'error', error: String(e) }); });
