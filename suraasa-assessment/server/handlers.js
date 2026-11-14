import {
  AppError, rand, hashCode, newCode, safeEqual, signToken, readToken, chainOf, chainAdd,
} from './auth.js';
import { LlmError, DEFAULT_MODELS } from './llm.js';
import { encode, decode } from './store.js';
import { SEED_PERSONAS, DEFAULT_TEMPLATE, SEED_KNOWLEDGE, DEFAULT_CONFIG, TRAINING_PERSONAS, TRAINING_TEMPLATE, SETTER_RUBRIC } from './seed.js';
import { teacherMessages, teacherLiveSystem, cleanReply, evaluatorMessages, parseJson } from './prompts.js';
import { LIVE_WS, LIVE_VOICES, voiceFor } from './live.js';
import { buildReport, reportForCandidate, validateTemplate, RECOMMENDATIONS } from './rubric.js';

const HOUR = 3600000;
const REC_MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4'];
const recName = (sid, n) => `${sid}.${String(n).padStart(3, '0')}.part`;
const STAFF = ['super_admin', 'recruiter'];
const iso = (ms) => new Date(ms).toISOString();
const s = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
const email = (v) => s(v, 120).toLowerCase();
const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
const int = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const words = (t) => String(t).trim().split(/\s+/).filter(Boolean).length;
const flat = (row) => ({ ...(row.data || {}), id: row.id, name: row.name, difficulty: row.difficulty, active: row.active });
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, created_at: u.created_at, last_login: u.last_login });
const publicPersona = (q) => ({ id: q.id, name: q.name, label: q.label, difficulty: q.difficulty, gender: q.gender, subject: q.subject, school_type: q.school_type, experience: q.experience, public_bio: q.public_bio, language: q.language });

const fails = new Map(); // sign-in throttle, per server instance

function audit(user, action, target = '', detail = '', now) {
  return { op: 'append', tab: 'AuditLog', row: { id: 'a_' + rand(12), at: iso(now), actor_id: user?.id || 'anon', actor_role: user?.role || '', action, target: s(target, 120), detail: s(detail, 500) } };
}

function configOf(rows) {
  const out = { ...DEFAULT_CONFIG };
  for (const r of rows) if (r.id in out) out[r.id] = r.value;
  return out;
}

/**
 * Puts the Setter Evaluation Rubric on the two built-in templates, once. Runs the first time a Super Admin opens the site
 * after the rubric changes. Other settings on those templates are kept, calls already scored keep their old version,
 * and templates the team made themselves are left alone.
 */
function rubricOps(d, user, now) {
  if (!d.Templates.length || configOf(d.Config).rubric === SETTER_RUBRIC.id) return [];
  const ops = [];
  for (const t of d.Templates) {
    if (t.id !== DEFAULT_TEMPLATE.id && t.id !== TRAINING_TEMPLATE.id) continue;
    const data = { ...t.data, duration_min: Math.max(Number(t.data.duration_min) || 0, 15), thresholds: SETTER_RUBRIC.thresholds, bands: SETTER_RUBRIC.bands, parameters: SETTER_RUBRIC.parameters };
    if (JSON.stringify(data) === JSON.stringify(t.data)) continue;
    ops.push({ op: 'update', tab: 'Templates', id: t.id, patch: { version: t.version + 1, data, updated_at: iso(now), updated_by: user.id } });
  }
  const value = SETTER_RUBRIC.id;
  ops.push(d.Config.some((r) => r.id === 'rubric')
    ? { op: 'update', tab: 'Config', id: 'rubric', patch: { value, updated_at: iso(now), updated_by: user.id } }
    : { op: 'append', tab: 'Config', row: { id: 'rubric', value, updated_at: iso(now), updated_by: user.id } });
  ops.push(audit(user, 'rubric.update', value, `${ops.length - 1} template(s) moved to the Setter Evaluation Rubric`, now));
  return ops;
}

function modelsFor(cfg, tier) {
  const custom = cfg[tier + '_models'];
  return Array.isArray(custom) && custom.length ? custom.map((m) => s(m, 80)).filter(Boolean) : DEFAULT_MODELS[tier];
}

/** Attempts used, and whether another call may start. Voided, empty and dropped calls do not use an attempt. */
/** The calendar day in India for a time, as YYYY-MM-DD. Practice limits reset at midnight IST. */
const istDay = (ms) => new Date(ms + 5.5 * HOUR).toISOString().slice(0, 10);

/**
 * Attempts used, and whether another call may start. Voided, empty and dropped calls do not use an attempt.
 * A practice assignment (intern training) has no total limit, only a number of calls per day.
 */
export function attemptState(assignment, sessions, now) {
  let mine = sessions.filter((x) => x.assignment_id === assignment.id);
  const practice = assignment.persona_mode === 'practice';
  const allowed = assignment.attempts; // for practice, this is the number of calls allowed per day
  if (practice) { const today = istDay(now); mine = mine.filter((x) => istDay(Date.parse(x.started_at)) === today); }
  const used = mine.filter((x) => !x.voided && ['ended', 'scored'].includes(x.status)).length;
  const starts = mine.filter((x) => !x.voided).length;
  const left = Math.max(0, allowed - used);
  const expired = assignment.due && Date.parse(assignment.due + 'T23:59:59+05:30') < now;
  let blocked = null;
  if (assignment.status !== 'open') blocked = practice ? 'Your practice access is closed.' : 'This assessment is closed.';
  else if (expired) blocked = practice ? 'Your practice period has ended. Contact your trainer.' : 'The last date for this assessment has passed. Contact your recruiter.';
  else if (left <= 0) blocked = practice ? 'You have used all your practice calls for today. Come back tomorrow.' : 'You have used all your attempts.';
  else if (starts >= allowed + (practice ? 4 : 2)) blocked = practice ? 'Too many calls were started today without finishing. Try again tomorrow, or contact your trainer.' : 'This call has been started too many times without finishing. Contact your recruiter.';
  return { used, left, starts, blocked, allowed };
}

/**
 * Every tab an action needs, so they can all be fetched in ONE request to the Google Sheet instead of two to six.
 * Each request to the Sheet takes about a second, so this is where most waiting on a page comes from.
 */
const PRELOAD = {
  adminHome: ['Candidates', 'Assignments', 'Sessions', 'Personas', 'Templates', 'Knowledge', 'Decisions', 'Config'],
  myHome: ['Candidates', 'Assignments', 'Sessions', 'Personas', 'Templates', 'Config'],
  startCall: ['Candidates', 'Assignments', 'Sessions', 'Personas', 'Templates', 'Config'],
  endCall: ['Sessions', 'Templates'],
  score: ['Sessions', 'Candidates', 'Personas', 'Templates', 'Knowledge', 'Config'],
  getSession: ['Sessions', 'Candidates', 'Personas', 'Templates', 'Decisions'],
  getRecordingPart: ['Sessions', 'Candidates'],
  saveRecording: ['Sessions'],
  saveCandidate: ['Candidates'], setCandidateStatus: ['Candidates'], deleteCandidate: ['Candidates', 'Sessions'], resetCode: ['Candidates'],
  saveAssignment: ['Candidates', 'Templates', 'Personas', 'Assignments'], cancelAssignment: ['Candidates', 'Assignments'],
  decide: ['Sessions', 'Candidates'], humanReview: ['Sessions', 'Candidates', 'Templates'], voidSession: ['Sessions', 'Candidates'],
  savePersona: ['Personas'], saveTemplate: ['Templates', 'Config'], saveKnowledge: ['Knowledge'], saveConfig: ['Config'], installTraining: ['Personas', 'Templates'],
  audit: ['AuditLog'],
};
// During a call the teacher and settings cannot change in a way that matters, so replies never wait on the Sheet for them.
const IN_CALL = { turn: ['Personas', 'Config'], liveToken: ['Personas'], putRecordingPart: ['Config'] };

/**
 * The store as seen by one request. A tab already fetched fresh in this request is not fetched again, and a write
 * to a tab forgets it, so nothing stale is ever used after a change.
 */
