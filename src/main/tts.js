'use strict';
// Pluggable TTS. Every provider: synthesize(text) -> Promise<Buffer> (WAV/MP3 bytes the browser can decode)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandPath } = require('./config');

function tmpFile(ext) { return path.join(os.tmpdir(), `companion-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`); }

function runWithStdin(cmd, args, input, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let err = '';
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `TTS: не найдено ${cmd}` : e.message)); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`TTS ${cmd} exit ${code}: ${err.slice(-400)}`)); });
    child.stdin.end(input);
  });
}

function piperTts(o) {
  const bin = o.bin && o.bin.includes('/') ? expandPath(o.bin) : (o.bin || 'piper');
  const model = expandPath(o.model);
  return {
    name: 'piper',
    async synthesize(text) {
      if (!fs.existsSync(model)) throw new Error(`TTS: нет голосовой модели ${model} (запусти scripts/download-models.sh)`);
      const out = tmpFile('wav');
      const args = ['--model', model, '--output_file', out];
      if (o.speaker != null) args.push('--speaker', String(o.speaker));
      if (o.lengthScale) args.push('--length_scale', String(o.lengthScale));
      if (o.noiseScale) args.push('--noise_scale', String(o.noiseScale));
      if (o.sentenceSilence != null) args.push('--sentence_silence', String(o.sentenceSilence));
      // bare program names resolve via PATH; paths like .venv/bin/piper are relative to the project
      await runWithStdin(bin, args, text + '\n');
      try { return fs.readFileSync(out); } finally { fs.rmSync(out, { force: true }); }
    },
  };
}

// OpenAI-compatible /audio/speech (OpenAI tts-1 / gpt-4o-mini-tts, or any compatible server)
function httpTts(o, env, fetchImpl = globalThis.fetch) {
  return {
    name: 'openai',
    async synthesize(text) {
      const key = o.apiKeyEnv ? env[o.apiKeyEnv] : '';
      const res = await fetchImpl(`${String(o.baseUrl).replace(/\/+$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: o.model, voice: o.voice, input: text, response_format: o.format || 'wav', ...(o.extraBody || {}) }),
      });
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

// Any command: {text} and {out} placeholders; text is also piped to stdin. Use it for RVC pipelines etc.
function commandTts(o) {
  return {
    name: 'command',
    async synthesize(text) {
      const out = tmpFile(o.ext || 'wav');
      const argv = o.command.map((a) => a.replace('{out}', out).replace('{text}', text));
      await runWithStdin(argv[0], argv.slice(1), text, o.timeoutMs || 120000);
      try { return fs.readFileSync(out); } finally { fs.rmSync(out, { force: true }); }
    },
  };
}

function createTts(cfg, env = {}, deps = {}) {
  const t = cfg.tts || {};
  const name = env.COMPANION_TTS || t.provider || 'piper';
  const o = (t.providers || {})[name];
  if (!o) throw new Error(`TTS provider "${name}" не найден в config.json`);
  const type = o.type || name;
  if (type === 'piper') return piperTts(o);
  if (type === 'openai') return httpTts(o, env, deps.fetch);
  if (type === 'command') return commandTts(o);
  throw new Error(`Неизвестный тип TTS: ${type}`);
}

/** Split reply into sentence chunks so speech can start before everything is synthesized. */
function splitSentences(text, maxLen = 200) {
  const parts = (String(text).match(/[^.!?…]+[.!?…]+["»)]*|[^.!?…]+$/g) || []).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return [];
  // first sentence alone -> voice starts fast; the rest merged into bigger chunks
  const out = [parts[0]];
  let cur = '';
  for (const p of parts.slice(1)) {
    if (cur && (cur + ' ' + p).length > maxLen) { out.push(cur); cur = p; } else cur = (cur + ' ' + p).trim();
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { createTts, splitSentences };
