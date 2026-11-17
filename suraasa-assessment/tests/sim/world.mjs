/** Builds a complete working system in memory: the real Sheet script, the real server, a stand-in AI. */
import { makeGas } from './gas.mjs';
import { makeFakeGroq } from './groq.mjs';
import { makeStore } from '../../server/store.js';
import { makeGroq } from '../../server/llm.js';
import { makeLive } from '../../server/live.js';
import { makeFakeGemini } from './gemini.mjs';
import { respond } from '../../api/rpc.js';

export function makeWorld({ admin = { name: 'Asha Admin', email: 'admin@suraasa.com' } } = {}) {
  const gas = makeGas();
  gas.run('setupSheet');
  gas.ui.prompts.push(admin.name, admin.email);
  gas.run('createFirstAdmin');
  const adminCode = gas.ui.alerts[gas.ui.alerts.length - 1].match(/Access code: (\S+)/)[1];
  const groq = makeFakeGroq();
  const clock = { t: Date.parse('2026-11-11T10:00:00Z') };
  // SHEET_DELAY_MS makes every request to the stand-in Sheet take that long, to measure how the site feels at Google's real speed.
  const delay = Number(process.env.SHEET_DELAY_MS) || 0;
  const sheetFetch = delay ? async (...a) => { await new Promise((r) => setTimeout(r, delay)); return gas.fetchImpl(...a); } : gas.fetchImpl;
  const store = makeStore({ url: 'sim://sheet', secret: gas.secret(), fetchImpl: sheetFetch, ttlMs: delay ? 15000 : 0 });
  const llm = makeGroq({ apiKey: 'test-key', fetchImpl: groq.fetchImpl, wait: async () => {} });
  const gemini = makeFakeGemini();
  const liveClient = makeLive({ apiKey: 'test-gemini-key', fetchImpl: gemini.fetchImpl });
  // Live voice is off unless a test switches it on, as it is on a site with no Gemini key.
  const deps = { store, llm, live: null, secret: gas.secret(), now: () => clock.t, random: () => 0, configured: { sheet: true, ai: true } };
  const enableLive = () => { deps.live = liveClient; };
  const rpc = async (action, payload = {}, token) => (await respond({ action, token, ...payload }, deps)).json;
  const raw = async (action, payload = {}, token) => respond({ action, token, ...payload }, deps);
  const signIn = async (email, code) => (await rpc('signIn', { email, code })).token;
  return { gas, groq, gemini, enableLive, clock, deps, rpc, raw, signIn, admin: { ...admin, code: adminCode } };
}

/** Plays a whole call as a candidate and returns the session id. */
export async function playCall(w, token, assignmentId, lines, { personaId, end = true, meta = {} } = {}) {
  const start = await w.rpc('startCall', { assignment_id: assignmentId, persona_id: personaId, lang: 'en-IN' }, token);
  if (!start.ok) return { start };
  let items = start.items;
  let chain = start.chain;
  for (const text of lines) {
    w.clock.t += 20000;
    const r = await w.rpc('turn', { callToken: start.callToken, items, chain, text }, token);
    if (!r.ok) return { start, error: r };
    items = items.concat(r.items);
    chain = r.chain;
    if (r.ended) break;
  }
  if (!end) return { start, items, chain };
  w.clock.t += 5000;
  const done = await w.rpc('endCall', { callToken: start.callToken, items, chain, meta, reason: 'candidate' }, token);
  return { start, items, chain, done, session_id: start.session_id };
}

export const GOOD_LINES = [
  'Hello ma\'am, this is Rohan calling from Suraasa. Is this a good time to speak for two minutes?',
  'Thank you. I understand you teach Maths for grades six to eight. May I ask what you would like to change in your career over the next year?',
  'That makes sense. Many teachers tell us the same thing. Our programme PgCTL takes ten to twelve months and is fully online.',
  'I understand time is tight. Would a short call with our counsellor tomorrow evening after four work for you?',
  'Wonderful, I will book that for tomorrow at five. Thank you for your time, goodbye.',
];
