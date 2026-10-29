'use strict';
// Tools the LLM can call. Safe ones run immediately, risky ones need confirmation.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Things that ALWAYS need confirmation, even if the first word is in the allowlist.
const DANGEROUS = [
  /\b(rm|rmdir|shred|unlink|dd|mkfs(\.\w+)?|fdisk|parted|wipefs|mount|umount|swapoff)\b/,
  /\b(sudo|doas|su|pkexec|run0)\b/,
  /\b(chmod|chown|chattr|chgrp)\b/,
  /\b(kill|pkill|killall|xkill)\b/,
  /\b(shutdown|reboot|poweroff|halt|suspend|hibernate)\b/,
  /\bsystemctl\b/, /\bloginctl\b/,
  /\b(pacman|yay|paru|pip|pipx|npm|cargo|flatpak)\b/,
  /\b(mv|cp|ln|truncate|tee|install)\b/,
  /\bgit\s+(push|reset|clean|checkout|rebase)\b/,
  /\b(curl|wget)\b.*\|\s*(ba|z|fi)?sh\b/,
  /\bhyprctl\s+(dispatch\s+(exec|exit|killactive|forcekillactive)|keyword|reload|kill)\b/,
  /\b(crontab|at)\b/, /\bpasswd\b/, /\bssh\b/, /\beval\b/,
  />|<|\$\(|`/, // redirects, command substitution
];
// Shell syntax that makes a command non-trivial => never auto-run
const SHELL_META = /[;&|<>`$\\\n(){}*?!]|\b(eval|exec|source)\b/;

function tokenize(cmd) {
  const out = []; let cur = ''; let q = null; let had = false;
  for (const c of String(cmd)) {
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; had = true; continue; }
    if (/\s/.test(c)) { if (cur || had) out.push(cur); cur = ''; had = false; continue; }
    cur += c;
  }
  if (cur || had) out.push(cur);
  return out;
}

/** Decide whether a free-form shell command can run without asking. */
function classifyCommand(command, allowedCommands = []) {
  const cmd = String(command || '').trim();
  if (!cmd) return { allowed: false, reason: 'пустая команда' };
  if (DANGEROUS.some((re) => re.test(cmd))) return { allowed: false, dangerous: true, reason: 'потенциально опасная команда' };
  if (SHELL_META.test(cmd)) return { allowed: false, reason: 'сложный синтаксис оболочки' };
  const argv = tokenize(cmd);
  const bin = path.basename(argv[0] || '');
  if (!allowedCommands.includes(bin)) return { allowed: false, reason: `«${bin}» нет в списке разрешённых` };
  return { allowed: true, argv };
}

