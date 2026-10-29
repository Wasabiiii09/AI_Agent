'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Agent, isYes, isNo, toSpeakable } = require('../src/main/agent');
const { createTools } = require('../src/main/tools');
const { createLlmClient } = require('../src/main/llm');

// Fake OpenAI-compatible server: a queue of scripted assistant messages
function fakeFetch(script, seen) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, headers: init.headers });
    const msg = script.shift();
    if (!msg) throw new Error('no scripted reply');
    if (msg.httpError) return new Response(JSON.stringify({ error: { message: msg.httpError } }), { status: 401 });
    return new Response(JSON.stringify({ choices: [{ message: msg, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  };
}
const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

function setup(script) {
  const seen = []; const runs = [];
  const llm = createLlmClient({ baseUrl: 'https://api.x.ai/v1', model: 'grok-4.3', apiKey: 'sk-test', maxTokens: 300, temperature: 0.7 }, fakeFetch(script, seen));
  const tools = createTools({ tools: { apps: { firefox: { names: ['браузер'], cmd: ['firefox'] } }, allowedCommands: ['df'] } }, {
    runner: async (c, a) => { runs.push([c, ...a]); return { code: 0, stdout: 'ok', stderr: '' }; },
    launcher: async (c, a) => { runs.push(['launch', c, ...a]); return { ok: true }; },
  });
  const agent = new Agent({ llm, tools, systemPrompt: 'SYS', maxTurns: 3 });
  return { agent, seen, runs };
}

test('plain answer, request shape', async () => {
  const { agent, seen } = setup([{ role: 'assistant', content: 'Привет!' }]);
  const r = await agent.handle('привет');
  assert.equal(r.text, 'Привет!');
  assert.equal(seen[0].url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(seen[0].headers.Authorization, 'Bearer sk-test');
  assert.equal(seen[0].body.model, 'grok-4.3');
  assert.equal(seen[0].body.max_tokens, 300);
  assert.equal(seen[0].body.messages[0].content, 'SYS');
  assert.ok(seen[0].body.tools.length >= 8);
});

test('safe tool runs immediately, result fed back', async () => {
  const { agent, seen, runs } = setup([call('c1', 'open_app', { app: 'браузер' }), { role: 'assistant', content: 'Открыла браузер!' }]);
  const r = await agent.handle('открой браузер');
  assert.equal(r.text, 'Открыла браузер!');
  assert.deepEqual(runs, [['launch', 'firefox']]);
  const msgs = seen[1].body.messages;
  assert.equal(msgs.at(-1).role, 'tool');
  assert.equal(msgs.at(-1).tool_call_id, 'c1');
  assert.match(msgs.at(-1).content, /"ok":true/);
});

test('dangerous command asks, runs only after "да"', async () => {
  const { agent, runs, seen } = setup([call('c2', 'run_command', { command: 'rm -rf ~/Загрузки/old' }), { role: 'assistant', content: 'Удалила.' }]);
  const r1 = await agent.handle('удали папку old в загрузках');
  assert.ok(r1.confirm);
  assert.equal(r1.confirm.dangerous, true);
  assert.match(r1.text, /да.*нет/);
  assert.equal(runs.length, 0);
  const r2 = await agent.handle('Да.');
  assert.deepEqual(runs, [['bash', '-c', 'rm -rf ~/Загрузки/old']]);
  assert.equal(r2.text, 'Удалила.');
  assert.equal(seen.length, 2);
});

test('"нет" cancels without calling the model', async () => {
  const { agent, runs, seen } = setup([call('c3', 'run_command', { command: 'sudo reboot' })]);
  await agent.handle('перезагрузи');
  const r = await agent.handle('нет');
  assert.equal(r.text, 'Хорошо, не буду.');
  assert.equal(runs.length, 0);
  assert.equal(seen.length, 1);
});

test('unrelated reply drops pending action and history stays valid', async () => {
  const { agent, runs, seen } = setup([call('c4', 'run_command', { command: 'sudo reboot' }), { role: 'assistant', content: 'Сейчас 9 вечера.' }]);
  await agent.handle('перезагрузи');
  const r = await agent.handle('сколько времени');
  assert.equal(r.text, 'Сейчас 9 вечера.');
  assert.equal(runs.length, 0);
  const msgs = seen[1].body.messages;
  // every assistant tool_call has a tool response
  const ids = msgs.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
  for (const id of ids) assert.ok(msgs.some((m) => m.role === 'tool' && m.tool_call_id === id), id);
});

test('history trimmed to maxTurns', async () => {
  const script = Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', content: `a${i}` }));
  const { agent, seen } = setup(script);
  for (let i = 0; i < 6; i++) await agent.handle(`q${i}`);
  const msgs = seen.at(-1).body.messages;
  assert.equal(msgs.filter((m) => m.role === 'user').length, 3);
  assert.equal(msgs[1].content, 'q3');
});

test('HTTP errors surface readable message', async () => {
  const { agent } = setup([{ httpError: 'Incorrect API key' }]);
  await assert.rejects(agent.handle('привет'), /401: Incorrect API key/);
});

test('tool loop is bounded', async () => {
  const script = Array.from({ length: 5 }, (_, i) => call(`l${i}`, 'get_datetime', {}));
  script.push({ role: 'assistant', content: 'Сейчас вечер.' });
  const { agent, seen } = setup(script);
  const r = await agent.handle('время?');
  assert.equal(r.text.length > 0, true);
  assert.ok(seen.length <= 5);
  assert.equal(seen.at(-1).body.tools, undefined, 'last round forces a text answer');
});

test('yes/no detection and speakable cleanup', () => {
  for (const y of ['да', 'Да!', 'давай', 'ага, выполняй']) assert.ok(isYes(y), y);
  for (const n of ['нет', 'Нет, не надо', 'отмена']) assert.ok(isNo(n), n);
  assert.ok(!isYes('дай подумать'));
  assert.equal(toSpeakable('**Привет** 😊 смотри https://x.ai `ls`'), 'Привет смотри ссылка ls');
});
