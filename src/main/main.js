'use strict';
const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { loadConfig, loadEnv, resolveLlm, expandPath, ROOT, resolveCharacter, listCharacters } = require('./config');
const { createLlmClient } = require('./llm');
const { createTools } = require('./tools');
const { Agent, toSpeakable } = require('./agent');
const { createTts, splitSentences } = require('./tts');
const { createStt } = require('./stt');
const { createRecorder } = require('./recorder');
const { startControlServer } = require('./control');

const TITLE = 'Anime Companion';
app.setName('anime-companion');
// Wayland-native by default (run.sh also sets ELECTRON_OZONE_PLATFORM_HINT)
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
// Let audio play without a user gesture (speech is triggered by hotkeys)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) { console.log('anime-companion уже запущен'); app.exit(0); }

const env = loadEnv();
const cfg = loadConfig();
const log = (...a) => { if (cfg.debug || env.COMPANION_DEBUG) console.log('[companion]', ...a); };

let win = null;
let interactive = !!(cfg.window && cfg.window.startInteractive);
let visible = true;
let busy = false;
let speechGen = 0;
let control = null;

const llmOpts = resolveLlm(cfg, env);
const llm = createLlmClient(llmOpts);
const tools = createTools(cfg, { notify: (msg) => { notifyDesktop(msg); speak(msg); } });
let character, persona, agent, tts = null, stt = null;

function buildPrompt(p) {
  return [
    (p.systemPrompt || '').replace(/\{name\}/g, p.name || 'Мику').replace(/\{style\}/g, p.style || ''),
    `Программы, которые ты можешь открыть (open_app): ${Object.keys((cfg.tools || {}).apps || {}).join(', ') || 'нет'}.`,
  ].join('\n');
}

/** (Re)build persona, agent and voice for a character from config.characters */
function applyCharacter(name) {
  const c = resolveCharacter(cfg, name, env);
  character = c;
  persona = c.persona;
  agent = new Agent({ llm, tools, systemPrompt: buildPrompt(persona), maxTurns: (cfg.llm || {}).historyTurns || 10, log });
  tts = null;
  try { tts = createTts(cfg, { ...env, COMPANION_TTS: env.COMPANION_TTS || c.ttsProvider }); } catch (e) { console.error(e.message); }
  log('character', c.key, persona.name, 'tts', c.ttsProvider, 'vrm', c.avatar.vrm);
  return c;
}
applyCharacter();
try { stt = createStt(cfg, env); } catch (e) { console.error(e.message); }

const recorder = createRecorder(cfg);

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }
function status(s, extra) { send('status', { state: s, ...extra }); }

function notifyDesktop(body) {
  try { if (Notification.isSupported()) new Notification({ title: persona.name || 'Companion', body }).show(); } catch { /* no notifd */ }
}

function setInteractive(v) {
  interactive = !!v;
  if (win) win.setIgnoreMouseEvents(!interactive);
  send('interactive', interactive);
}

async function speak(text, { bubble = true } = {}) {
  const gen = ++speechGen;
  if (bubble) send('bubble', { text });
  const clean = toSpeakable(text);
  if (!clean || !tts || (cfg.tts && cfg.tts.enabled === false)) return;
  for (const chunk of splitSentences(clean)) {
    if (gen !== speechGen) return; // interrupted
    try {
      const audio = await tts.synthesize(chunk);
      if (gen !== speechGen) return;
      send('speak-chunk', { gen, audio, text: chunk });
    } catch (e) {
      console.error(e.message);
      send('bubble', { text: `${text}\n\n(Голос не работает: ${e.message})` });
      return;
    }
  }
}

function stopSpeech() { speechGen++; send('stop-speech'); }

async function handleUserText(text, source = 'text') {
  text = String(text || '').trim();
  if (!text) return;
  if (busy) { send('bubble', { text: 'Секундочку, я ещё думаю…' }); return; }
  busy = true;
  stopSpeech();
  send('user-said', { text, source });
  status('thinking');
  try {
    if (!llmOpts.apiKey && llmOpts.apiKeyEnv) throw new Error(`Нет ключа API: впиши ${llmOpts.apiKeyEnv} в файл .env`);
    const res = await agent.handle(text);
    log('usage', agent.usage);
    if (res.confirm) { send('confirm', res.confirm); if (!interactive) send('interactive-hint', true); }
    else send('confirm', null);
    if (res.text) await speak(res.text);
  } catch (e) {
    console.error(e);
    send('bubble', { text: `Ой, ошибка: ${e.message}` });
    if (/ключа API/.test(e.message)) speak('Мне нужен ключ API. Впиши его в файл точка env.', { bubble: false });
  } finally {
    busy = false;
    status('idle');
  }
}

async function confirm(yes) {
  if (busy) return;
  busy = true; send('confirm', null); status('thinking');
  try { const res = await agent.confirm(yes); if (res.text) await speak(res.text); }
  catch (e) { send('bubble', { text: `Ой, ошибка: ${e.message}` }); }
  finally { busy = false; status('idle'); }
}

async function pttStart() {
  if (recorder.recording) return 'already';
  stopSpeech();
  if (!recorder.start()) return 'error: запись не запустилась';
  status('listening');
  return 'listening';
}

