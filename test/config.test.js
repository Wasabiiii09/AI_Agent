'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseEnv, loadConfig, resolveLlm, stripJsonComments, resolveCharacter } = require('../src/main/config');
const { splitSentences } = require('../src/main/tts');
const { cleanTranscript } = require('../src/main/stt');
const { recorderCommand } = require('../src/main/recorder');

test('.env parsing', () => {
  const e = parseEnv('# c\nXAI_API_KEY=xai-123\nexport OPENAI_API_KEY="sk 1"\nX=1 # note\n');
  assert.deepEqual(e, { XAI_API_KEY: 'xai-123', OPENAI_API_KEY: 'sk 1', X: '1' });
});

test('config.json loads and providers resolve', () => {
  const cfg = loadConfig();
  const x = resolveLlm(cfg, { XAI_API_KEY: 'k' });
  assert.equal(x.model, 'grok-4.3'); assert.equal(x.baseUrl, 'https://api.x.ai/v1'); assert.equal(x.apiKey, 'k');
  const l = resolveLlm(cfg, { COMPANION_LLM: 'openai-luna', OPENAI_API_KEY: 'o' });
  assert.equal(l.model, 'gpt-6-luna'); assert.equal(l.tokenParam, 'max_completion_tokens');
  assert.equal(resolveLlm(cfg, { COMPANION_LLM: 'ollama' }).baseUrl, 'http://localhost:11434/v1');
});

test('comments stripped but not inside strings', () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{"a":"http://x" // c\n}')), { a: 'http://x' });
});

test('sentence splitting', () => {
  const s = splitSentences('Привет! Как дела? Сегодня отличный день, правда. А ещё я открыла браузер.');
  assert.ok(s.length >= 2);
  assert.equal(s.join(' ').replace(/\s+/g, ' '), 'Привет! Как дела? Сегодня отличный день, правда. А ещё я открыла браузер.');
});

test('transcript cleanup', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO]\n Открой браузер. '), 'Открой браузер.');
});

test('recorder records 16k mono wav', () => {
  assert.deepEqual(recorderCommand('pw-record', '/tmp/a.wav'), ['pw-record', ['--rate', '16000', '--channels', '1', '--format', 's16', '/tmp/a.wav']]);
});

test('characters: active, override and switching', () => {
  const cfg = loadConfig();
  const m = resolveCharacter(cfg);
  assert.equal(m.key, 'marin'); assert.equal(m.avatar.vrm, 'models/marin.vrm'); assert.equal(m.persona.name, 'Марин');
  assert.ok(m.persona.systemPrompt.includes('{name}'), 'inherits global prompt');
  const r = resolveCharacter(cfg, 'ruby');
  assert.equal(r.ttsProvider, 'piper-ruby'); assert.equal(r.avatar.smile, 0.25); assert.equal(r.avatar.distance, cfg.avatar.distance);
  assert.ok(cfg.tts.providers[r.ttsProvider]);
  assert.equal(resolveCharacter(cfg, null, { COMPANION_CHARACTER: 'ruby' }).key, 'ruby');
  assert.throws(() => resolveCharacter(cfg, 'nobody'), /не найден/);
});
