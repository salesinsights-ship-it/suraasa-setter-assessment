/**
 * Scoring rules. The AI only proposes levels, quotes and comments.
 * Every number, category and recommendation is worked out here, the same way for every candidate.
 */

export const RECOMMENDATIONS = ['Strongly Recommended', 'Recommended', 'Borderline', 'Not Recommended'];
/** The same four bands, worded for an intern in training instead of a hiring decision. */
export const TRAINING_RECOMMENDATIONS = ['Ready for live calls', 'Nearly ready', 'Needs more practice', 'Needs coaching'];
const CONDUCT_TYPES = ['pressure', 'misleading', 'ignored_do_not_call', 'disrespect', 'gaming'];
const VERDICTS = ['yes', 'partly', 'no'];

const OUTCOMES = ['booked', 'clean_disqualification', 'respectful_exit', 'pushed_after_refusal', 'no_next_step'];
const HANDOFF = ['held', 'partly', 'crossed'];

const str = (v, max = 400) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const half = (n) => Math.round(n * 2) / 2;

/**
 * Feedback that fits every call and so teaches nothing (the assessor's rule 2). The evaluator is told never to
 * write these; any sentence that still carries one is found by auditEvaluation and, failing that, removed here.
 */
export const GENERIC_FEEDBACK = [
  /\bimprove (?:the |their |his |her |overall )?rapport\b/i,
  /\bbuild (?:better|more|stronger) rapport\b/i,
  /\b(?:ask|asking|use|using) more open[- ]ended questions\b/i,
  /\b(?:work on|improve|practi[cs]e|show more|needs?) (?:his |her |their |more )?active listening\b/i,
  /\bgood energy\b/i,
  /\b(?:be|sound|appear|seem) more confident\b/i,
  /\bbuild (?:more|greater|better) trust\b/i,
  /\bhandle (?:the |her |his |their )?objections (?:better|more effectively)\b/i,
  /\b(?:could|should) have probed (?:deeper|more)\b/i,
  /\bprobe deeper\b/i,
];
export const genericIn = (text) => GENERIC_FEEDBACK.map((re) => String(text || '').match(re)?.[0]).filter(Boolean);

/** Removes every sentence that carries a generic phrase. Counts what it removed. */
function scrubber() {
  const state = { removed: 0 };
  const fb = (v, max = 400) => {
    const s = str(v, max);
    if (!s || !genericIn(s).length) return s;
    const kept = s.split(/(?<=[.!?])\s+/).filter((sentence) => {
      const bad = genericIn(sentence).length > 0;
      if (bad) state.removed++;
      return !bad;
    });
    return kept.join(' ').trim();
  };
  return { fb, state };
}

/** The parts of the Setter rubric that still apply when the teacher cannot be booked: the opening, the exit and how the caller behaved. */
export const EXIT_CRITERIA = { c1_opening: ['hook'], e3_closing: ['warmth'], professionalism: ['listening', 'tone', 'empathy', 'authority'] };
const isProfessionalism = (q) => q.key === 'professionalism' || /professionalism/i.test(q.group || '');

/**
 * Checks the evaluator's JSON against the rules the server can verify, before a report is built.
 * Returns plain-English problems; an empty list means it may be used as it is.
 */