async function pttStop() {
  if (!recorder.recording) return 'not-recording';
  const rec = await recorder.stop();
  if (!rec || rec.ms < 300) { status('idle'); return 'too-short'; }
  if (!stt) { send('bubble', { text: 'Распознавание речи не настроено (stt в config.json).' }); status('idle'); return 'no-stt'; }
  status('transcribing');
  try {
    const text = await stt.transcribe(rec.file);
    log('heard', text);
    if (!text) { status('idle'); send('bubble', { text: 'Не расслышала…' }); return 'empty'; }
    handleUserText(text, 'voice');
    return `heard: ${text}`;
  } catch (e) {
    console.error(e.message); status('idle'); send('bubble', { text: `Ошибка распознавания: ${e.message}` }); return `error: ${e.message}`;
  } finally { fs.rm(rec.file, { force: true }, () => {}); }
}

async function onControl(cmd, arg) {
  switch (cmd) {
    case 'ptt-start': return pttStart();
    case 'ptt-stop': return pttStop();
    case 'ptt-toggle': return recorder.recording ? pttStop() : pttStart();
    case 'interact': setInteractive(!interactive); return interactive ? 'interactive' : 'click-through';
    case 'show': win.showInactive(); visible = true; return 'shown';
    case 'hide': win.hide(); visible = false; return 'hidden';
    case 'toggle': visible ? win.hide() : win.showInactive(); visible = !visible; return visible ? 'shown' : 'hidden';
    case 'yes': confirm(true); return 'ok';
    case 'no': confirm(false); return 'ok';
    case 'stop': stopSpeech(); return 'stopped';
    case 'reset': agent.reset(); send('bubble', { text: 'Начнём с чистого листа!' }); return 'reset';
    case 'say': handleUserText(arg, 'ctl'); return 'ok';
    case 'speak': speak(arg); return 'ok';
    case 'character':
    case 'char': {
      if (!arg) return `персонажи: ${listCharacters(cfg).join(', ') || '(нет)'}; активный: ${character.key}`;
      stopSpeech(); applyCharacter(arg.trim());
      win.webContents.reload(); // renderer re-inits with the new model
      setTimeout(() => persona.greeting && speak(persona.greeting), 2500);
      return `персонаж: ${character.key}`;
    }
    case 'status': return JSON.stringify({ busy, recording: recorder.recording, interactive, llm: `${llmOpts.name}/${llmOpts.model}`, usage: agent.usage, character: character.key });
    case 'quit': setTimeout(() => app.quit(), 50); return 'bye';
    default: return `error: неизвестная команда ${cmd}`;
  }
}

function vrmUrl() {
  const p = character.avatar.vrm ? expandPath(character.avatar.vrm) : null;
  return p && fs.existsSync(p) ? pathToFileURL(p).href : null;
}

function createWindow() {
  const w = cfg.window || {};
  win = new BrowserWindow({
    title: TITLE,
    width: w.width || 420,
    height: w.height || 640,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.showInactive(); setInteractive(interactive); });
  if (env.COMPANION_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

ipcMain.handle('init', () => ({
  vrmUrl: vrmUrl(),
  vrmPath: character.avatar.vrm,
  avatar: character.avatar,
  character: character.key,
  persona: { name: persona.name || 'Мику' },
  interactive,
  llm: `${llmOpts.name}/${llmOpts.model}`,
  hasKey: !!llmOpts.apiKey || !llmOpts.apiKeyEnv,
  ui: cfg.ui || {},
}));
ipcMain.handle('load-vrm', () => {
  const p = character.avatar.vrm ? expandPath(character.avatar.vrm) : null;
  if (!p || !fs.existsSync(p)) return null;
  return fs.readFileSync(p);
});
ipcMain.on('user-text', (_e, text) => handleUserText(text, 'text'));
ipcMain.on('confirm', (_e, yes) => confirm(yes));
ipcMain.on('set-interactive', (_e, v) => setInteractive(v));
ipcMain.on('ptt', (_e, on) => (on ? pttStart() : pttStop()));
ipcMain.on('renderer-log', (_e, m) => console.log('[renderer]', m));
ipcMain.on('avatar-ready', async (_e, info) => {
  log('avatar ready', info);
  // Headless smoke test: COMPANION_SELFTEST=/path/shot.png
  if (env.COMPANION_SELFTEST) {
    if (env.COMPANION_SELFTEST_SPEAK) await speak(env.COMPANION_SELFTEST_SPEAK);
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(env.COMPANION_SELFTEST, img.toPNG());
      console.log('SELFTEST', JSON.stringify(info), '->', env.COMPANION_SELFTEST);
      app.quit();
    }, Number(env.COMPANION_SELFTEST_DELAY || 2500));
  }
});

app.whenReady().then(() => {
  createWindow();
  control = startControlServer(onControl);
  log('control socket', control.file, 'llm', llmOpts.name, llmOpts.model);
  if (persona.greeting && !env.COMPANION_SELFTEST) setTimeout(() => speak(persona.greeting), 1500);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (control) control.close();
  tools.cancelTimers();
  if (stt && stt.stop) stt.stop();
});
