#!/usr/bin/env node
'use strict';
// Проверка окружения: node bin/doctor.js   (--speak — проверить голос, --llm — тестовый запрос к мозгу)
const fs = require('fs');
const { spawnSync } = require('child_process');
const { loadConfig, loadEnv, resolveLlm, expandPath, resolveCharacter, listCharacters } = require('../src/main/config');

const cfg = loadConfig(); const env = loadEnv();
let bad = 0;
const ok = (m) => console.log('  ✔ ' + m);
const no = (m, hint) => { bad++; console.log('  ✘ ' + m + (hint ? `\n      → ${hint}` : '')); };
const has = (b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0;
const file = (p) => fs.existsSync(expandPath(p));

console.log('Окружение');
process.env.WAYLAND_DISPLAY ? ok(`Wayland: ${process.env.WAYLAND_DISPLAY}`) : no('WAYLAND_DISPLAY не задан', 'запускай из сессии Hyprland');
process.env.HYPRLAND_INSTANCE_SIGNATURE ? ok('Hyprland запущен') : no('Hyprland не обнаружен');
file('node_modules/electron') ? ok('electron установлен') : no('нет node_modules', 'npm install');
for (const b of ['pw-record', 'wpctl', 'playerctl', 'grim', 'xdg-open']) has(b) ? ok(b) : no(`${b} не найден`, 'sudo pacman -S pipewire wireplumber playerctl grim xdg-utils');

console.log('Мозг');
try {
  const l = resolveLlm(cfg, env);
  ok(`${l.name}: ${l.model} @ ${l.baseUrl}`);
  (!l.apiKeyEnv || l.apiKey) ? ok('API-ключ есть') : no(`нет ${l.apiKeyEnv}`, 'впиши ключ в .env');
} catch (e) { no(e.message); }

console.log('Распознавание речи');
const sp = cfg.stt.providers[cfg.stt.provider] || {};
if (cfg.stt.provider === 'whispercpp') {
  (sp.bin.includes('/') ? file(sp.bin) : has(sp.bin)) ? ok(`whisper-cli: ${sp.bin}`) : no('whisper-cli не найден', './scripts/install-arch.sh');
  file(sp.model) ? ok(`модель ${sp.model}`) : no(`нет ${sp.model}`, './scripts/download-models.sh');
} else ok(`провайдер ${cfg.stt.provider}`);

console.log('Голос');
const ch = resolveCharacter(cfg, null, env);
const tp = cfg.tts.providers[ch.ttsProvider] || {};
if ((tp.type || ch.ttsProvider) === 'piper') {
  (tp.bin.includes('/') ? file(tp.bin) : has(tp.bin)) ? ok(`piper: ${tp.bin}`) : no('piper не найден', 'uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python piper-tts');
  file(tp.model) ? ok(`голос ${tp.model}`) : no(`нет ${tp.model}`, './scripts/download-models.sh');
} else ok(`провайдер ${ch.ttsProvider}`);

console.log(`Персонажи (активный: ${ch.key})`);
for (const k of listCharacters(cfg)) {
  const c = resolveCharacter(cfg, k);
  file(c.avatar.vrm) ? ok(`${k}: ${c.avatar.vrm}`) : console.log(`  · ${k}: нет ${c.avatar.vrm} (будет заглушка) — см. README «Модели»`);
}
if (!file(ch.avatar.vrm)) no(`у активного персонажа «${ch.key}» нет модели ${ch.avatar.vrm}`);

(async () => {
  if (process.argv.includes('--speak')) {
    const { createTts } = require('../src/main/tts');
    const wav = await createTts(cfg, { ...env, COMPANION_TTS: env.COMPANION_TTS || ch.ttsProvider }).synthesize('Привет! Проверка голоса.');
    fs.writeFileSync('/tmp/companion-test.wav', wav);
    console.log('  записано /tmp/companion-test.wav'); spawnSync('pw-play', ['/tmp/companion-test.wav'], { stdio: 'inherit' });
  }
  if (process.argv.includes('--llm')) {
    const { createLlmClient } = require('../src/main/llm');
    const r = await createLlmClient(resolveLlm(cfg, env)).chat([{ role: 'user', content: 'Скажи «привет» одним словом.' }]);
    console.log('  ответ мозга:', r.message.content, r.usage || '');
  }
  console.log(bad ? `\nПроблем: ${bad}` : '\nВсё готово!');
})().catch((e) => { console.error('  ✘', e.message); process.exit(1); });