export function auditEvaluation(raw, template, items, { all = false } = {}) {
  const problems = [];
  const turns = candidateTurns(items || []);
  const ps = template?.data?.parameters || [];
  for (const def of ps) {
    const r = raw?.parameters?.[def.key];
    if (!r) { problems.push(`Parameter "${def.key}" is missing.`); continue; }
    for (const c of def.criteria || []) {
      const e = r.criteria?.[c.key];
      if (e === undefined || e === null) { problems.push(`Criterion ${def.key}.${c.key} is missing.`); continue; }
      if (typeof e !== 'object') { problems.push(`Criterion ${def.key}.${c.key} must be an object with "points", "turn", "quote" and "absent", not a bare number (rule 1).`); continue; }
      const q = str(e.quote, 300);
      const pts = Number(e.points);
      if (!q && !str(e.absent)) problems.push(`Criterion ${def.key}.${c.key} has neither a quote nor a statement of what the caller never did (rule 1).`);
      else if (pts > 0 && !q) problems.push(`Criterion ${def.key}.${c.key} has ${pts} points but no quote (rule 1).`);
      else if (pts > 0 && verifyQuote(q, turns, e.turn) === null) problems.push(`The quote for ${def.key}.${c.key} ("${q.slice(0, 80)}") is not word for word from a C line (rule 1).`);
    }
  }
  const texts = [];
  for (const [k, r] of Object.entries(raw?.parameters || {})) for (const f of ['did_well', 'did_wrong', 'missed', 'improve']) texts.push([`${k}.${f}`, r?.[f]]);
  const rr = raw?.recommendations || {};
  for (const f of ['strengths', 'improvements', 'exercises']) (Array.isArray(rr[f]) ? rr[f] : []).forEach((x, i) => texts.push([`recommendations.${f}[${i}]`, x]));
  const a = raw?.analysis || {};
  for (const f of ['best_response', 'worst_response', 'best_objection_handled', 'unhandled_objection', 'understood_needs', 'value_communicated', 'next_step_secured']) texts.push([`analysis.${f}.why`, a[f]?.why]);
  texts.push(['outcome.why', raw?.outcome?.why], ['handoff.why', raw?.handoff?.why], ['rationale', raw?.rationale]);
  for (const [where, t] of texts) for (const phrase of genericIn(t)) problems.push(`${where} uses "${phrase}", which is true of every call. Say which question, at which turn, instead of what the caller said (rule 2).`);
  if (!str(rr.better_response?.try)) problems.push('recommendations.better_response.try is empty. Write the exact words the caller should have said at the weakest moment (rule 3).');
  if (!OUTCOMES.includes(raw?.outcome?.result)) problems.push(`outcome.result must be one of: ${OUTCOMES.join(', ')} (rule 6).`);
  if (!HANDOFF.includes(raw?.handoff?.verdict)) problems.push(`handoff.verdict must be one of: ${HANDOFF.join(', ')}.`);
  // Most important first, and a long run of the same rule-1 fault said once, so the repair request stays short.
  const rank = (x) => (/rule [36]\)|handoff/.test(x) ? 0 : /rule 2\)/.test(x) ? 1 : 2);
  const sorted = problems.sort((x, y) => rank(x) - rank(y));
  const ruleOne = sorted.filter((x) => rank(x) === 2);
  if (all || ruleOne.length <= 8) return sorted;
  return sorted.filter((x) => rank(x) < 2).concat(ruleOne.slice(0, 6), [`... and ${ruleOne.length - 6} more criteria with the same kind of fault (rule 1).`]);
}

/** Lowercase, punctuation removed. Works for English and Devanagari. */
export function norm(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
}

export function candidateTurns(items) {
  return items.filter((it) => it.r === 'c').map((it, i) => ({ n: i + 1, text: it.x, norm: norm(it.x) }));
}

/** A quote counts only if those words really appear in what the candidate said. */
export function verifyQuote(quote, turns, turnNo) {
  const q = norm(quote);
  if (q.split(' ').filter(Boolean).length < 3) return null;
  const hinted = turns.find((t) => t.n === Number(turnNo));
  if (hinted && hinted.norm.includes(q)) return hinted.n;
  const any = turns.find((t) => t.norm.includes(q));
  return any ? any.n : null;
}

