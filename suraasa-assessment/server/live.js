import { AppError } from './auth.js';

/**
 * Live voice through the Gemini Live API. The server never carries audio. It only creates a short-lived,
 * single-use token whose settings (including the teacher's hidden instructions) are fixed on Google's side,
 * so the browser can open the audio connection without ever seeing the key or the instructions.
 * Swap this file, and src/live.js, to use a different live voice provider.
 */
export const LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
export const DEFAULT_LIVE_MODELS = ['gemini-3.8-live', 'gemini-3.1-flash-live-preview', 'gemini-2.5-flash-native-audio-preview-12-2025'];
export const LIVE_VOICES = { female: 'Kore', male: 'Charon' };

export function liveSetup({ model, system, voice }) {
  return {
    model: 'models/' + model,
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    systemInstruction: { parts: [{ text: system }] },
    tools: [{ functionDeclarations: [{
      name: 'end_call',
      description: 'Hang up the phone. Use it only after you have said goodbye, or when you are ending the call yourself.',
      parameters: { type: 'OBJECT', properties: { reason: { type: 'STRING', description: 'Why the call is ending, in a few words.' } } },
    }] }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 700 } },
  };
}

export function makeLive({ apiKey, fetchImpl = fetch, baseUrl = 'https://generativelanguage.googleapis.com/v1beta', models = DEFAULT_LIVE_MODELS, now = () => Date.now() }) {
  async function post(body) {
    let res;
    try {
      res = await fetchImpl(baseUrl + '/auth_tokens', { method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw new AppError('live_network', 'Google\'s live voice service could not be reached.', 502);
    }
    const data = await res.json().catch(() => null);
    return { res, data };
  }

  /** Creates a one-use token locked to this teacher. Tries each model in turn. */
  async function mint({ system, voice, ttlSec, modelIndex = 0 }) {
    const errors = [];
    for (let i = Math.max(0, modelIndex); i < models.length; i++) {
      const setup = liveSetup({ model: models[i], system, voice });
      const times = { uses: 1, expireTime: new Date(now() + ttlSec * 1000).toISOString(), newSessionExpireTime: new Date(now() + 90000).toISOString() };
      const { model, ...config } = setup;
      // Google documents two request shapes for the same thing. Both keep the settings on the server side.
      const bodies = [
        ['setup', { ...times, bidiGenerateContentSetup: setup }],
        ['constraints', { ...times, liveConnectConstraints: { model, config } }],
      ];
      for (const [form, body] of bodies) {
        // eslint-disable-next-line no-await-in-loop
        const { res, data } = await post(body);
        if (res.ok && data?.name) return { token: data.name, model: models[i], modelIndex: i, form };
        const msg = data?.error?.message || ('HTTP ' + res.status);
        if (res.status === 401 || res.status === 403) throw new AppError('live_auth', 'Google rejected the Gemini key: ' + msg, 502);
        if (res.status === 429) throw new AppError('live_rate', 'The free Gemini limit was reached. Try again in a minute.', 429);
        errors.push(`${models[i]} (${form}): ${msg}`);
      }
    }
    throw new AppError('live_failed', 'Live voice could not be started. ' + errors.slice(-2).join(' | '), 502);
  }

  return { mint, models };
}
