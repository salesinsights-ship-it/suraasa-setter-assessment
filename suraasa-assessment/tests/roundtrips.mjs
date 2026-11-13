/**
 * Counts how many times the server has to call the Google Sheet script for each common action.
 * Each call is a full round trip to Google (about a second in production), so this is the number that decides
 * how fast a page feels. Run: node tests/roundtrips.mjs
 */
import { makeWorld, playCall, GOOD_LINES } from './sim/world.mjs';

const w = makeWorld();
let n = 0;
const real = w.gas.fetchImpl;
const counting = async (...a) => { n++; return real(...a); };
// the store was built with the uncounted fetch, so wrap the simulator's entry point instead
const origRun = w.gas.run;
export async function measure() {
  const out = {};
  const { makeStore } = await import('../server/store.js');
  w.deps.store = makeStore({ url: 'sim://sheet', secret: w.gas.secret(), fetchImpl: counting, ttlMs: 15000, now: () => w.clock.t });
  const time = async (label, fn) => { w.clock.t += 60000; n = 0; const r = await fn(); out[label] = n; return r; };
  const admin = await time('Sign in', () => w.signIn(w.admin.email, w.admin.code));
  await time('Open the dashboard (first time, sets up teachers)', () => w.rpc('adminHome', {}, admin));
  await time('Open the dashboard', () => w.rpc('adminHome', {}, admin));
  const c = await time('Add a candidate', () => w.rpc('saveCandidate', { name: 'Rohan Verma', email: 'rohan@example.com' }, admin));
  const a = await time('Assign a mock call', () => w.rpc('saveAssignment', { candidate_id: c.id, template_id: 't_default', persona_mode: 'fixed', persona_ids: ['p01'], attempts: 2 }, admin));
  const cand = await w.signIn('rohan@example.com', c.access_code);
  await time('Candidate home page', () => w.rpc('myHome', {}, cand));
  const start = await time('Start a call', () => w.rpc('startCall', { assignment_id: a.id, lang: 'en-IN' }, cand));
  let items = start.items; let chain = start.chain;
  n = 0; let turns = 0;
  for (const text of GOOD_LINES) { w.clock.t += 20000; const r = await w.rpc('turn', { callToken: start.callToken, items, chain, text }, cand); items = items.concat(r.items); chain = r.chain; turns++; if (r.ended) break; }
  out['Each reply during a call (average)'] = Math.round((n / turns) * 10) / 10;
  await time('End a call', () => w.rpc('endCall', { callToken: start.callToken, items, chain, meta: {}, reason: 'candidate' }, cand));
  await time('Score a call', () => w.rpc('score', { session_id: start.session_id }, cand));
  await time('Candidate opens their result', () => w.rpc('getSession', { session_id: start.session_id }, cand));
  await time('Recruiter opens a report', () => w.rpc('getSession', { session_id: start.session_id }, admin));
  await time('Record a hiring decision', () => w.rpc('decide', { session_id: start.session_id, decision: 'Recommended', reason: '' }, admin));
  return out;
}
if (process.argv[1].endsWith('roundtrips.mjs')) console.log(JSON.stringify(await measure(), null, 1));