function requestStore(store) {
  const seen = new Map();
  // A change is also made to this request's own copy of the tab, exactly as the Sheet will store it, so the
  // updated lists can be sent back with the reply instead of being fetched from the Sheet a second time.
  const same = (tab, row) => decode(tab, encode(tab, row));
  function apply(o) {
    const hit = seen.get(o.tab);
    if (!hit) return;
    if (!hit.fresh || !['append', 'update', 'remove', 'removeWhere'].includes(o.op)) { seen.delete(o.tab); return; }
    if (o.op === 'append') hit.rows = hit.rows.concat([same(o.tab, o.row)]);
    else if (o.op === 'update') hit.rows = hit.rows.map((r) => (r.id === o.id ? decode(o.tab, { ...encode(o.tab, r), ...encode(o.tab, o.patch), id: r.id }) : r));
    else if (o.op === 'remove') hit.rows = hit.rows.filter((r) => r.id !== o.id);
    else hit.rows = hit.rows.filter((r) => String(r[o.field] ?? '') !== String(o.value));
  }
  return {
    ...store,
    async read(tabs, opts = {}) {
      const need = tabs.filter((t) => !seen.has(t) || (opts.fresh && !seen.get(t).fresh));
      if (need.length) {
        const d = await store.read(need, opts);
        for (const t of need) seen.set(t, { rows: d[t], fresh: !!opts.fresh });
      }
      return Object.fromEntries(tabs.map((t) => [t, seen.get(t).rows]));
    },
    async write(ops) {
      await store.write(ops); // if the Sheet refuses the change, this request's copy is left as it was
      for (const o of ops) apply(o);
    },
  };
}

const HOME_TABS = ['Candidates', 'Assignments', 'Sessions', 'Personas', 'Templates', 'Knowledge', 'Decisions', 'Config', 'Users'];
// After one of these, the recruiter's lists have changed. The reply carries the updated lists, so the page does not ask again.
const CHANGES_HOME = ['saveCandidate', 'setCandidateStatus', 'deleteCandidate', 'saveAssignment', 'cancelAssignment', 'decide', 'humanReview', 'voidSession',
  'savePersona', 'saveTemplate', 'saveKnowledge', 'saveUser', 'saveConfig', 'installTraining', 'score'];

/** Everything a recruiter or admin is allowed to see, built from tabs already in hand. */
function adminView(d, user, deps) {
  const isAdmin = user.role === 'super_admin';
  const candidates = d.Candidates.filter((cand) => isAdmin || (user.role === 'recruiter' && cand.recruiter_id === user.id));
  const ids = new Set(candidates.map((c) => c.id));
  const cfg = configOf(d.Config);
  return {
    ok: true, user: publicUser(user),
    candidates,
    assignments: d.Assignments.filter((a) => ids.has(a.candidate_id)),
    sessions: d.Sessions.filter((x) => ids.has(x.candidate_id)),
    decisions: d.Decisions.filter((x) => ids.has(x.candidate_id)),
    personas: d.Personas.map(flat),
    templates: d.Templates,
    knowledge: d.Knowledge,
    users: isAdmin ? d.Users.map(publicUser) : d.Users.filter((u) => u.role !== 'candidate').map((u) => ({ id: u.id, name: u.name, role: u.role })),
    config: isAdmin ? { ...cfg, default_models: DEFAULT_MODELS } : { recruiters_edit_templates: cfg.recruiters_edit_templates, review_every: cfg.review_every },
    status: { sheet: true, ai: !!deps.configured?.ai, live: !!deps.live },
  };
}

/** A candidate's or intern's own home page. Null when their candidate record is missing. */
function candidateView(d, user, deps, now) {
  const me = d.Candidates.find((c) => c.user_id === user.id);
  if (!me) return null;
  const personas = d.Personas.map(flat);
  const mySessions = d.Sessions.filter((x) => x.candidate_id === me.id);
  const assignments = d.Assignments.filter((a) => a.candidate_id === me.id && a.status !== 'cancelled').map((a) => {
    const tpl = d.Templates.find((t) => t.id === a.template_id);
    const st = attemptState(a, mySessions, now);
    const ids = a.persona_ids || [];
    return {
      id: a.id, status: a.status, due: a.due, duration_min: a.duration_min, attempts: a.attempts, allow_typed: a.allow_typed, practice: a.persona_mode === 'practice',
      persona_mode: a.persona_mode, used: st.used, left: st.left, blocked: st.blocked,
      min_turns: tpl?.data?.min_turns || 4,
      // A randomly assigned teacher stays hidden until the phone is answered.
      personas: a.persona_mode === 'random' ? [] : personas.filter((q) => ids.includes(q.id) && q.active).map(publicPersona),
    };
  });
  const sessions = mySessions.filter((x) => x.status !== 'in_progress').map((x) => {
    const a = d.Assignments.find((q) => q.id === x.assignment_id);
    const tpl = d.Templates.find((t) => t.id === x.template_id);
    const policy = tpl?.data?.candidate_feedback || 'none';
    const show = policy !== 'none' && x.status === 'scored' && !x.voided;
    return {
      id: x.id, assignment_id: a?.id, started_at: x.started_at, duration_sec: x.duration_sec, status: x.status, voided: x.voided, practice: a?.persona_mode === 'practice',
      scores: show && a?.persona_mode === 'practice' ? x.scores || null : null,
      persona_name: personas.find((q) => q.id === x.persona_id)?.name || 'Teacher',
      total: show ? x.total : null, category: show ? x.category : null, feedback: show,
    };
  }).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  // Where earlier attempts are switched off, only the latest attempt of each assessment shows feedback.
  const seenA = new Set();
  for (const x of sessions) {
    const tpl = d.Templates.find((t) => t.id === mySessions.find((y) => y.id === x.id)?.template_id);
    if (seenA.has(x.assignment_id) && tpl?.data?.show_previous === false) { x.total = null; x.category = null; x.feedback = false; }
    seenA.add(x.assignment_id);
  }
  const cfg = configOf(d.Config);
  const liveOn = !!deps.live && cfg.voice_engine !== 'browser';
  return { ok: true, candidate: { id: me.id, code: me.code, name: me.name, role_applied: me.role_applied }, assignments, sessions, live: liveOn, record: liveOn && !!cfg.record_audio };
}

