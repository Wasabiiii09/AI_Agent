'use strict';
// Conversation + tool-calling loop + confirmation for risky actions.

// note: \b does not work with Cyrillic in JS regex, so use an explicit word end
const YES = /^(да|ага|угу|давай|конечно|подтверждаю|выполняй|делай|можно|ок|окей|yes|y|go)(?=\s|$)/i;
const NO = /^(нет|не надо|не нужно|отмена|отмени|стоп|no|n|cancel)(?=\s|$)/i;

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[.,!?…«»"']/g, ' ').replace(/\s+/g, ' ').trim();
}
function isYes(text) { const t = normalize(text); return YES.test(t) && !/^да\s+нет/.test(t); }
function isNo(text) { return NO.test(normalize(text)); }

/** Text cleanup before TTS: no markdown, emoji, urls. */
function toSpeakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'ссылка')
    .replace(/[*_#>~|]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class Agent {
  constructor({ llm, tools, systemPrompt, maxTurns = 10, maxToolRounds = 4, log = () => {} }) {
    this.llm = llm;
    this.tools = tools;
    this.systemPrompt = systemPrompt;
    this.maxTurns = maxTurns;
    this.maxToolRounds = maxToolRounds;
    this.turns = []; // each turn: array of messages, starting with a user message
    this.pending = null; // { call, args, turn }
    this.log = log;
    this.usage = { prompt: 0, completion: 0, requests: 0 };
  }

  messages(extra = []) {
    const flat = this.turns.slice(-this.maxTurns).flat();
    return [{ role: 'system', content: this.systemPrompt }, ...flat, ...extra];
  }

  trim() { if (this.turns.length > this.maxTurns) this.turns = this.turns.slice(-this.maxTurns); }

  reset() { this.turns = []; this.pending = null; }

  addUsage(u) {
    if (!u) return;
    this.usage.prompt += u.prompt_tokens || 0;
    this.usage.completion += u.completion_tokens || 0;
    this.usage.requests += 1;
  }

  /**
   * Handle one user utterance. Returns { text, confirm?: {summary, reason} }
   */
  async handle(userText) {
    const text = String(userText || '').trim();
    if (!text) return { text: '' };

    if (this.pending) {
      const p = this.pending;
      if (isYes(text)) { this.pending = null; return this.resolvePending(p, true); }
      if (isNo(text)) { this.pending = null; return this.resolvePending(p, false); }
      // anything else: drop the pending action and treat as a new request
      this.pending = null;
      p.turn.push({ role: 'tool', tool_call_id: p.call.id, content: 'Пользователь не подтвердил, действие отменено.' });
    }

    const turn = [{ role: 'user', content: text }];
    this.turns.push(turn);
    this.trim();
    return this.loop(turn);
  }

  async confirm(yes) {
    if (!this.pending) return { text: '' };
    const p = this.pending; this.pending = null;
    return this.resolvePending(p, !!yes);
  }

  async resolvePending(p, yes) {
    if (!yes) {
      p.turn.push({ role: 'tool', tool_call_id: p.call.id, content: 'Пользователь отказался, действие отменено.' });
      return { text: 'Хорошо, не буду.' };
    }
    const result = await this.tools.call(p.call.function.name, p.args, { confirmed: true });
    this.log('tool(confirmed)', p.call.function.name, result);
    p.turn.push({ role: 'tool', tool_call_id: p.call.id, content: JSON.stringify(result) });
    return this.loop(p.turn, 1);
  }

  async loop(turn, round = 0) {
    for (; round <= this.maxToolRounds; round++) {
      const useTools = round < this.maxToolRounds;
      const { message, usage } = await this.llm.chat(this.messages(), useTools ? this.tools.schemas : undefined);
      this.addUsage(usage);
      const calls = (message.tool_calls || []).filter((c) => c && c.function);
      const assistantMsg = { role: 'assistant', content: message.content || '' };
      if (calls.length) assistantMsg.tool_calls = calls;
      turn.push(assistantMsg);
      if (!calls.length) return { text: String(message.content || '').trim() };

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        let args = {};
        try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
        const gate = this.tools.gate(call.function.name, args);
        if (gate) {
          // remaining calls in this batch are skipped
          for (const rest of calls.slice(i + 1)) turn.push({ role: 'tool', tool_call_id: rest.id, content: 'пропущено: ожидается подтверждение другого действия' });
          this.pending = { call, args, turn };
          const warn = gate.dangerous ? ' Осторожно, это может что-то изменить или удалить.' : '';
          return {
            text: `Выполнить команду «${gate.summary}»?${warn} Скажи «да» или «нет».`,
            confirm: { summary: gate.summary, reason: gate.reason, dangerous: gate.dangerous },
          };
        }
        const result = await this.tools.call(call.function.name, args);
        this.log('tool', call.function.name, args, result);
        turn.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    return { text: 'Что-то я запуталась. Повтори, пожалуйста?' };
  }
}

module.exports = { Agent, isYes, isNo, toSpeakable, normalize };
