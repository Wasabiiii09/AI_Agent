'use strict';
// Minimal OpenAI-compatible chat client (xAI, OpenAI, Ollama, LM Studio, ...)

class LlmError extends Error {}

function createLlmClient(opts, fetchImpl = globalThis.fetch) {
  if (!opts || !opts.baseUrl || !opts.model) throw new Error('LLM: baseUrl и model обязательны');

  async function chat(messages, tools) {
    const body = {
      model: opts.model,
      messages,
      temperature: opts.temperature,
      [opts.tokenParam || 'max_tokens']: opts.maxTokens,
      ...opts.extraBody,
    };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

    const headers = { 'Content-Type': 'application/json' };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 45000);
    let res;
    try {
      res = await fetchImpl(`${opts.baseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
      });
    } catch (e) {
      throw new LlmError(e.name === 'AbortError' ? 'LLM: таймаут запроса' : `LLM: сеть недоступна (${e.message})`);
    } finally { clearTimeout(timer); }

    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message || msg; } catch { /* keep raw */ }
      throw new LlmError(`LLM HTTP ${res.status}: ${msg}`);
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new LlmError('LLM: ответ не JSON'); }
    const choice = data.choices && data.choices[0];
    if (!choice || !choice.message) throw new LlmError('LLM: пустой ответ');
    return { message: choice.message, usage: data.usage || null, finishReason: choice.finish_reason };
  }

  return { chat, opts };
}

module.exports = { createLlmClient, LlmError };
