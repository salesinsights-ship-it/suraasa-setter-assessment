import {
  AppError, rand, hashCode, newCode, safeEqual, signToken, readToken, chainOf, chainAdd,
} from './auth.js';
import { LlmError, DEFAULT_MODELS } from './llm.js';
import { SEED_PERSONAS, DEFAULT_TEMPLATE, SEED_KNOWLEDGE, DEFAULT_CONFIG } from './seed.js';
import { teacherMessages, teacherLiveSystem, cleanReply, evaluatorMessages, parseJson } from './prompts.js';
import { LIVE_WS, LIVE_VOICES } from './live.js';
import { buildReport, reportForCandidate, validateTemplate, RECOMMENDATIONS } from './rubric.js';

const HOUR = 3600000;
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

function modelsFor(cfg, tier) {
  const custom = cfg[tier + '_models'];
  return Array.isArray(custom) && custom.length ? custom.map((m) => s(m, 80)).filter(Boolean) : DEFAULT_MODELS[tier];
}

/** Attempts used, and whether another call may start. Voided, empty and dropped calls do not use an attempt. */
export function attemptState(assignment, sessions, now) {
  const mine = sessions.filter((x) => x.assignment_id === assignment.id);
  const used = mine.filter((x) => !x.voided && ['ended', 'scored'].includes(x.status)).length;
  const starts = mine.filter((x) => !x.voided).length;
  const left = Math.max(0, assignment.attempts - used);
  const expired = assignment.due && Date.parse(assignment.due + 'T23:59:59+05:30') < now;
  let blocked = null;
  if (assignment.status !== 'open') blocked = 'This assessment is closed.';
  else if (expired) blocked = 'The last date for this assessment has passed. Contact your recruiter.';
  else if (left <= 0) blocked = 'You have used all your attempts.';
  else if (starts >= assignment.attempts + 2) blocked = 'This call has been started too many times without finishing. Contact your recruiter.';
  return { used, left, starts, blocked };
}