export function validateTemplate(data) {
  const errors = [];
  const ps = Array.isArray(data?.parameters) ? data.parameters : [];
  if (ps.length < 3 || ps.length > 15) errors.push('Use between 3 and 15 parameters.');
  const keys = new Set();
  let sum = 0;
  for (const q of ps) {
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(q.key || '')) errors.push(`"${q.key}" is not a valid key. Use lowercase letters, numbers and underscores.`);
    if (keys.has(q.key)) errors.push(`Key "${q.key}" is used twice.`);
    keys.add(q.key);
    if (!str(q.name, 60)) errors.push('Every parameter needs a name.');
    if (!Number.isFinite(q.max) || q.max < 1 || q.max > 60 || q.max * 2 !== Math.round(q.max * 2)) errors.push(`Marks for "${q.name}" must be between 1 and 60.`);
    sum += Number(q.max) || 0;
    // A parameter may be broken into criteria, each marked in whole points. Their marks must add up to the parameter's.
    if (q.criteria?.length) {
      const seen = new Set();
      for (const c of q.criteria) {
        if (!/^[a-z][a-z0-9_]{1,23}$/.test(c.key || '') || seen.has(c.key)) errors.push(`"${q.name}" has a criterion with a missing or repeated key.`);
        seen.add(c.key);
        if (!str(c.name, 60)) errors.push(`Every criterion in "${q.name}" needs a name.`);
        if (!Number.isInteger(c.max) || c.max < 1 || c.max > 20) errors.push(`Marks for "${c.name}" must be a whole number from 1 to 20.`);
      }
      const inner = q.criteria.reduce((a, c) => a + (Number(c.max) || 0), 0);
      if (inner !== q.max) errors.push(`The criteria in "${q.name}" add up to ${inner}, but it is worth ${q.max}.`);
    }
  }
  if (data?.bands && !(Array.isArray(data.bands) && data.bands.length === 4 && data.bands.every((b) => str(b, 60)))) errors.push('Give a name to each of the four score bands.');
  if (sum !== 100) errors.push(`Marks must add up to 100. They add up to ${sum}.`);
  const th = data?.thresholds || {};
  if (!(th.strong > th.recommended && th.recommended > th.borderline && th.borderline > 0 && th.strong <= 100)) errors.push('Thresholds must go down in order: Strongly Recommended, Recommended, Borderline.');
  if (!(data.duration_min >= 3 && data.duration_min <= 20)) errors.push('Call length must be 3 to 20 minutes.');
  if (!(data.attempts >= 1 && data.attempts <= 5)) errors.push('Attempts must be 1 to 5.');
  if (!(data.min_turns >= 2 && data.min_turns <= 12)) errors.push('Minimum turns must be 2 to 12.');
  if (!['none', 'summary', 'full'].includes(data.candidate_feedback)) errors.push('Choose what candidates can see.');
  return errors;
}

const BANDS = ['Excellent', 'Good', 'Developing', 'Needs improvement'];
export const bandFor = (percent, th) => (percent >= th.strong ? 0 : percent >= th.recommended ? 1 : percent >= th.borderline ? 2 : 3);

/** The name of the score band. A template can carry its own four names, such as "Elite Setter". */
export function categoryFor(percent, th, bands) {
  return (Array.isArray(bands) && bands.length === 4 ? bands : BANDS)[bandFor(percent, th)];
}

/**
 * Turns the AI's raw JSON into a report.
 * - a parameter with criteria: each criterion gets whole points from 0 to its maximum, and the parameter is their sum
 * - a criterion given as {points, quote} keeps its points only if its own quote is found in what the caller said
 * - a parameter without criteria: marks = max x level / 4, to the nearest half mark
 * - a parameter with no quote found in the transcript scores 0 ("No evidence")
 * - generic feedback that fits every call is removed, sentence by sentence
 * - a teacher who cannot be booked is scored on the opening, the exit and professionalism only, rescaled to 100
 * - ignoring "do not call me again" sets professionalism to 0; pushing an unbookable teacher caps the score
 * - conduct problems backed by a real quote cap the recommendation at Borderline
 */
