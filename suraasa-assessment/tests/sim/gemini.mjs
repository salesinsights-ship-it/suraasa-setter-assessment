/** A stand-in for Google's token endpoint, so the real server/live.js runs unchanged in tests. */
export function makeFakeGemini() {
  const state = { mode: 'ok', calls: [] };
  const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
  async function fetchImpl(url, opts) {
    const body = JSON.parse(opts.body);
    state.calls.push({ url, key: opts.headers['x-goog-api-key'], body });
    const model = body.bidiGenerateContentSetup?.model || body.liveConnectConstraints?.model;
    if (state.mode === 'auth') return reply(403, { error: { message: 'API key not valid' } });
    if (state.mode === 'rate') return reply(429, { error: { message: 'Quota exceeded' } });
    if (state.mode === 'down') return reply(400, { error: { message: 'Live API is not enabled' } });
    if (state.mode === 'second-form' && body.bidiGenerateContentSetup) return reply(400, { error: { message: 'Unknown field bidiGenerateContentSetup' } });
    // A model that does not know the "patient listening" settings refuses any request that carries them.
    if (state.mode === 'no-patient' && JSON.stringify(body).includes('START_SENSITIVITY_LOW')) return reply(400, { error: { message: 'Unknown name "startOfSpeechSensitivity"' } });
    if (state.mode === 'model-gone' && model === 'models/gemini-3.8-live') return reply(404, { error: { message: 'Model not found' } });
    return reply(200, { name: 'auth_tokens/test-' + state.calls.length });
  }
  return { fetchImpl, state };
}
