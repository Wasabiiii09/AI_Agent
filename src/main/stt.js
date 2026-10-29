'use strict';
// Speech-to-text. transcribe(wavPath16kMono) -> Promise<string>
const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const { expandPath } = require('./config');

function run(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `STT: не найдено ${cmd}` : e.message)); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`STT exit ${code}: ${err.slice(-400)}`)); });
  });
}

function cleanTranscript(s) {
  return String(s)
    .replace(/\[[^\]]*\]/g, ' ')      // [BLANK_AUDIO], [музыка], timestamps
    .replace(/\([^)]*(музыка|шум|music|silence)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function whisperCpp(o) {
  const bin = o.bin && o.bin.includes('/') ? expandPath(o.bin) : (o.bin || 'whisper-cli');
  const model = expandPath(o.model);
  return {
    name: 'whispercpp',
    args(wav) {
      return ['-m', model, '-f', wav, '-l', o.language || 'ru', '-nt', '-np', '-t', String(o.threads || 4), ...(o.prompt ? ['--prompt', o.prompt] : []), ...(o.extraArgs || [])];
    },
    async transcribe(wav) {
      if (!fs.existsSync(model)) throw new Error(`STT: нет модели ${model} (запусти scripts/download-models.sh)`);
      return cleanTranscript(await run(bin, this.args(wav)));
    },
  };
}

// faster-whisper in a persistent python worker (model loads once)
function fasterWhisper(o, root) {
  let proc = null, rl = null, queue = [];
  function start() {
    const py = expandPath(o.python || '.venv/bin/python');
    proc = spawn(py, [expandPath('scripts/stt_worker.py'), '--model', o.model || 'base', '--language', o.language || 'ru', '--threads', String(o.threads || 4), '--compute', o.computeType || 'int8'], { stdio: ['pipe', 'pipe', 'inherit'], cwd: root });
    rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const job = queue.shift(); if (!job) return;
      try { const d = JSON.parse(line); d.error ? job.reject(new Error(d.error)) : job.resolve(cleanTranscript(d.text)); } catch (e) { job.reject(e); }
    });
    proc.on('exit', () => { proc = null; for (const j of queue.splice(0)) j.reject(new Error('STT worker exited')); });
  }
  return {
    name: 'faster-whisper',
    transcribe(wav) {
      if (!proc) start();
      return new Promise((resolve, reject) => { queue.push({ resolve, reject }); proc.stdin.write(JSON.stringify({ wav }) + '\n'); });
    },
    stop() { if (proc) proc.kill(); },
  };
}

function openaiStt(o, env, fetchImpl = globalThis.fetch) {
  return {
    name: 'openai',
    async transcribe(wav) {
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'speech.wav');
      fd.append('model', o.model);
      fd.append('language', o.language || 'ru');
      const key = env[o.apiKeyEnv];
      const res = await fetchImpl(`${o.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, { method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : {}, body: fd });
      if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return cleanTranscript((await res.json()).text);
    },
  };
}

function createStt(cfg, env = {}, deps = {}) {
  const s = cfg.stt || {};
  const name = env.COMPANION_STT || s.provider || 'whispercpp';
  const o = (s.providers || {})[name];
  if (!o) throw new Error(`STT provider "${name}" не найден в config.json`);
  const type = o.type || name;
  if (type === 'whispercpp') return whisperCpp(o);
  if (type === 'faster-whisper') return fasterWhisper(o, cfg._root);
  if (type === 'openai') return openaiStt(o, env, deps.fetch);
  throw new Error(`Неизвестный тип STT: ${type}`);
}

module.exports = { createStt, cleanTranscript };