export function buildReport({ raw, items, template, personas, meta }) {
  const turns = candidateTurns(items);
  const th = template.data.thresholds;
  const { fb, state: scrub } = scrubber();
  const quote = (o) => {
    const q = str(o?.quote, 300);
    const at = q ? verifyQuote(q, turns, o?.turn) : null;
    return { quote: q, turn: at, verified: at !== null };
  };

  const conduct = (Array.isArray(raw?.conduct) ? raw.conduct : []).slice(0, 8)
    .filter((c) => CONDUCT_TYPES.includes(c?.type))
    .map((c) => ({ type: c.type, note: fb(c.note), ...quote(c) }));
  const provenConduct = conduct.filter((c) => c.verified);
  const ignoredDnc = provenConduct.some((c) => c.type === 'ignored_do_not_call');

  let params = template.data.parameters.map((def) => {
    const r = raw?.parameters?.[def.key] || {};
    let level = Math.round(Number(r.level));
    if (!Number.isFinite(level)) level = 0;
    level = Math.max(0, Math.min(4, level));
    const evidence = (Array.isArray(r.evidence) ? r.evidence : []).slice(0, 4).map(quote).filter((e) => e.quote);
    // Criteria are marked one by one. If the AI skipped them, its overall level is spread across them instead.
    const given = r.criteria && typeof r.criteria === 'object' ? r.criteria : null;
    let criteria = null;
    let proposed = half((def.max * level) / 4);
    if (def.criteria?.length) {
      criteria = def.criteria.map((c) => {
        const e = given ? given[c.key] : undefined;
        const detailed = e !== null && typeof e === 'object';
        const v = given ? Math.round(Number(detailed ? e.points : e)) : Math.round((c.max * level) / 4);
        const pts = Number.isFinite(v) ? Math.max(0, Math.min(c.max, v)) : 0;
        if (!detailed) return { key: c.key, name: c.name, max: c.max, proposed: pts, marks: pts };
        // Rule 1: each criterion stands on its own quote. Points without one are not counted.
        const ev = quote(e);
        const absent = fb(e.absent, 250);
        if (ev.verified && !evidence.some((x) => norm(x.quote) === norm(ev.quote))) evidence.push(ev);
        return {
          key: c.key, name: c.name, max: c.max, proposed: pts, marks: pts > 0 && !ev.verified ? 0 : pts,
          ...(ev.quote ? { quote: ev.quote, turn: ev.turn, verified: ev.verified } : {}),
          ...(absent ? { absent } : {}),
          ...(pts > 0 && !ev.verified ? { no_evidence: true } : {}),
          ...(!ev.quote && !absent ? { unjustified: true } : {}),
        };
      });
      proposed = criteria.reduce((a, c) => a + c.proposed, 0);
      level = Math.round((4 * proposed) / def.max);
    }
    const backed = evidence.some((e) => e.verified);
    let marks = criteria ? criteria.reduce((a, c) => a + c.marks, 0) : proposed;
    const noEvidence = proposed > 0 && (!backed || marks === 0);
    if (noEvidence) { marks = 0; if (criteria) criteria = criteria.map((c) => ({ ...c, marks: 0 })); }
    return {
      key: def.key, name: def.name, max: def.max, ...(def.group ? { group: def.group } : {}),
      level, proposed, marks, no_evidence: noEvidence,
      ...(criteria ? { criteria: criteria.map(({ proposed: _p, ...c }) => c) } : {}),
      _proposed: criteria ? criteria.map((c) => c.proposed) : null,
      did_well: fb(r.did_well), did_wrong: fb(r.did_wrong), missed: fb(r.missed), improve: fb(r.improve),
      evidence: evidence.slice(0, 6),
    };
  });

  const basis = [];

  // Rule 7: a caller who carried on after "do not call me again" gets nothing for professionalism.
  if (ignoredDnc && params.some(isProfessionalism)) {
    params = params.map((q) => (isProfessionalism(q) ? { ...q, marks: 0, dnc_zeroed: true, ...(q.criteria ? { criteria: q.criteria.map((c) => ({ ...c, marks: 0 })) } : {}) } : q));
  }

  // Rule 6: a teacher who cannot be booked. Only the opening, the exit and professionalism apply, rescaled to 100,
  // so a quick, warm exit can score well and a caller who pushed on cannot win marks by doing the rest of the call.
  const canBook = meta.bookable !== false;
  const exitKeys = Object.entries(EXIT_CRITERIA).flatMap(([p, cs]) => cs.map((c) => p + '.' + c));
  const exitHere = params.flatMap((q) => (q.criteria || []).map((c) => q.key + '.' + c.key)).filter((k) => exitKeys.includes(k));
  const scope = !canBook && exitHere.length >= 3 ? 'exit' : null;
  if (scope) {
    params = params.map((q) => {
      if (!q.criteria) return { ...q, marks: 0, na: true, applicable_max: 0 };
      const criteria = q.criteria.map((c) => (exitHere.includes(q.key + '.' + c.key) ? c : { ...c, marks: 0, na: true }));
      const applicable = criteria.filter((c) => !c.na);
      return { ...q, criteria, marks: applicable.reduce((a, c) => a + c.marks, 0), applicable_max: applicable.reduce((a, c) => a + c.max, 0), ...(applicable.length ? {} : { na: true }) };
    });
  }

  const applicableMax = scope ? params.reduce((a, q) => a + (q.applicable_max || 0), 0) : 100;
  const claimed = params.reduce((a, q) => {
    if (!scope || !q._proposed) return a + (q.na ? 0 : q.proposed);
    return a + q.criteria.reduce((s, c, i) => s + (c.na ? 0 : q._proposed[i]), 0);
  }, 0);
  const earned = params.reduce((a, q) => a + q.marks, 0);
  let total = scope ? half((earned / Math.max(1, applicableMax)) * 100) : half(earned);
  const coverage = claimed > 0 ? Math.min(100, Math.round((earned / claimed) * 100)) : 0;
  params = params.map(({ _proposed, ...q }) => q);
  const ranked = params.filter((q) => !q.na).sort((a, b) => b.marks / (b.applicable_max || b.max) - a.marks / (a.applicable_max || a.max));

  const claims = (Array.isArray(raw?.product_claims) ? raw.product_claims : []).slice(0, 12)
    .map((c) => ({ verdict: ['accurate', 'inaccurate', 'unverifiable'].includes(c?.verdict) ? c.verdict : 'unverifiable', note: fb(c?.note), ...quote(c) }))
    .filter((c) => c.verified);
  const inaccurate = claims.filter((c) => c.verdict === 'inaccurate');

  const o = raw?.outcome || {};
  const outcome = {
    result: OUTCOMES.includes(o.result) ? o.result : null,
    win_condition_met: VERDICTS.includes(o.win_condition_met) ? o.win_condition_met : null,
    why: fb(o.why), ...quote(o),
  };
  const h = raw?.handoff || {};
  const handoff = HANDOFF.includes(h.verdict) ? { verdict: h.verdict, why: fb(h.why), ...quote(h) } : null;

  // A caller who pushed a teacher who could not be booked must end up below one who left quickly (rule 6).
  const pushed = !canBook && ((outcome.result === 'pushed_after_refusal' && outcome.verified) || provenConduct.some((c) => ['pressure', 'ignored_do_not_call'].includes(c.type)));
  if (pushed) total = Math.min(total, half(th.borderline / 2));
  const percent = total; // marks are out of 100

  // Recommendation: score band first, then caps that no score can override.
  let rec = bandFor(percent, th);
  basis.push(scope ? `Score ${total} out of 100, on the parts of the call that apply to a teacher who cannot be booked.` : `Score ${total} out of 100.`);
  // A cap is listed when it lowers the recommendation; the job-level failures are listed even when the score was already that low.
  const cap = (to, why, always = false) => { if (rec < to) { rec = to; basis.push(why); } else if (always) basis.push(why); };
  if (ignoredDnc) cap(3, 'The caller carried on after the teacher asked not to be called again, so Professionalism is 0 and the recommendation is the lowest.', true);
  else if (pushed) cap(3, 'This teacher could not be booked. The caller pushed on after the refusal instead of leaving quickly and warmly, so the score is capped and the recommendation is the lowest.', true);
  if (provenConduct.length) cap(2, `Conduct concern on the call (${[...new Set(provenConduct.map((c) => c.type.replace(/_/g, ' ')))].join(', ')}), so the recommendation cannot be higher than Borderline.`);
  if (canBook && outcome.result === 'no_next_step' && outcome.win_condition_met !== 'yes') cap(2, 'The call ended without a booked counselling session or a clean disqualification, so it failed at the setter\'s actual job. The recommendation cannot be higher than Borderline.', true);
  if (inaccurate.length >= 2) cap(2, 'Two or more statements about Suraasa contradicted the verified facts.');
  if (coverage < 60 && claimed > 0) cap(2, `Only ${coverage}% of the proposed marks were backed by a quote found in the transcript.`);
  if (handoff?.verdict === 'crossed') basis.push('The caller explained programme detail that belongs to the senior mentor (the handoff rule), and was marked down for it.');
  if (meta.practice) {
    if (meta.tech_flag) basis.push('Technical problems were recorded on this call, so treat this score with care and take another call.');
  } else {
    if (meta.unverified) basis.push('This was a live voice call. Its transcript was reported by the candidate\'s browser and could not be checked by the server, so read the transcript before relying on the score.');
    if (meta.tech_flag) basis.push('Technical problems were recorded on this call. Consider a second attempt before deciding.');
  }

  const a = raw?.analysis || {};
  const verdict = (o) => ({ verdict: VERDICTS.includes(o?.verdict) ? o.verdict : 'partly', why: fb(o?.why) });
  const moment = (o) => (o && str(o.quote) ? { ...quote(o), why: fb(o.why) } : null);
  const objection = (o) => (o && str(o.objection) ? { objection: str(o.objection, 200), why: fb(o.why) } : null);
  const worst = moment(a.worst_response);

  const rr = raw?.recommendations || {};
  const three = (xs) => (Array.isArray(xs) ? xs : []).map((x) => fb(x, 300)).filter(Boolean).slice(0, 3);
  const active = personas.filter((q) => q.active !== false);
  let next = active.find((q) => q.id === rr?.next_scenario?.persona_id && q.id !== meta.persona_id);
  let nextWhy = fb(rr?.next_scenario?.why);
  if (!next) { next = active.find((q) => q.id !== meta.persona_id) || null; nextWhy = next ? 'A different teacher to practise against.' : ''; }

  // Rule 3: the better line is for the weakest moment, so "instead of" must be the caller's real words there.
  let better = null;
  if (rr.better_response && str(rr.better_response.try)) {
    const said = quote({ quote: rr.better_response.instead_of, turn: rr.better_response.turn });
    const at = said.verified ? said : worst?.verified ? { quote: worst.quote, turn: worst.turn, verified: true } : said;
    better = { instead_of: at.quote, turn: at.turn, verified: at.verified, try: str(rr.better_response.try, 600) };
  }

  const criteriaAll = params.flatMap((q) => q.criteria || []);
  const rationale = fb(raw?.rationale, 700); // before the counts below are read
  return {
    v: 2,
    meta,
    params, total, percent, coverage,
    ...(scope ? { scope: { kind: 'exit', max: applicableMax } } : {}),
    category: categoryFor(percent, th, template.data.bands), band: bandFor(percent, th),
    strongest: ranked[0] ? { key: ranked[0].key, name: ranked[0].name } : null,
    weakest: ranked.length ? { key: ranked[ranked.length - 1].key, name: ranked[ranked.length - 1].name } : null,
    outcome, handoff,
    analysis: {
      best_response: moment(a.best_response),
      worst_response: worst,
      best_objection_handled: objection(a.best_objection_handled),
      unhandled_objection: objection(a.unhandled_objection),
      missed_discovery_questions: (Array.isArray(a.missed_discovery_questions) ? a.missed_discovery_questions : []).map((x) => fb(x, 200)).filter(Boolean).slice(0, 5),
      understood_needs: verdict(a.understood_needs),
      value_communicated: verdict(a.value_communicated),
      next_step_secured: verdict(a.next_step_secured),
    },
    recommendations: {
      strengths: three(rr.strengths),
      improvements: three(rr.improvements),
      exercises: three(rr.exercises),
      better_response: better,
      next_scenario: next ? { persona_id: next.id, name: next.label || next.name, why: nextWhy } : null,
    },
    conduct,
    product: { checked: meta.facts_used > 0, claims },
    checks: {
      generic_removed: scrub.removed,
      unjustified: criteriaAll.filter((c) => c.unjustified && !c.na).length,
      unquoted: criteriaAll.filter((c) => c.no_evidence && !c.na).length,
      repaired: !!meta.repaired,
    },
    hiring: { recommendation: RECOMMENDATIONS[rec], basis, rationale },
    // A practice call by an intern in training gets a training recommendation in place of a hiring one.
    training: meta.practice ? { recommendation: TRAINING_RECOMMENDATIONS[rec], basis, rationale } : null,
  };
}

