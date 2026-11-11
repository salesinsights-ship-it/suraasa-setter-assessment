/**
 * The only link to the AI provider. Swap this file to change provider:
 * anything that offers chat({ models, messages, json, maxTokens, temperature }) -> { text, model } will work.
 * Groq's API follows the OpenAI chat format, so most providers need only a new base URL.
 */

export class LlmError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // no_key | auth | rate | model | network | empty
    Object.assign(this, extra);
  }
}

export const DEFAULT_MODELS = {
  // Fast model for the teacher's replies, stronger one for scoring. Later entries are fallbacks.
  teacher: ['openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
  evaluator: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeGroq({ apiKey, fetchImpl = fetch, baseUrl = 'https://api.groq.com/openai/v1', maxWaitMs = 20000, wait = sleep }) {
  async function post(body) {
    let res;
    try {
      res = await fetchImpl(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new LlmError('network', 'The AI service could not be reached.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* handled below */ }
    return { res, data };
  }

  async function tryModel(model, { messages, json, maxTokens, temperature }) {
    const base = { model, messages, temperature, max_completion_tokens: maxTokens };
    // Reasoning models spend tokens thinking; keep that short and out of the reply.
    const extras = model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low', include_reasoning: false } : {};
    const variants = [
      { ...base, ...extras, ...(json ? { response_format: { type: 'json_object' } } : {}) },
      { ...base, ...(json ? { response_format: { type: 'json_object' } } : {}) },
      base,
    ];
    let waited = false;
    for (let i = 0; i < variants.length; i++) {
      const { res, data } = await post(variants[i]);
      if (res.ok) {
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text.trim()) return { text: text.trim(), model, usage: data.usage || null };
        throw new LlmError('empty', 'The AI returned an empty reply.');
      }
      const msg = data?.error?.message || ('HTTP ' + res.status);
      if (res.status === 401 || res.status === 403) throw new LlmError('auth', 'Groq rejected the API key.');
      if (res.status === 429) {
        const after = Number(res.headers?.get?.('retry-after')) || 0;
        if (!waited && after > 0 && after * 1000 <= maxWaitMs) { waited = true; await wait(after * 1000 + 250); i--; continue; }
        throw new LlmError('rate', 'The free AI limit was reached.', { retryAfter: after || 30 });
      }
      if (res.status === 404 || /decommission|does not exist|not found|no longer supported|not supported/i.test(msg)) {
        throw new LlmError('model', 'Model ' + model + ' is not available: ' + msg);
      }
      if (res.status === 400 && i < variants.length - 1) continue; // retry without the optional settings
      if (res.status >= 500) throw new LlmError('network', 'The AI service had a problem (' + res.status + ').');
      throw new LlmError('model', msg);
    }
    throw new LlmError('model', 'Model ' + model + ' rejected the request.');
  }

  async function chat({ models, messages, json = false, maxTokens = 500, temperature = 0.7 }) {
    if (!apiKey) throw new LlmError('no_key', 'The AI is not set up yet. Add GROQ_API_KEY in Vercel, then redeploy.');
    let last;
    for (const model of models) {
      try {
        return await tryModel(model, { messages, json, maxTokens, temperature });
      } catch (e) {
        last = e;
        // A missing model, an empty reply or a server error: try the next model. Key and rate problems stop here.
        if (!(e instanceof LlmError) || !['model', 'empty', 'network'].includes(e.kind)) throw e;
      }
    }
    throw last || new LlmError('model', 'No AI model is configured.');
  }

  async function listModels() {
    if (!apiKey) throw new LlmError('no_key', 'The AI is not set up yet. Add GROQ_API_KEY in Vercel, then redeploy.');
    let res;
    try { res = await fetchImpl(baseUrl + '/models', { headers: { Authorization: 'Bearer ' + apiKey } }); } catch {
      throw new LlmError('network', 'The AI service could not be reached.');
    }
    if (res.status === 401 || res.status === 403) throw new LlmError('auth', 'Groq rejected the API key.');
    const data = await res.json().catch(() => null);
    return (data?.data || []).map((m) => m.id);
  }

  return { chat, listModels };
}