function defaultRunner(cmd, args, { timeoutMs = 15000, input } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message }); }
    const timer = setTimeout(() => { if (!done) { child.kill('SIGKILL'); err += '\n[таймаут]'; } }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 20000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 5000) err += d; });
    child.on('error', (e) => { done = true; clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: e.code === 'ENOENT' ? `не найдено: ${cmd}` : e.message }); });
    child.on('close', (code) => { done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function defaultLauncher(cmd, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', (e) => resolve({ ok: false, error: e.code === 'ENOENT' ? `программа не найдена: ${cmd}` : e.message }));
      child.unref();
      setTimeout(() => resolve({ ok: true }), 300);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

function clip(s, n = 1500) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + '\n…(обрезано)' : s; }

function findApp(apps, name) {
  const q = String(name || '').toLowerCase().trim();
  if (!q) return null;
  for (const [key, app] of Object.entries(apps)) {
    const names = [key, ...(app.names || [])].map((x) => x.toLowerCase());
    if (names.includes(q)) return { key, ...app };
  }
  for (const [key, app] of Object.entries(apps)) {
    const names = [key, ...(app.names || [])].map((x) => x.toLowerCase());
    if (names.some((n) => q.includes(n) || n.includes(q))) return { key, ...app };
  }
  return null;
}

function createTools(config = {}, deps = {}) {
  const run = deps.runner || defaultRunner;
  const launch = deps.launcher || defaultLauncher;
  const now = deps.now || (() => new Date());
  const notify = deps.notify || (() => {});
  const home = deps.home || os.homedir();
  const t = config.tools || {};
  const apps = t.apps || {};
  const allowed = t.allowedCommands || [];
  const timers = new Set();

  const defs = [
    {
      name: 'open_app',
      description: 'Запустить программу на компьютере пользователя. Только из списка известных программ.',
      parameters: { type: 'object', properties: { app: Object.keys(apps).length ? { type: 'string', enum: Object.keys(apps), description: 'ключ программы' } : { type: 'string' } }, required: ['app'] },
      async run({ app }) {
        const a = findApp(apps, app);
        if (!a) return { ok: false, error: `не знаю программу «${app}». Известные: ${Object.keys(apps).join(', ')}` };
        const [cmd, ...args] = a.cmd;
        const r = await launch(cmd, args);
        return r.ok ? { ok: true, result: `запущено: ${a.key}` } : { ok: false, error: r.error };
      },
    },
    {
      name: 'open_url',
      description: 'Открыть ссылку (http/https) в браузере.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      async run({ url }) {
        let u = String(url || '').trim();
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        try { const p = new URL(u); if (!/^https?:$/.test(p.protocol)) throw 0; } catch { return { ok: false, error: 'некорректная ссылка' }; }
        const r = await launch(t.urlOpener || 'xdg-open', [u]);
        return r.ok ? { ok: true, result: `открыто: ${u}` } : { ok: false, error: r.error };
      },
    },
    {
      name: 'web_search',
      description: 'Открыть поиск в браузере по запросу (сам не читает результаты).',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async run({ query }) {
        const tpl = t.searchUrl || 'https://duckduckgo.com/?q={q}';
        const u = tpl.replace('{q}', encodeURIComponent(String(query || '')));
        const r = await launch(t.urlOpener || 'xdg-open', [u]);
        return r.ok ? { ok: true, result: `открыт поиск: ${query}` } : { ok: false, error: r.error };
      },
    },
    {
      name: 'media_control',
      description: 'Управление плеером (музыка/видео) через playerctl.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['play', 'pause', 'play-pause', 'next', 'previous', 'stop', 'status'] } }, required: ['action'] },
      async run({ action }) {
        const ok = ['play', 'pause', 'play-pause', 'next', 'previous', 'stop', 'status'];
        if (!ok.includes(action)) return { ok: false, error: 'неизвестное действие' };
        const args = action === 'status' ? ['metadata', '--format', '{{status}}: {{artist}} — {{title}}'] : [action];
        const r = await run('playerctl', args, { timeoutMs: 5000 });
        if (r.code !== 0) return { ok: false, error: clip(r.stderr || 'нет активного плеера', 200) };
        return { ok: true, result: clip(r.stdout) || 'готово' };
      },
    },
    {
      name: 'set_volume',
      description: 'Громкость звука. level — абсолютное значение в процентах (0-150), change — изменение в процентах (+/-), mute — on/off/toggle.',
      parameters: { type: 'object', properties: { level: { type: 'number' }, change: { type: 'number' }, mute: { type: 'string', enum: ['on', 'off', 'toggle'] } } },
      async run({ level, change, mute }) {
        const sink = '@DEFAULT_AUDIO_SINK@';
        if (mute) {
          const v = mute === 'on' ? '1' : mute === 'off' ? '0' : 'toggle';
          const r = await run('wpctl', ['set-mute', sink, v], { timeoutMs: 5000 });
          return r.code === 0 ? { ok: true, result: `mute: ${mute}` } : { ok: false, error: clip(r.stderr, 200) };
        }
        let arg;
        if (typeof level === 'number') arg = `${Math.max(0, Math.min(150, Math.round(level)))}%`;
        else if (typeof change === 'number') arg = `${Math.min(100, Math.abs(Math.round(change)))}%${change >= 0 ? '+' : '-'}`;
        else {
          const r = await run('wpctl', ['get-volume', sink], { timeoutMs: 5000 });
          return r.code === 0 ? { ok: true, result: clip(r.stdout) } : { ok: false, error: clip(r.stderr, 200) };
        }
        const r = await run('wpctl', ['set-volume', '-l', '1.5', sink, arg], { timeoutMs: 5000 });
        return r.code === 0 ? { ok: true, result: `громкость: ${arg}` } : { ok: false, error: clip(r.stderr, 200) };
      },
    },
    {
      name: 'screenshot',
      description: 'Сделать скриншот экрана (grim). region=true — выделить область мышью (slurp).',
      parameters: { type: 'object', properties: { region: { type: 'boolean' } } },
      async run({ region }) {
        const dir = (t.screenshotDir || '~/Pictures/Screenshots').replace(/^~/, home);
        fs.mkdirSync(dir, { recursive: true });
        const d = now();
        const p2 = (n) => String(n).padStart(2, '0');
        const file = path.join(dir, `screenshot_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}.png`);
        let args = [file];
        if (region) {
          const s = await run('slurp', [], { timeoutMs: 60000 });
          if (s.code !== 0) return { ok: false, error: 'выделение отменено' };
          args = ['-g', s.stdout.trim(), file];
        }
        const r = await run('grim', args, { timeoutMs: 10000 });
        return r.code === 0 ? { ok: true, result: `сохранено: ${file}` } : { ok: false, error: clip(r.stderr, 200) };
      },
    },
    {
      name: 'search_files',
      description: 'Найти файлы в домашней папке по части имени.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async run({ query }) {
        const q = String(query || '').replace(/[*?[\]]/g, '').trim();
        if (q.length < 2) return { ok: false, error: 'слишком короткий запрос' };
        const r = await run('find', [home, '-maxdepth', '6', '-not', '-path', '*/.*', '-iname', `*${q}*`], { timeoutMs: 8000 });
        const lines = r.stdout.split('\n').filter(Boolean);
        if (!lines.length) return { ok: true, result: 'ничего не найдено' };
        return { ok: true, result: `найдено ${lines.length}${lines.length > 15 ? ' (показаны первые 15)' : ''}:\n` + lines.slice(0, 15).join('\n') };
      },
    },
    {
      name: 'get_datetime',
      description: 'Текущие дата, время и день недели.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const d = now();
        const s = d.toLocaleString('ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return { ok: true, result: s };
      },
    },
    {
      name: 'set_timer',
      description: 'Поставить таймер/напоминание через N минут (пока приложение запущено).',
      parameters: { type: 'object', properties: { minutes: { type: 'number' }, text: { type: 'string' } }, required: ['minutes'] },
      async run({ minutes, text }) {
        const m = Number(minutes);
        if (!(m > 0 && m <= 24 * 60)) return { ok: false, error: 'минуты должны быть от 0 до 1440' };
        const msg = text ? `Напоминаю: ${text}` : 'Таймер! Время вышло.';
        const h = setTimeout(() => { timers.delete(h); notify(msg); }, m * 60000);
        if (h.unref) h.unref();
        timers.add(h);
        return { ok: true, result: `таймер на ${m} мин поставлен` };
      },
    },
    {
      name: 'run_command',
      description: 'Выполнить shell-команду. Безопасные команды из списка выполняются сразу, остальные — только после подтверждения пользователя (система спросит сама). Используй, только если другие инструменты не подходят.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, why: { type: 'string', description: 'кратко зачем' } }, required: ['command'] },
      // gate: returns null if fine, or confirmation info
      gate({ command }) {
        const c = classifyCommand(command, allowed);
        return c.allowed ? null : { reason: c.reason, dangerous: !!c.dangerous, summary: String(command) };
      },
      async run({ command }, { confirmed } = {}) {
        const c = classifyCommand(command, allowed);
        let r;
        if (c.allowed) r = await run(c.argv[0], c.argv.slice(1), { timeoutMs: 15000 });
        else if (confirmed) r = await run('bash', ['-c', String(command)], { timeoutMs: 60000 });
        else return { ok: false, error: 'нужно подтверждение' };
        const text = clip((r.stdout || '') + (r.stderr ? `\n[stderr] ${r.stderr}` : ''));
        return { ok: r.code === 0, result: `код выхода ${r.code}\n${text}` };
      },
    },
  ];

  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  const enabled = t.enabled ? defs.filter((d) => t.enabled.includes(d.name)) : defs;

  return {
    schemas: enabled.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } })),
    has: (n) => enabled.some((d) => d.name === n),
    gate: (n, args) => (byName[n] && byName[n].gate ? byName[n].gate(args) : null),
    async call(n, args, opts) {
      const d = byName[n];
      if (!d || !enabled.includes(d)) return { ok: false, error: `неизвестный инструмент ${n}` };
      try { return await d.run(args || {}, opts); } catch (e) { return { ok: false, error: e.message }; }
    },
    cancelTimers() { for (const h of timers) clearTimeout(h); timers.clear(); },
  };
}

module.exports = { createTools, classifyCommand, tokenize, findApp, defaultRunner };