/** What a candidate is allowed to see. Recruiter-only material is removed on the server, not hidden in the page. */
export function reportForCandidate(report, policy) {
  if (!report || policy === 'none') return null;
  const base = {
    v: report.v, limited: true,
    meta: { persona_name: report.meta.persona_name, difficulty: report.meta.difficulty, level: report.meta.level, started_at: report.meta.started_at, duration_sec: report.meta.duration_sec, candidate_name: report.meta.candidate_name, candidate_code: report.meta.candidate_code },
    total: report.total, percent: report.percent, category: report.category, band: report.band,
    strongest: report.strongest, weakest: report.weakest,
    ...(report.scope ? { scope: report.scope } : {}),
    recommendations: { ...report.recommendations },
  };
  // An intern sees their own training recommendation and what they got wrong about Suraasa. A hiring candidate never sees the hiring one.
  if (report.training) { base.training = report.training; base.product = report.product; base.conduct = report.conduct.filter((c) => c.verified); base.outcome = report.outcome; base.handoff = report.handoff; }
  if (policy === 'summary') return base;
  return {
    ...base,
    params: report.params.map((q) => ({ key: q.key, name: q.name, max: q.max, group: q.group, criteria: q.criteria, marks: q.marks, no_evidence: q.no_evidence, na: q.na, applicable_max: q.applicable_max, dnc_zeroed: q.dnc_zeroed, did_well: q.did_well, did_wrong: q.did_wrong, missed: q.missed, improve: q.improve, evidence: q.evidence })),
    analysis: report.analysis,
    outcome: report.outcome, handoff: report.handoff,
  };
}