export async function handle(body, deps) {
  const { llm, secret } = deps;
  const store = requestStore(deps.store);
  const now = deps.now ? deps.now() : Date.now();
  const action = String(body?.action || '');

  /* ------------------------------------------------------------ public */

  if (action === 'status') {
    return { ok: true, sheet: !!deps.configured?.sheet, ai: !!deps.configured?.ai, live: !!deps.live };
  }

  if (action === 'signIn') {
    const mail = email(body.email);
    const f = fails.get(mail);
    if (f && f.until > now) throw new AppError('throttled', 'Too many wrong codes. Wait a few minutes and try again.', 429);
    // One request to the Sheet brings the sign-in check and everything the first page needs, so the page after
    // signing in appears without asking the Sheet again.
    const d = await store.read(HOME_TABS, { fresh: true });
    const { Users } = d;
    if (!Users.some((u) => u.role === 'super_admin' && u.active)) {
      throw new AppError('no_admin', 'Nobody has been set up yet. In the Google Sheet, click Setter Assessment > Create first Super Admin.', 403);
    }
    const user = Users.find((u) => u.email.toLowerCase() === mail && u.active);
    const good = user && user.code_hash && safeEqual(user.code_hash, hashCode(secret, mail, body.code));
    if (!good) {
      const n = (f?.n || 0) + 1;
      fails.set(mail, { n, until: n >= 5 ? now + 10 * 60000 : 0 });
      await store.write([audit(null, 'signin.failed', mail, '', now)]).catch(() => {});
      throw new AppError('bad_code', 'That email and access code do not match. Check both and try again.', 401);
    }
    fails.delete(mail);
    await store.write([
      { op: 'update', tab: 'Users', id: user.id, patch: { last_login: iso(now) } },
      audit(user, 'signin', user.email, '', now),
      ...(user.role === 'super_admin' ? rubricOps(d, user, now) : []),
    ]);
    const after = await store.read(HOME_TABS, { fresh: true }); // served from this request's own copy, not the Sheet
    const me = after.Users.find((u) => u.id === user.id);
    let home = null;
    if (me.role === 'candidate') home = candidateView(after, me, deps, now);
    // The very first admin sign-in still has teachers and the rubric to create, so it loads the dashboard the usual way.
    else if (after.Personas.length && after.Templates.length && after.Knowledge.length) home = adminView(after, me, deps);
    return { ok: true, token: signToken(secret, 'session', { uid: user.id, role: user.role, exp: now + 12 * HOUR }), user: publicUser(me), home };
  }

  /* ------------------------------------------------------------ signed in */

  const claim = readToken(secret, 'session', body.token, now);
  if (!claim) throw new AppError('signed_out', 'Please sign in again.', 401);
  // One request to the Sheet brings the sign-in check and everything this action will read.
  const carryHome = !!body.with_home && STAFF.includes(claim.role) && CHANGES_HOME.includes(action);
  // A report's pieces are named by the call id, so they can be fetched at the same moment as the permission check
  // instead of after it. Nothing is returned unless the check passes.
  let early = null;
  if (action === 'getSession') {
    const sid = s(body.session_id, 40);
    const staff = STAFF.includes(claim.role);
    early = Promise.all([
      deps.store.getBlob('Reports', sid).catch(() => null),
      staff ? deps.store.getBlob('Transcripts', sid).catch(() => null) : null,
      staff ? deps.store.write([audit({ id: claim.uid, role: claim.role }, 'report.view', sid, '', now)]).catch(() => {}) : null,
    ]);
  }
  if (carryHome) await store.read(HOME_TABS, { fresh: true });
  else if (PRELOAD[action]) await store.read(['Users', ...PRELOAD[action]], { fresh: true });
  else if (IN_CALL[action]) await store.read(['Users', ...IN_CALL[action]], { maxAgeMs: 120000 });
  const { Users } = await store.read(['Users']);
  const user = Users.find((u) => u.id === claim.uid && u.active);
  if (!user || user.role !== claim.role) throw new AppError('signed_out', 'Please sign in again.', 401);
  const isStaff = STAFF.includes(user.role);
  const isAdmin = user.role === 'super_admin';
  const staffOnly = () => { if (!isStaff) throw new AppError('forbidden', 'You do not have access to that.', 403); };
  const adminOnly = () => { if (!isAdmin) throw new AppError('forbidden', 'Only a Super Admin can do that.', 403); };
  const canSee = (cand) => isAdmin || (user.role === 'recruiter' && cand.recruiter_id === user.id);
  const log = (act, target, detail) => audit(user, act, target, detail, now);

  async function seedIfEmpty() {
    const d = await store.read(['Personas', 'Templates', 'Knowledge']);
    const ops = [];
    if (!d.Personas.length) for (const q of SEED_PERSONAS) { const { id, name, difficulty, ...data } = q; ops.push({ op: 'append', tab: 'Personas', row: { id, active: true, name, difficulty, data, updated_at: iso(now), updated_by: 'setup' } }); }
    if (!d.Templates.length) ops.push({ op: 'append', tab: 'Templates', row: { ...DEFAULT_TEMPLATE, updated_at: iso(now), updated_by: 'setup' } });
    if (!d.Knowledge.length) for (const k of SEED_KNOWLEDGE) ops.push({ op: 'append', tab: 'Knowledge', row: { ...k, updated_at: iso(now), updated_by: 'setup' } });
    if (ops.length) { ops.push(log('setup.seed', '', `${ops.length} starter rows`)); await store.write(ops); }
  }

  async function sessionFor(id) {
    const d = await store.read(['Sessions', 'Candidates'], { fresh: true });
    const session = d.Sessions.find((x) => x.id === id);
    if (!session) throw new AppError('not_found', 'That call was not found.', 404);
    const cand = d.Candidates.find((c) => c.id === session.candidate_id);
    if (!cand) throw new AppError('not_found', 'That candidate was not found.', 404);
    const own = user.role === 'candidate' && cand.user_id === user.id;
    if (!own && !canSee(cand)) throw new AppError('forbidden', 'You do not have access to that call.', 403);
    return { session, cand, own };
  }

  const result = await (async () => { switch (action) {
    case 'me':
      return { ok: true, user: publicUser(user) };

    /* -------------------------------------------------------- candidate */

    case 'myHome': {
      if (user.role !== 'candidate') throw new AppError('forbidden', 'This page is for candidates.', 403);
      const d = await store.read(['Candidates', 'Assignments', 'Sessions', 'Personas', 'Templates', 'Config'], { fresh: true });
      const view = candidateView(d, user, deps, now);
      if (!view) throw new AppError('not_found', 'Your candidate record is missing. Contact your recruiter.', 404);
      return view;
    }

    case 'startCall': {
      if (user.role !== 'candidate') throw new AppError('forbidden', 'Only candidates can start an assessment call.', 403);
      const d = await store.read(['Candidates', 'Assignments', 'Sessions', 'Personas', 'Templates', 'Config'], { fresh: true });
      const me = d.Candidates.find((c) => c.user_id === user.id && c.status === 'active');
      const a = me && d.Assignments.find((q) => q.id === body.assignment_id && q.candidate_id === me.id);
      if (!a) throw new AppError('not_found', 'That assessment was not found.', 404);
      const tpl = d.Templates.find((t) => t.id === a.template_id);
      if (!tpl) throw new AppError('not_found', 'The assessment template is missing. Contact your recruiter.', 404);
      const st = attemptState(a, d.Sessions, now);
      if (st.blocked) throw new AppError('blocked', st.blocked, 403);
      const liveOn = !!deps.live && configOf(d.Config).voice_engine !== 'browser';
      const mode = body.mode === 'typed' && a.allow_typed ? 'typed' : body.mode === 'live' && liveOn ? 'live' : 'voice';
      const active = d.Personas.filter((q) => q.active).map(flat);
      const pool = (a.persona_ids || []).length ? active.filter((q) => a.persona_ids.includes(q.id)) : active;
      if (!pool.length) throw new AppError('no_teacher', 'No teacher is available for this assessment. Contact your recruiter.', 409);
      let persona;
      if (a.persona_mode === 'choice' || a.persona_mode === 'practice') persona = pool.find((q) => q.id === body.persona_id);
      else if (a.persona_mode === 'random') persona = pool[Math.floor((deps.random || Math.random)() * pool.length)];
      else persona = pool[0];
      if (!persona) throw new AppError('bad_choice', 'Choose one of the teachers offered.', 400);
      const level = a.level || persona.level || 2;
      const greetings = persona.greeting?.length ? persona.greeting : ['Hello?'];
      const first = { r: 't', x: greetings[Math.floor((deps.random || Math.random)() * greetings.length)], t: 0 };
      const sid = 's_' + rand(12);
      // Dropped calls from earlier are closed off so they do not hang as "in progress".
      const stale = d.Sessions.filter((x) => x.assignment_id === a.id && x.status === 'in_progress');
      await store.write([
        ...stale.map((x) => ({ op: 'update', tab: 'Sessions', id: x.id, patch: { status: 'abandoned', ended_at: iso(now), end_reason: 'restarted' } })),
        { op: 'append', tab: 'Sessions', row: { id: sid, assignment_id: a.id, candidate_id: me.id, persona_id: persona.id, template_id: tpl.id, template_version: tpl.version, level, mode, lang: s(body.lang, 10) || 'en-IN', started_at: iso(now), status: 'in_progress', voided: false, purged: false } },
        log('call.start', sid, `${me.code} with ${persona.name}`),
      ]);
      const durSec = a.duration_min * 60;
      const callToken = signToken(secret, 'call', { sid, uid: user.id, pid: persona.id, aid: a.id, lvl: level, start: now, dur: durSec, mode, pr: a.persona_mode === 'practice' ? 1 : 0, exp: now + (durSec + 20 * 60) * 1000 });
      return {
        ok: true, session_id: sid, callToken, persona: publicPersona(persona), items: [first], chain: chainOf(secret, sid, [first]),
        duration_sec: durSec, min_turns: tpl.data.min_turns, interrupt_after_sec: persona.interrupt_after_sec || 0, started_at: now, mode,
        hangup_after: persona.do_not_call ? 3 : 4,
        record: mode === 'live' && !!configOf(d.Config).record_audio,
      };
    }

    case 'turn': {
      const call = readToken(secret, 'call', body.callToken, now);
      if (!call || call.uid !== user.id) throw new AppError('call_expired', 'This call has expired. Start a new one from your dashboard.', 410);
      const items = cleanItems(body.items);
      if (!safeEqual(chainOf(secret, call.sid, items), String(body.chain || ''))) throw new AppError('bad_transcript', 'The call could not be continued because its record did not match. Start a new call.', 409);
      const text = s(body.text, 1500);
      if (!text) throw new AppError('empty', 'Nothing was heard.', 400);
      if (items.length >= 240) throw new AppError('too_long', 'This call has reached its maximum length.', 409);
      const elapsed = Math.round((now - call.start) / 1000);
      const d = await store.read(['Personas', 'Config']);
      const row = d.Personas.find((q) => q.id === call.pid);
      if (!row) throw new AppError('no_teacher', 'The teacher for this call is no longer available.', 409);
      const persona = flat(row);
      const cItem = { r: 'c', x: text, t: now - call.start };
      let reply;
      const overtime = elapsed > call.dur + 90;
      if (overtime) {
        reply = { text: persona.language === 'en' ? 'I really have to go now. Thank you, bye.' : 'मुझे अब जाना होगा। धन्यवाद, बाय।', ended: true };
      } else {
        const out = await llm.chat({
          models: modelsFor(configOf(d.Config), 'teacher'),
          messages: teacherMessages(persona, items, text, { level: call.lvl, durationMin: Math.round(call.dur / 60), elapsedSec: elapsed, interrupt: !!body.interrupt }),
          maxTokens: 500, temperature: 0.8,
        });
        reply = cleanReply(out.text, persona);
        // A teacher may not hang up before the candidate has had a fair chance to speak.
        const said = items.filter((it) => it.r === 'c').length + 1;
        if (reply.ended && said < (persona.do_not_call ? 3 : 4)) reply.ended = false;
        if (elapsed >= call.dur - 5) reply.ended = true;
      }
      const tItem = { r: 't', x: reply.text, t: (deps.now ? deps.now() : Date.now()) - call.start };
      let chain = chainAdd(secret, String(body.chain), cItem);
      chain = chainAdd(secret, chain, tItem);
      return { ok: true, items: [cItem, tItem], chain, ended: !!reply.ended };
    }

    case 'liveToken': {
      const call = readToken(secret, 'call', body.callToken, now);
      if (!call || call.uid !== user.id) throw new AppError('call_expired', 'This call has expired. Start a new one from your dashboard.', 410);
      if (call.mode !== 'live' || !deps.live) throw new AppError('live_off', 'Live voice is not switched on for this call.', 409);
      const remaining = call.dur - Math.round((now - call.start) / 1000);
      if (remaining < 15) throw new AppError('call_expired', 'This call has run out of time.', 410);
      const d = await store.read(['Personas']);
      const row = d.Personas.find((q) => q.id === call.pid);
      if (!row) throw new AppError('no_teacher', 'The teacher for this call is no longer available.', 409);
      const persona = flat(row);
      const history = cleanItems(body.items).slice(-60).map((it) => ({ r: it.r, x: s(it.x, 600) })).filter((it) => it.x);
      const greeting = (persona.greeting || []).includes(body.greeting) ? body.greeting : persona.greeting?.[0];
      const out = await deps.live.mint({
        system: teacherLiveSystem(persona, { level: call.lvl, durationMin: Math.round(call.dur / 60), greeting, history, quiet: !!body.quiet }),
        voice: voiceFor(persona), ttlSec: remaining + 180, modelIndex: int(body.model_index, 0, 9, 0),
      });
      return { ok: true, token: out.token, model: out.model, model_index: out.modelIndex, url: LIVE_WS };
    }

    case 'putRecordingPart': {
      // One piece of the call audio, sent by the caller's browser after the call. The call token proves whose call it is.
      const call = readToken(secret, 'call', body.callToken, now);
      if (!call || call.uid !== user.id) throw new AppError('call_expired', 'This call has expired.', 410);
      if (call.mode !== 'live') throw new AppError('invalid', 'Only live voice calls are recorded.', 400);
      const d = await store.read(['Config']);
      if (!configOf(d.Config).record_audio) throw new AppError('recording_off', 'Call recording is switched off.', 409);
      const n = Math.round(Number(body.n));
      const data = typeof body.data === 'string' ? body.data : '';
      if (!(n >= 0 && n < 60) || data.length < 4 || data.length > 520000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new AppError('invalid', 'That piece of the recording could not be read.', 400);
      await store.putFile(recName(call.sid, n), data, 'application/octet-stream');
      return { ok: true };
    }

    case 'saveRecording': {
      const call = readToken(secret, 'call', body.callToken, now);
      if (!call || call.uid !== user.id) throw new AppError('call_expired', 'This call has expired.', 410);
      const d = await store.read(['Sessions'], { fresh: true });
      const session = d.Sessions.find((x) => x.id === call.sid);
      if (!session || session.status === 'in_progress') throw new AppError('invalid', 'The call must be saved before its recording.', 409);
      const mime = REC_MIMES.find((m) => String(body.mime || '').toLowerCase().startsWith(m));
      const parts = int(body.parts, 1, 60, 0);
      if (!mime || !parts) throw new AppError('invalid', 'The recording details were not understood.', 400);
      await store.write([
        { op: 'update', tab: 'Sessions', id: session.id, patch: { tech: { ...(session.tech || {}), recording: { parts, mime, bytes: int(body.bytes, 0, 60 * 400000, 0) } } } },
        log('call.recording', session.id, `${parts} parts`),
      ]);
      return { ok: true };
    }

    case 'getRecordingPart': {
      const { session, own } = await sessionFor(s(body.session_id, 40));
      // An intern may listen to their own practice calls. A hiring candidate never gets the recording.
      if (own && !session.flags?.practice) throw new AppError('forbidden', 'You do not have access to that recording.', 403);
      const rec = session.tech?.recording;
      const n = Math.round(Number(body.n));
      if (!rec || session.purged || !(n >= 0 && n < rec.parts)) throw new AppError('not_found', 'There is no recording for this call.', 404);
      const data = await store.getFile(recName(session.id, n));
      if (!data) throw new AppError('not_found', 'Part of this recording is missing from Google Drive.', 404);
      if (n === 0 && !own) await store.write([log('recording.listen', session.id, '')]).catch(() => {});
      return { ok: true, data, mime: rec.mime, parts: rec.parts };
    }

    case 'endCall': {
      const call = readToken(secret, 'call', body.callToken, now);
      if (!call || call.uid !== user.id) throw new AppError('call_expired', 'This call has expired.', 410);
      let items = cleanItems(body.items);
      const verified = safeEqual(chainOf(secret, call.sid, items), String(body.chain || ''));
      // A live voice call is transcribed by Google straight to the browser, so the server cannot sign each turn.
      // It is accepted, tidied, and marked so the report says the transcript was not verified.
      if (!verified && call.mode !== 'live') throw new AppError('bad_transcript', 'The call record did not match, so it could not be saved.', 409);
      if (!verified) {
        let last = 0;
        items = items.map((it) => { last = Math.max(last, Math.min((call.dur + 120) * 1000, Math.max(0, it.t))); return { r: it.r, x: s(it.x, 1500), t: last }; }).filter((it) => it.x);
      }
      const d = await store.read(['Sessions', 'Templates'], { fresh: true });
      const session = d.Sessions.find((x) => x.id === call.sid);
      if (!session) throw new AppError('not_found', 'That call was not found.', 404);
      if (session.status !== 'in_progress') return { ok: true, session_id: session.id, status: session.status };
      const tpl = d.Templates.find((t) => t.id === session.template_id);
      const minTurns = tpl?.data?.min_turns || 4;
      const cand = items.filter((it) => it.r === 'c');
      const nWords = cand.reduce((a, it) => a + words(it.x), 0);
      const lastT = items.length ? items[items.length - 1].t : 0;
      const duration = Math.max(0, Math.min(call.dur + 120, Math.round(Math.max(lastT, Math.min(now - call.start, lastT + 60000)) / 1000)));
      const m = body.meta || {};
      const tech = {
        stt_errors: int(m.stt_errors, 0, 999, 0), reconnects: int(m.reconnects, 0, 999, 0), interruptions: int(m.interruptions, 0, 999, 0),
        low_confidence: int(m.low_confidence, 0, 999, 0), // A live voice call reports no confidence at all (null). Number(null) is 0, which used to flag every live call as a technical problem.
        avg_confidence: m.avg_confidence !== null && m.avg_confidence !== undefined && m.avg_confidence !== '' && Number.isFinite(Number(m.avg_confidence)) ? Math.round(Number(m.avg_confidence) * 100) / 100 : null,
        browser: s(m.browser, 120), headset: !!m.headset, muted_sec: int(m.muted_sec, 0, 9999, 0),
      };
      // Long silences between the teacher finishing and the candidate's next words are recorded for the recruiter.
      let gaps = 0;
      for (let i = 1; i < items.length; i++) if (items[i].r === 'c' && items[i].t - items[i - 1].t > 120000) gaps++;
      const techFlag = tech.reconnects >= 3 || tech.stt_errors >= 4 || (tech.avg_confidence !== null && tech.avg_confidence < 0.6 && cand.length >= 3);
      const tooShort = cand.length < minTurns || nWords < 40;
      const status = tooShort ? 'incomplete' : 'ended';
      const reason = ['candidate', 'teacher', 'time', 'connection'].includes(body.reason) ? body.reason : 'candidate';
      await store.write([
        { op: 'putBlob', tab: 'Transcripts', key: session.id, value: { items, saved_at: iso(now) } },
        { op: 'update', tab: 'Sessions', id: session.id, patch: { ended_at: iso(now), duration_sec: duration, status, end_reason: reason, candidate_turns: cand.length, candidate_words: nWords, tech, flags: { tech: techFlag, long_gaps: gaps, short: tooShort, unverified: !verified, practice: !!call.pr } } },
        log('call.end', session.id, `${status}, ${cand.length} turns, ${duration}s`),
      ]);
      return { ok: true, session_id: session.id, status, min_turns: minTurns };
    }

    case 'score': {
      const { session, cand, own } = await sessionFor(s(body.session_id, 40));
      if (session.status === 'scored' && !(body.force && isStaff)) return { ok: true, status: 'scored' };
      if (!['ended', 'scored'].includes(session.status)) return { ok: true, status: session.status };
      if (session.purged) throw new AppError('purged', 'The transcript for this call has been deleted under the retention setting, so it cannot be scored again.', 409);
      if (own && session.status !== 'ended') return { ok: true, status: session.status };
      const d = await store.read(['Personas', 'Templates', 'Knowledge', 'Config']);
      const tpl = d.Templates.find((t) => t.id === session.template_id);
      const personas = d.Personas.map(flat);
      const persona = personas.find((q) => q.id === session.persona_id);
      const transcript = await store.getBlob('Transcripts', session.id);
      if (!tpl || !persona || !transcript) throw new AppError('not_found', 'The transcript, teacher or template for this call is missing.', 404);
      const facts = d.Knowledge.filter((k) => k.status === 'verified').map((k) => k.fact);
      const techNote = session.flags?.tech ? `Speech recognition was unreliable on this call (${session.tech?.stt_errors || 0} errors, ${session.tech?.reconnects || 0} reconnections). Be careful not to blame the candidate for garbled words.` : '';
      const messages = evaluatorMessages({ items: transcript.items, persona, template: tpl, level: session.level, facts, personas: personas.filter((q) => q.active && q.id !== persona.id), tech: techNote, durationSec: session.duration_sec || 0, practice: !!session.flags?.practice });
      let out;
      let raw = null;
      try {
        for (let attempt = 0; attempt < 2 && !raw; attempt++) {
          out = await llm.chat({ models: modelsFor(configOf(d.Config), 'evaluator'), messages, json: true, maxTokens: 6000, temperature: 0 });
          raw = parseJson(out.text);
          if (raw && !raw.parameters) raw = null;
        }
      } catch (e) {
        if (e instanceof LlmError && e.kind === 'rate') return { ok: true, status: 'ended', pending: true, retry_after: Math.min(120, e.retryAfter || 30) };
        throw e;
      }
      if (!raw) throw new AppError('bad_evaluation', 'The AI did not return a usable assessment. Try scoring again.', 502);
      const report = buildReport({
        raw, items: transcript.items, template: tpl, personas: personas.filter((q) => q.id !== persona.id),
        meta: {
          session_id: session.id, candidate_id: cand.id, candidate_name: cand.name, candidate_code: cand.code, role_applied: cand.role_applied,
          persona_id: persona.id, persona_name: persona.name, persona_label: persona.label || '', difficulty: persona.difficulty, level: session.level,
          started_at: session.started_at, duration_sec: session.duration_sec, mode: session.mode, end_reason: session.end_reason,
          template_name: tpl.name, template_version: tpl.version, model: out.model, scored_at: iso(now),
          practice: !!session.flags?.practice, facts_used: facts.length, tech_flag: !!session.flags?.tech, tech: session.tech, long_gaps: session.flags?.long_gaps || 0, unverified: !!session.flags?.unverified,
        },
      });
      await store.write([
        { op: 'putBlob', tab: 'Reports', key: session.id, value: report },
        { op: 'update', tab: 'Sessions', id: session.id, patch: {
          status: 'scored', total: report.total, percent: report.percent, category: report.category, recommendation: (report.training || report.hiring).recommendation,
          scores: Object.fromEntries(report.params.map((q) => [q.key, q.marks])), coverage: report.coverage,
          flags: { ...(session.flags || {}), conduct: report.conduct.filter((c) => c.verified).length, inaccurate: report.product.claims.filter((c) => c.verdict === 'inaccurate').length },
          scored_at: iso(now), engine: { model: out.model, template_version: tpl.version },
        } },
        log(body.force ? 'call.rescore' : 'call.score', session.id, `${report.total}/100, ${(report.training || report.hiring).recommendation}`),
      ]);
      return { ok: true, status: 'scored' };
    }

    case 'getSession': {
      const { session, cand, own } = await sessionFor(s(body.session_id, 40));
      const d = await store.read(['Personas', 'Templates', 'Decisions', 'Users']);
      const tpl = d.Templates.find((t) => t.id === session.template_id);
      const persona = d.Personas.map(flat).find((q) => q.id === session.persona_id);
      // The report, the transcript and the audit note are independent, so they are fetched together, not one after another.
      const wantReport = session.status === 'scored' && !session.purged;
      const [earlyReport, earlyTranscript] = await early;
      const report = wantReport ? earlyReport : null;
      const transcriptBlob = !own && !session.purged ? earlyTranscript : null;
      if (own) {
        const policy = session.voided ? 'none' : tpl?.data?.candidate_feedback || 'none';
        return {
          ok: true, view: 'candidate',
          session: { id: session.id, status: session.status, started_at: session.started_at, duration_sec: session.duration_sec, voided: session.voided, candidate_turns: session.candidate_turns, min_turns: tpl?.data?.min_turns || 4, recording: session.flags?.practice && !session.purged ? session.tech?.recording || null : null },
          persona: persona ? publicPersona(persona) : null,
          report: reportForCandidate(report, policy), policy,
        };
      }
      const transcript = transcriptBlob;
      return {
        ok: true, view: 'staff', session, candidate: cand, persona: persona || null, template: tpl ? { id: tpl.id, name: tpl.name, version: tpl.version, data: tpl.data } : null,
        report, transcript: transcript?.items || null,
        decisions: d.Decisions.filter((x) => x.session_id === session.id).map((x) => ({ ...x, recruiter_name: d.Users.find((u) => u.id === x.recruiter_id)?.name || '' })),
      };
    }

    /* ------------------------------------------------------------ staff */

    case 'adminHome': {
      staffOnly();
      const tabs = ['Candidates', 'Assignments', 'Sessions', 'Personas', 'Templates', 'Knowledge', 'Decisions', 'Config', 'Users'];
      let d = await store.read(tabs, { fresh: true });
      if (isAdmin && (!d.Personas.length || !d.Templates.length || !d.Knowledge.length)) { await seedIfEmpty(); d = await store.read(tabs, { fresh: true }); }
      if (isAdmin) { const ops = rubricOps(d, user, now); if (ops.length) { await store.write(ops); d = await store.read(tabs, { fresh: true }); } }
      return adminView(d, user, deps);
    }

    case 'saveCandidate': {
      staffOnly();
      const d = await store.read(['Candidates', 'Users'], { fresh: true });
      const name = s(body.name, 80);
      const mail = email(body.email);
      if (!name || !isEmail(mail)) throw new AppError('invalid', 'A name and a valid email are needed.', 400);
      const fields = { name, email: mail, phone: s(body.phone, 20), role_applied: s(body.role_applied, 60) || 'Pre-Sales Intern', source: s(body.source, 80), notes: s(body.notes, 1000) };
      if (body.id) {
        const cand = d.Candidates.find((c) => c.id === body.id);
        if (!cand || !canSee(cand)) throw new AppError('not_found', 'That candidate was not found.', 404);
        if (mail !== cand.email && d.Users.some((u) => u.email.toLowerCase() === mail)) throw new AppError('duplicate', 'Someone already uses that email.', 409);
        const recruiter = isAdmin && body.recruiter_id && d.Users.some((u) => u.id === body.recruiter_id && STAFF.includes(u.role)) ? body.recruiter_id : cand.recruiter_id;
        const ops = [{ op: 'update', tab: 'Candidates', id: cand.id, patch: { ...fields, recruiter_id: recruiter } }];
        const patch = { name };
        let code = null;
        if (mail !== cand.email) { code = newCode(); patch.email = mail; patch.code_hash = hashCode(secret, mail, code); } // the code is tied to the email
        ops.push({ op: 'update', tab: 'Users', id: cand.user_id, patch }, log('candidate.update', cand.code, name));
        await store.write(ops);
        return { ok: true, id: cand.id, access_code: code };
      }
      if (d.Users.some((u) => u.email.toLowerCase() === mail)) throw new AppError('duplicate', 'Someone already uses that email.', 409);
      const uid = 'u_' + rand(12);
      const cid = 'c_' + rand(12);
      const taken = new Set(d.Candidates.map((c) => c.code));
      let n = d.Candidates.length + 1;
      while (taken.has('SUR-' + String(n).padStart(4, '0'))) n++;
      const code = newCode();
      const recruiter = isAdmin && body.recruiter_id && d.Users.some((u) => u.id === body.recruiter_id && STAFF.includes(u.role)) ? body.recruiter_id : user.id;
      await store.write([
        { op: 'append', tab: 'Users', row: { id: uid, email: mail, name, role: 'candidate', active: true, code_hash: hashCode(secret, mail, code), created_at: iso(now), created_by: user.id } },
        { op: 'append', tab: 'Candidates', row: { id: cid, user_id: uid, code: 'SUR-' + String(n).padStart(4, '0'), ...fields, recruiter_id: recruiter, status: 'active', created_at: iso(now), created_by: user.id } },
        log('candidate.create', 'SUR-' + String(n).padStart(4, '0'), name),
      ]);
      return { ok: true, id: cid, access_code: code };
    }

    case 'setCandidateStatus': {
      staffOnly();
      const d = await store.read(['Candidates'], { fresh: true });
      const cand = d.Candidates.find((c) => c.id === body.id);
      if (!cand || !canSee(cand)) throw new AppError('not_found', 'That candidate was not found.', 404);
      const status = body.status === 'archived' ? 'archived' : 'active';
      await store.write([
        { op: 'update', tab: 'Candidates', id: cand.id, patch: { status } },
        { op: 'update', tab: 'Users', id: cand.user_id, patch: { active: status === 'active' } },
        log('candidate.' + status, cand.code, ''),
      ]);
      return { ok: true };
    }

    case 'deleteCandidate': {
      adminOnly();
      const d = await store.read(['Candidates', 'Sessions'], { fresh: true });
      const cand = d.Candidates.find((c) => c.id === body.id);
      if (!cand) throw new AppError('not_found', 'That candidate was not found.', 404);
      const sessions = d.Sessions.filter((x) => x.candidate_id === cand.id);
      await store.write([
        ...sessions.flatMap((x) => [{ op: 'removeBlob', tab: 'Transcripts', key: x.id }, { op: 'removeBlob', tab: 'Reports', key: x.id }]),
        { op: 'removeWhere', tab: 'Sessions', field: 'candidate_id', value: cand.id },
        { op: 'removeWhere', tab: 'Assignments', field: 'candidate_id', value: cand.id },
        { op: 'removeWhere', tab: 'Decisions', field: 'candidate_id', value: cand.id },
        { op: 'remove', tab: 'Candidates', id: cand.id },
        { op: 'remove', tab: 'Users', id: cand.user_id },
        log('candidate.delete', cand.code, `${sessions.length} calls removed. Reason: ${s(body.reason, 200)}`),
      ]);
      for (const x of sessions) if (x.tech?.recording) await store.removeFiles(x.id); // recordings go to the Drive bin
      return { ok: true };
    }

    case 'resetCode': {
      staffOnly();
      const d = await store.read(['Users', 'Candidates'], { fresh: true });
      const target = d.Users.find((u) => u.id === body.user_id);
      const cand = target && d.Candidates.find((c) => c.user_id === target.id);
      if (!target || !(isAdmin || (cand && canSee(cand)))) throw new AppError('not_found', 'That person was not found.', 404);
      const code = newCode();
      await store.write([{ op: 'update', tab: 'Users', id: target.id, patch: { code_hash: hashCode(secret, target.email, code) } }, log('user.reset_code', target.email, '')]);
      return { ok: true, access_code: code };
    }

    case 'saveAssignment': {
      staffOnly();
      const d = await store.read(['Candidates', 'Templates', 'Personas', 'Assignments'], { fresh: true });
      const cand = d.Candidates.find((c) => c.id === body.candidate_id);
      if (!cand || !canSee(cand)) throw new AppError('not_found', 'That candidate was not found.', 404);
      const tpl = d.Templates.find((t) => t.id === body.template_id && t.active);
      if (!tpl) throw new AppError('invalid', 'Choose an assessment template.', 400);
      const practice = !!body.practice;
      // Practice (intern training): the intern picks any teacher on the list, as often as the daily limit allows.
      const mode = practice ? 'practice' : ['fixed', 'choice', 'random'].includes(body.persona_mode) ? body.persona_mode : 'random';
      const activeIds = d.Personas.filter((q) => q.active).map((q) => q.id);
      const ids = (Array.isArray(body.persona_ids) ? body.persona_ids : []).filter((id) => activeIds.includes(id)).slice(0, 30);
      if (practice && ids.length < 1) throw new AppError('invalid', 'Choose at least one teacher for the intern to practise with.', 400);
      if (!practice && mode === 'fixed' && ids.length !== 1) throw new AppError('invalid', 'Choose one teacher for a fixed assignment.', 400);
      if (!practice && mode === 'choice' && ids.length < 2) throw new AppError('invalid', 'Choose at least two teachers for the candidate to pick from.', 400);
      const due = /^\d{4}-\d{2}-\d{2}$/.test(body.due || '') ? body.due : '';
      const row = {
        candidate_id: cand.id, template_id: tpl.id, persona_mode: mode, persona_ids: ids, level: int(body.level, 0, 3, 0),
        duration_min: int(body.duration_min, 3, 20, tpl.data.duration_min),
        // For practice the attempts column holds the calls allowed per day, so no new Sheet column is needed.
        attempts: practice ? int(body.per_day, 1, 10, 3) : int(body.attempts, 1, 5, tpl.data.attempts), allow_typed: !!body.allow_typed, due, status: 'open',
      };
      if (body.id) {
        const cur = d.Assignments.find((a) => a.id === body.id && a.candidate_id === cand.id);
        if (!cur) throw new AppError('not_found', 'That assignment was not found.', 404);
        await store.write([{ op: 'update', tab: 'Assignments', id: cur.id, patch: row }, log('assignment.update', cur.id, cand.code)]);
        return { ok: true, id: cur.id };
      }
      const id = 'as_' + rand(12);
      await store.write([{ op: 'append', tab: 'Assignments', row: { id, ...row, created_at: iso(now), created_by: user.id } }, log('assignment.create', id, cand.code)]);
      return { ok: true, id };
    }

    case 'cancelAssignment': {
      staffOnly();
      const d = await store.read(['Candidates', 'Assignments'], { fresh: true });
      const a = d.Assignments.find((x) => x.id === body.id);
      const cand = a && d.Candidates.find((c) => c.id === a.candidate_id);
      if (!a || !cand || !canSee(cand)) throw new AppError('not_found', 'That assignment was not found.', 404);
      await store.write([{ op: 'update', tab: 'Assignments', id: a.id, patch: { status: 'cancelled' } }, log('assignment.cancel', a.id, cand.code)]);
      return { ok: true };
    }

    case 'decide': {
      staffOnly();
      const { session, cand } = await sessionFor(s(body.session_id, 40));
      if (!RECOMMENDATIONS.includes(body.decision)) throw new AppError('invalid', 'Choose a recommendation.', 400);
      const reason = s(body.reason, 1000);
      if (session.recommendation && body.decision !== session.recommendation && reason.length < 15) throw new AppError('reason_needed', 'You are changing the AI recommendation. Give a reason of at least 15 characters.', 400);
      const id = 'd_' + rand(12);
      await store.write([
        { op: 'append', tab: 'Decisions', row: { id, candidate_id: cand.id, session_id: session.id, recruiter_id: user.id, decision: body.decision, ai_recommendation: session.recommendation || '', reason, at: iso(now) } },
        log(session.recommendation && body.decision !== session.recommendation ? 'decision.override' : 'decision.submit', session.id, `${cand.code}: ${body.decision}`),
      ]);
      return { ok: true, id };
    }

    case 'humanReview': {
      staffOnly();
      const { session } = await sessionFor(s(body.session_id, 40));
      const d = await store.read(['Templates']);
      const tpl = d.Templates.find((t) => t.id === session.template_id);
      if (!tpl || session.status !== 'scored') throw new AppError('invalid', 'Only scored calls can be reviewed.', 400);
      const scores = {};
      for (const q of tpl.data.parameters) {
        const v = Number(body.scores?.[q.key]);
        if (!Number.isFinite(v) || v < 0 || v > q.max) throw new AppError('invalid', `Give ${q.name} a mark between 0 and ${q.max}.`, 400);
        scores[q.key] = Math.round(v * 2) / 2;
      }
      const total = Object.values(scores).reduce((a, b) => a + b, 0);
      await store.write([
        { op: 'update', tab: 'Sessions', id: session.id, patch: { human: { by: user.id, by_name: user.name, at: iso(now), scores, total, note: s(body.note, 800) } } },
        log('review.human', session.id, `human ${total}, AI ${session.total}`),
      ]);
      return { ok: true };
    }

    case 'voidSession': {
      staffOnly();
      const { session, cand } = await sessionFor(s(body.session_id, 40));
      const reason = s(body.reason, 300);
      const voided = body.voided !== false;
      if (voided && reason.length < 5) throw new AppError('reason_needed', 'Say why this attempt should not count.', 400);
      await store.write([{ op: 'update', tab: 'Sessions', id: session.id, patch: { voided, void_reason: voided ? reason : '' } }, log(voided ? 'call.void' : 'call.unvoid', session.id, `${cand.code}: ${reason}`)]);
      return { ok: true };
    }

    case 'savePersona': {
      adminOnly();
      const q = body.persona || {};
      const name = s(q.name, 60);
      if (!name) throw new AppError('invalid', 'The teacher needs a name.', 400);
      const arr = (v, n, max) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => s(x, max)).filter(Boolean).slice(0, n);
      const difficulty = ['Easy', 'Medium', 'Hard'].includes(q.difficulty) ? q.difficulty : 'Medium';
      const data = {
        label: s(q.label, 60), level: int(q.level, 1, 3, 2), gender: q.gender === 'male' ? 'male' : 'female',
        age_range: s(q.age_range, 30), experience: s(q.experience, 60), subject: s(q.subject, 100), school_type: s(q.school_type, 120),
        public_bio: s(q.public_bio, 300), personality: s(q.personality, 500), style: s(q.style, 400),
        english: ['fluent', 'moderate', 'basic'].includes(q.english) ? q.english : 'fluent',
        language: ['en', 'hinglish', 'hi', 'mirror'].includes(q.language) ? q.language : 'en',
        interest: int(q.interest, 1, 10, 5), pain_points: arr(q.pain_points, 6, 250), objections: arr(q.objections, 8, 200),
        decision: s(q.decision, 500), behaviour: s(q.behaviour, 900), greeting: arr(q.greeting, 4, 120),
        eval_focus: s(q.eval_focus, 250), prior_knowledge: s(q.prior_knowledge, 300) || 'Has heard the name Suraasa but knows no details.',
        do_not_call: !!q.do_not_call, interrupt_after_sec: int(q.interrupt_after_sec, 0, 90, 0),
      };
      if (!data.public_bio || !data.personality || !data.objections.length || !data.greeting.length) throw new AppError('invalid', 'Fill in the profile shown to candidates, the personality, at least one objection and at least one greeting.', 400);
      const d = await store.read(['Personas'], { fresh: true });
      const active = q.active !== false;
      if (q.id) {
        if (!d.Personas.some((x) => x.id === q.id)) throw new AppError('not_found', 'That teacher was not found.', 404);
        await store.write([{ op: 'update', tab: 'Personas', id: q.id, patch: { active, name, difficulty, data, updated_at: iso(now), updated_by: user.id } }, log('persona.update', q.id, name)]);
        return { ok: true, id: q.id };
      }
      const id = 'p_' + rand(8);
      await store.write([{ op: 'append', tab: 'Personas', row: { id, active, name, difficulty, data, updated_at: iso(now), updated_by: user.id } }, log('persona.create', id, name)]);
      return { ok: true, id };
    }

    case 'previewTurn': {
      staffOnly();
      const q = body.persona || {};
      if (!q.name || !q.personality) throw new AppError('invalid', 'Fill in the teacher before testing.', 400);
      const persona = { ...q, pain_points: q.pain_points || [], objections: q.objections || [], greeting: q.greeting || ['Hello?'] };
      const items = cleanItems(body.items).slice(-40);
      if (!items.length) return { ok: true, reply: persona.greeting[0] || 'Hello?', ended: false };
      const text = s(body.text, 1500);
      if (!text) throw new AppError('empty', 'Type what the caller says.', 400);
      const d = await store.read(['Config']);
      const out = await llm.chat({ models: modelsFor(configOf(d.Config), 'teacher'), messages: teacherMessages(persona, items, text, { level: int(body.level, 1, 3, persona.level || 2), durationMin: 8, elapsedSec: items.length * 12 }), maxTokens: 500, temperature: 0.8 });
      const reply = cleanReply(out.text, persona);
      const said = items.filter((it) => it.r === 'c').length + 1;
      if (reply.ended && said < (persona.do_not_call ? 3 : 4)) reply.ended = false;
      return { ok: true, reply: reply.text, ended: reply.ended, model: out.model };
    }

    case 'installTraining': {
      adminOnly();
      const d = await store.read(['Personas', 'Templates'], { fresh: true });
      const ops = [];
      for (const q of TRAINING_PERSONAS) {
        if (d.Personas.some((x) => x.id === q.id)) continue;
        const { id, name, difficulty, ...data } = q;
        ops.push({ op: 'append', tab: 'Personas', row: { id, active: true, name, difficulty, data, updated_at: iso(now), updated_by: user.id } });
      }
      const teachers = ops.length;
      const template = !d.Templates.some((t) => t.id === TRAINING_TEMPLATE.id);
      if (template) ops.push({ op: 'append', tab: 'Templates', row: { ...TRAINING_TEMPLATE, updated_at: iso(now), updated_by: user.id } });
      if (ops.length) await store.write([...ops, log('training.install', '', `${teachers} teachers${template ? ', rubric' : ''}`)]);
      return { ok: true, teachers, template, template_id: TRAINING_TEMPLATE.id, persona_ids: TRAINING_PERSONAS.map((q) => q.id) };
    }

    case 'saveTemplate': {
      staffOnly();
      const d = await store.read(['Templates', 'Config'], { fresh: true });
      if (!isAdmin && !configOf(d.Config).recruiters_edit_templates) throw new AppError('forbidden', 'Only a Super Admin can change evaluation criteria.', 403);
      const t = body.template || {};
      const name = s(t.name, 80);
      const data = {
        duration_min: Number(t.data?.duration_min), attempts: Number(t.data?.attempts), min_turns: Number(t.data?.min_turns),
        candidate_feedback: t.data?.candidate_feedback, show_previous: t.data?.show_previous !== false,
        thresholds: { strong: Number(t.data?.thresholds?.strong), recommended: Number(t.data?.thresholds?.recommended), borderline: Number(t.data?.thresholds?.borderline) },
        ...(Array.isArray(t.data?.bands) ? { bands: t.data.bands.slice(0, 4).map((b) => s(b, 60)) } : {}),
        parameters: (Array.isArray(t.data?.parameters) ? t.data.parameters : []).map((q) => ({
          key: s(q.key, 24), ...(s(q.group, 40) ? { group: s(q.group, 40) } : {}), name: s(q.name, 60), max: Number(q.max), guide: s(q.guide, 400),
          ...(Array.isArray(q.criteria) && q.criteria.length ? { criteria: q.criteria.slice(0, 8).map((c) => ({ key: s(c.key, 24), name: s(c.name, 60), max: Number(c.max), levels: s(c.levels, 600) })) } : {}),
        })),
      };
      const errors = validateTemplate(data);
      if (!name) errors.unshift('Give the template a name.');
      if (errors.length) throw new AppError('invalid', errors[0], 400, { errors });
      const active = t.active !== false;
      if (t.id) {
        const cur = d.Templates.find((x) => x.id === t.id);
        if (!cur) throw new AppError('not_found', 'That template was not found.', 404);
        // Past reports keep the version they were scored with; a change makes a new version for future calls.
        const changed = JSON.stringify(cur.data) !== JSON.stringify(data);
        await store.write([{ op: 'update', tab: 'Templates', id: cur.id, patch: { active, name, version: cur.version + (changed ? 1 : 0), data, updated_at: iso(now), updated_by: user.id } }, log('template.update', cur.id, name)]);
        return { ok: true, id: cur.id };
      }
      const id = 't_' + rand(8);
      await store.write([{ op: 'append', tab: 'Templates', row: { id, active, name, version: 1, data, updated_at: iso(now), updated_by: user.id } }, log('template.create', id, name)]);
      return { ok: true, id };
    }

    case 'saveKnowledge': {
      staffOnly();
      const k = body.item || {};
      const d = await store.read(['Knowledge'], { fresh: true });
      if (body.remove) {
        adminOnly();
        await store.write([{ op: 'remove', tab: 'Knowledge', id: s(k.id, 40) }, log('knowledge.delete', s(k.id, 40), '')]);
        return { ok: true };
      }
      const row = { topic: s(k.topic, 60), fact: s(k.fact, 500), source: s(k.source, 300), status: ['verified', 'unverified', 'rejected'].includes(k.status) ? k.status : 'unverified', updated_at: iso(now), updated_by: user.id };
      if (!row.topic || !row.fact) throw new AppError('invalid', 'A topic and a fact are needed.', 400);
      if (k.id) {
        const cur = d.Knowledge.find((x) => x.id === k.id);
        if (!cur) throw new AppError('not_found', 'That fact was not found.', 404);
        // Changing the wording of an approved fact sends it back for approval unless it is approved again in the same step.
        await store.write([{ op: 'update', tab: 'Knowledge', id: cur.id, patch: row }, log('knowledge.' + row.status, cur.id, row.topic)]);
        return { ok: true, id: cur.id };
      }
      const id = 'k_' + rand(8);
      await store.write([{ op: 'append', tab: 'Knowledge', row: { id, ...row } }, log('knowledge.create', id, row.topic)]);
      return { ok: true, id };
    }

    case 'saveUser': {
      adminOnly();
      const d = await store.read(['Users'], { fresh: true });
      const name = s(body.name, 80);
      const mail = email(body.email);
      const role = STAFF.includes(body.role) ? body.role : 'recruiter';
      if (body.id) {
        const cur = d.Users.find((u) => u.id === body.id && u.role !== 'candidate');
        if (!cur) throw new AppError('not_found', 'That person was not found.', 404);
        const active = body.active !== false;
        const admins = d.Users.filter((u) => u.role === 'super_admin' && u.active && u.id !== cur.id).length;
        if (cur.role === 'super_admin' && (!active || role !== 'super_admin') && admins === 0) throw new AppError('last_admin', 'There must be at least one active Super Admin.', 409);
        if (cur.id === user.id && (!active || role !== cur.role)) throw new AppError('self', 'You cannot change your own role or switch yourself off.', 409);
        await store.write([{ op: 'update', tab: 'Users', id: cur.id, patch: { name: name || cur.name, role, active } }, log('user.update', cur.email, `${role}, ${active ? 'active' : 'off'}`)]);
        return { ok: true, id: cur.id };
      }
      if (!name || !isEmail(mail)) throw new AppError('invalid', 'A name and a valid email are needed.', 400);
      if (d.Users.some((u) => u.email.toLowerCase() === mail)) throw new AppError('duplicate', 'Someone already uses that email.', 409);
      const id = 'u_' + rand(12);
      const code = newCode();
      await store.write([{ op: 'append', tab: 'Users', row: { id, email: mail, name, role, active: true, code_hash: hashCode(secret, mail, code), created_at: iso(now), created_by: user.id } }, log('user.create', mail, role)]);
      return { ok: true, id, access_code: code };
    }

    case 'saveConfig': {
      adminOnly();
      const c = body.config || {};
      const d = await store.read(['Config'], { fresh: true });
      const models = (v) => { const xs = (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => s(x, 80)).filter((x) => /^[\w./:-]+$/.test(x)).slice(0, 5); return xs.length ? xs : null; };
      const next = {
        retention_days: int(c.retention_days, 0, 3650, 0),
        recruiters_edit_templates: !!c.recruiters_edit_templates,
        review_every: int(c.review_every, 1, 50, 5),
        teacher_models: models(c.teacher_models),
        evaluator_models: models(c.evaluator_models),
        voice_engine: c.voice_engine === 'browser' ? 'browser' : 'auto',
        record_audio: !!c.record_audio,
      };
      // Recording needs the newer Sheet script. Better to say so now than to lose recordings silently later.
      if (next.record_audio && !configOf(d.Config).record_audio && !(await store.filesReady())) throw new AppError('recording_setup', 'Call recording needs the latest Google Sheet script. Paste the new apps-script/Code.gs into Apps Script, deploy it as a new version, then switch this on again.', 409);
      const ops = Object.entries(next).map(([id, value]) => (d.Config.some((r) => r.id === id)
        ? { op: 'update', tab: 'Config', id, patch: { value, updated_at: iso(now), updated_by: user.id } }
        : { op: 'append', tab: 'Config', row: { id, value, updated_at: iso(now), updated_by: user.id } }));
      await store.write([...ops, log('config.update', '', JSON.stringify(next))]);
      return { ok: true };
    }

    case 'aiTest': {
      adminOnly();
      const d = await store.read(['Config']);
      const cfg = configOf(d.Config);
      const available = await llm.listModels();
      const check = (tier) => modelsFor(cfg, tier).map((m) => ({ model: m, available: available.includes(m) }));
      let live = { configured: !!deps.live };
      if (deps.live) {
        try { const t = await deps.live.mint({ system: 'Say hello.', voice: LIVE_VOICES.female, ttlSec: 60 }); live = { configured: true, ok: true, model: t.model }; }
        catch (e) { live = { configured: true, ok: false, error: e.message }; }
      }
      return { ok: true, teacher: check('teacher'), evaluator: check('evaluator'), count: available.length, all: available.slice().sort(), live };
    }

    case 'audit': {
      adminOnly();
      const d = await store.read(['AuditLog', 'Users'], { fresh: true });
      const names = Object.fromEntries(d.Users.map((u) => [u.id, u.name]));
      return { ok: true, rows: d.AuditLog.slice(-400).reverse().map((r) => ({ ...r, actor: names[r.actor_id] || r.actor_id })) };
    }

    default:
      throw new AppError('unknown', 'Unknown request.', 400);
  } })();
  if (carryHome && result?.ok) {
    const d = await store.read(HOME_TABS, { fresh: true }); // this request's own, already updated copy
    const self = d.Users.find((u) => u.id === user.id) || user;
    result.home = adminView(d, self, deps);
  }
  return result;
}

function cleanItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 400).map((it) => ({ r: it?.r === 't' ? 't' : 'c', x: String(it?.x ?? ''), t: Number(it?.t) || 0 }));
}