export async function handle(body, deps) {
  const { store, llm, secret } = deps;
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
    const { Users } = await store.read(['Users'], { fresh: true });
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
    ]);
    return { ok: true, token: signToken(secret, 'session', { uid: user.id, role: user.role, exp: now + 12 * HOUR }), user: publicUser(user) };
  }

  /* ------------------------------------------------------------ signed in */

  const claim = readToken(secret, 'session', body.token, now);
  if (!claim) throw new AppError('signed_out', 'Please sign in again.', 401);
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

  switch (action) {
    case 'me':
      return { ok: true, user: publicUser(user) };

    /* -------------------------------------------------------- candidate */

    case 'myHome': {
      if (user.role !== 'candidate') throw new AppError('forbidden', 'This page is for candidates.', 403);
      const d = await store.read(['Candidates', 'Assignments', 'Sessions', 'Personas', 'Templates', 'Config'], { fresh: true });
      const me = d.Candidates.find((c) => c.user_id === user.id);
      if (!me) throw new AppError('not_found', 'Your candidate record is missing. Contact your recruiter.', 404);
      const personas = d.Personas.map(flat);
      const mySessions = d.Sessions.filter((x) => x.candidate_id === me.id);
      const assignments = d.Assignments.filter((a) => a.candidate_id === me.id && a.status !== 'cancelled').map((a) => {
        const tpl = d.Templates.find((t) => t.id === a.template_id);
        const st = attemptState(a, mySessions, now);
        const ids = a.persona_ids || [];
        return {
          id: a.id, status: a.status, due: a.due, duration_min: a.duration_min, attempts: a.attempts, allow_typed: a.allow_typed,
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
          id: x.id, assignment_id: a?.id, started_at: x.started_at, duration_sec: x.duration_sec, status: x.status, voided: x.voided,
          persona_name: personas.find((q) => q.id === x.persona_id)?.name || 'Teacher',
          total: show ? x.total : null, category: show ? x.category : null, feedback: show,
        };
      }).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
      // Where earlier attempts are switched off, only the latest attempt of each assessment shows feedback.
      const seen = new Set();
      for (const x of sessions) {
        const tpl = d.Templates.find((t) => t.id === mySessions.find((y) => y.id === x.id)?.template_id);
        if (seen.has(x.assignment_id) && tpl?.data?.show_previous === false) { x.total = null; x.category = null; x.feedback = false; }
        seen.add(x.assignment_id);
      }
      return { ok: true, candidate: { id: me.id, code: me.code, name: me.name, role_applied: me.role_applied }, assignments, sessions, live: !!deps.live && configOf(d.Config).voice_engine !== 'browser' };
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
      if (a.persona_mode === 'choice') persona = pool.find((q) => q.id === body.persona_id);
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
      const callToken = signToken(secret, 'call', { sid, uid: user.id, pid: persona.id, aid: a.id, lvl: level, start: now, dur: durSec, mode, exp: now + (durSec + 20 * 60) * 1000 });
      return {
        ok: true, session_id: sid, callToken, persona: publicPersona(persona), items: [first], chain: chainOf(secret, sid, [first]),
        duration_sec: durSec, min_turns: tpl.data.min_turns, interrupt_after_sec: persona.interrupt_after_sec || 0, started_at: now, mode,
        hangup_after: persona.do_not_call ? 3 : 4,
      };
    }

    case 'turn': {
      const call = readToken(secret, 'call', body.callToken, now);
      if (!call || call.uid !== user.id) throw new AppError('call_expired', 'This call has expired. Start a new one from your dashboard.', 410);
      const items = cleanItems(body.items);
      if (!safeEqual(chainOf(secret, call.sid, items), String(body.chain || ''))) throw new AppError('bad_transcript', 'The call could not be continued because its record did not match. Start a new call.', 409);
      const text = s(body.text, 1500);
      if (!text) throw new AppError('empty', 'Nothing was heard.', 400);
      if (items.length >= 120) throw new AppError('too_long', 'This call has reached its maximum length.', 409);
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
        system: teacherLiveSystem(persona, { level: call.lvl, durationMin: Math.round(call.dur / 60), greeting, history }),
        voice: LIVE_VOICES[persona.gender] || LIVE_VOICES.female, ttlSec: remaining + 180, modelIndex: int(body.model_index, 0, 9, 0),
      });
      return { ok: true, token: out.token, model: out.model, model_index: out.modelIndex, url: LIVE_WS };
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
        low_confidence: int(m.low_confidence, 0, 999, 0), avg_confidence: Number.isFinite(Number(m.avg_confidence)) ? Math.round(Number(m.avg_confidence) * 100) / 100 : null,
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
        { op: 'update', tab: 'Sessions', id: session.id, patch: { ended_at: iso(now), duration_sec: duration, status, end_reason: reason, candidate_turns: cand.length, candidate_words: nWords, tech, flags: { tech: techFlag, long_gaps: gaps, short: tooShort, unverified: !verified } } },
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
      const messages = evaluatorMessages({ items: transcript.items, persona, template: tpl, level: session.level, facts, personas: personas.filter((q) => q.active && q.id !== persona.id), tech: techNote, durationSec: session.duration_sec || 0 });
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
          facts_used: facts.length, tech_flag: !!session.flags?.tech, tech: session.tech, long_gaps: session.flags?.long_gaps || 0, unverified: !!session.flags?.unverified,
        },
      });
      await store.write([
        { op: 'putBlob', tab: 'Reports', key: session.id, value: report },
        { op: 'update', tab: 'Sessions', id: session.id, patch: {
          status: 'scored', total: report.total, percent: report.percent, category: report.category, recommendation: report.hiring.recommendation,
          scores: Object.fromEntries(report.params.map((q) => [q.key, q.marks])), coverage: report.coverage,
          flags: { ...(session.flags || {}), conduct: report.conduct.filter((c) => c.verified).length, inaccurate: report.product.claims.filter((c) => c.verdict === 'inaccurate').length },
          scored_at: iso(now), engine: { model: out.model, template_version: tpl.version },
        } },
        log(body.force ? 'call.rescore' : 'call.score', session.id, `${report.total}/100, ${report.hiring.recommendation}`),
      ]);
      return { ok: true, status: 'scored' };
    }

    case 'getSession': {
      const { session, cand, own } = await sessionFor(s(body.session_id, 40));
      const d = await store.read(['Personas', 'Templates', 'Decisions', 'Users']);
      const tpl = d.Templates.find((t) => t.id === session.template_id);
      const persona = d.Personas.map(flat).find((q) => q.id === session.persona_id);
      const report = session.status === 'scored' && !session.purged ? await store.getBlob('Reports', session.id) : null;
      if (own) {
        const policy = session.voided ? 'none' : tpl?.data?.candidate_feedback || 'none';
        return {
          ok: true, view: 'candidate',
          session: { id: session.id, status: session.status, started_at: session.started_at, duration_sec: session.duration_sec, voided: session.voided, candidate_turns: session.candidate_turns, min_turns: tpl?.data?.min_turns || 4 },
          persona: persona ? publicPersona(persona) : null,
          report: reportForCandidate(report, policy), policy,
        };
      }
      const transcript = session.purged ? null : await store.getBlob('Transcripts', session.id);
      await store.write([log('report.view', session.id, cand.code)]).catch(() => {});
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
      const candidates = d.Candidates.filter(canSee);
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
      const mode = ['fixed', 'choice', 'random'].includes(body.persona_mode) ? body.persona_mode : 'random';
      const activeIds = d.Personas.filter((q) => q.active).map((q) => q.id);
      const ids = (Array.isArray(body.persona_ids) ? body.persona_ids : []).filter((id) => activeIds.includes(id)).slice(0, 30);
      if (mode === 'fixed' && ids.length !== 1) throw new AppError('invalid', 'Choose one teacher for a fixed assignment.', 400);
      if (mode === 'choice' && ids.length < 2) throw new AppError('invalid', 'Choose at least two teachers for the candidate to pick from.', 400);
      const due = /^\d{4}-\d{2}-\d{2}$/.test(body.due || '') ? body.due : '';
      const row = {
        candidate_id: cand.id, template_id: tpl.id, persona_mode: mode, persona_ids: ids, level: int(body.level, 0, 3, 0),
        duration_min: int(body.duration_min, 3, 15, tpl.data.duration_min), attempts: int(body.attempts, 1, 5, tpl.data.attempts), allow_typed: !!body.allow_typed, due, status: 'open',
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
        parameters: (Array.isArray(t.data?.parameters) ? t.data.parameters : []).map((q) => ({ key: s(q.key, 24), name: s(q.name, 60), max: Number(q.max), guide: s(q.guide, 400) })),
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
      };
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
  }
}

function cleanItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).map((it) => ({ r: it?.r === 't' ? 't' : 'c', x: String(it?.x ?? ''), t: Number(it?.t) || 0 }));
}
