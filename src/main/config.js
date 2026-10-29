'use strict';
// Loading config.json (+ config.local.json overrides) and .env
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[m[1]] = val;
  }
  return out;
}

function loadEnv(file = path.join(ROOT, '.env')) {
  let parsed = {};
  try { parsed = parseEnv(fs.readFileSync(file, 'utf8')); } catch { /* no .env */ }
  // real environment wins over the file
  return { ...parsed, ...pickDefined(process.env) };
}

function pickDefined(obj) {
  const o = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== '') o[k] = v;
  return o;
}

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}

function stripJsonComments(text) {
  // allow // line comments in config files (not inside strings)
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    out += c;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
}

function expandPath(p, base = ROOT) {
  if (!p) return p;
  let s = String(p).replace(/\$\{?HOME\}?/g, os.homedir());
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return path.isAbsolute(s) ? s : path.resolve(base, s);
}

function loadConfig(opts = {}) {
  const file = opts.file || process.env.COMPANION_CONFIG || path.join(ROOT, 'config.json');
  let cfg = readJson(file);
  const local = path.join(path.dirname(file), 'config.local.json');
  if (fs.existsSync(local)) cfg = deepMerge(cfg, readJson(local));
  cfg._file = file;
  cfg._root = ROOT;
  return cfg;
}

function resolveLlm(cfg, env) {
  const llm = cfg.llm || {};
  const name = env.COMPANION_LLM || llm.provider;
  const p = (llm.providers || {})[name];
  if (!p) throw new Error(`LLM provider "${name}" не найден в config.json (llm.providers)`);
  const apiKey = p.apiKeyEnv ? env[p.apiKeyEnv] : (p.apiKey || '');
  return {
    name,
    baseUrl: String(env.COMPANION_LLM_BASE_URL || p.baseUrl).replace(/\/+$/, ''),
    model: env.COMPANION_LLM_MODEL || p.model,
    apiKey,
    apiKeyEnv: p.apiKeyEnv,
    tokenParam: p.tokenParam || 'max_tokens',
    extraBody: p.extraBody || {},
    maxTokens: llm.maxTokens || 300,
    temperature: llm.temperature ?? 0.7,
    timeoutMs: llm.timeoutMs || 45000,
  };
}

/**
 * Active character = global persona/avatar/tts defaults + characters[name] overrides.
 * characters: { key: { vrm, persona: {...}, avatar: {...}, tts: "providerName" } }
 */
function listCharacters(cfg) { return Object.keys(cfg.characters || {}); }

function resolveCharacter(cfg, name, env = {}) {
  const chars = cfg.characters || {};
  const key = name || env.COMPANION_CHARACTER || cfg.activeCharacter || Object.keys(chars)[0] || null;
  const ch = (key && chars[key]) || {};
  if (key && !chars[key] && Object.keys(chars).length) throw new Error(`Персонаж "${key}" не найден. Есть: ${Object.keys(chars).join(', ')}`);
  const persona = deepMerge(cfg.persona || {}, ch.persona || {});
  const avatar = deepMerge(cfg.avatar || {}, ch.avatar || {});
  if (ch.vrm) avatar.vrm = ch.vrm;
  return { key, persona, avatar, ttsProvider: ch.tts || (cfg.tts || {}).provider };
}

module.exports = { listCharacters, resolveCharacter, ROOT, parseEnv, loadEnv, loadConfig, resolveLlm, expandPath, deepMerge, stripJsonComments };
