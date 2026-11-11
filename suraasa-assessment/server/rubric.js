/**
 * Scoring rules. The AI only proposes levels, quotes and comments.
 * Every number, category and recommendation is worked out here, the same way for every candidate.
 */

export const RECOMMENDATIONS = ['Strongly Recommended', 'Recommended', 'Borderline', 'Not Recommended'];
const CONDUCT_TYPES = ['pressure', 'misleading', 'ignored_do_not_call', 'disrespect', 'gaming'];
const VERDICTS = ['yes', 'partly', 'no'];

const str = (v, max = 400) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const half = (n) => Math.round(n * 2) / 2;

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
  }
  if (sum !== 100) errors.push(`Marks must add up to 100. They add up to ${sum}.`);
  const th = data?.thresholds || {};
  if (!(th.strong > th.recommended && th.recommended > th.borderline && th.borderline > 0 && th.strong <= 100)) errors.push('Thresholds must go down in order: Strongly Recommended, Recommended, Borderline.');
  if (!(data.duration_min >= 3 && data.duration_min <= 15)) errors.push('Call length must be 3 to 15 minutes.');
  if (!(data.attempts >= 1 && data.attempts <= 5)) errors.push('Attempts must be 1 to 5.');
  if (!(data.min_turns >= 2 && data.min_turns <= 12)) errors.push('Minimum turns must be 2 to 12.');
  if (!['none', 'summary', 'full'].includes(data.candidate_feedback)) errors.push('Choose what candidates can see.');
  return errors;
}

export function categoryFor(percent, th) {
  if (percent >= th.strong) return 'Excellent';
  if (percent >= th.recommended) return 'Good';
  if (percent >= th.borderline) return 'Developing';
  return 'Needs improvement';
}

/**
 * Turns the AI's raw JSON into a report.
 * - marks = max x level / 4, to the nearest half mark
 * - a parameter with no quote found in the transcript scores 0 ("No evidence")
 * - conduct problems backed by a real quote cap the recommendation at Borderline
 */
export function buildReport({ raw, items, template, personas, meta }) {
  const turns = candidateTurns(items);
  const th = template.data.thresholds;
  const quote = (o) => {
    const q = str(o?.quote, 300);
    const at = q ? verifyQuote(q, turns, o?.turn) : null;
    return { quote: q, turn: at, verified: at !== null };
  };

  const params = template.data.parameters.map((def) => {
    const r = raw?.parameters?.[def.key] || {};
    let level = Math.round(Number(r.level));
    if (!Number.isFinite(level)) level = 0;
    level = Math.max(0, Math.min(4, level));
    const evidence = (Array.isArray(r.evidence) ? r.evidence : []).slice(0, 4).map(quote).filter((e) => e.quote);
    const backed = evidence.some((e) => e.verified);
    const noEvidence = level > 0 && !backed;
    return {
      key: def.key, name: def.name, max: def.max,
      level, marks: noEvidence ? 0 : half((def.max * level) / 4), no_evidence: noEvidence,
      did_well: str(r.did_well), did_wrong: str(r.did_wrong), missed: str(r.missed), improve: str(r.improve),
      evidence,
    };
  });

  const total = half(params.reduce((a, q) => a + q.marks, 0));
  const percent = total; // marks are out of 100
  const claimed = params.reduce((a, q) => a + half((q.max * q.level) / 4), 0);
  const coverage = claimed > 0 ? Math.min(100, Math.round((params.reduce((a, q) => a + q.marks, 0) / claimed) * 100)) : 0;
  const ranked = [...params].sort((a, b) => b.marks / b.max - a.marks / a.max);

  const conduct = (Array.isArray(raw?.conduct) ? raw.conduct : []).slice(0, 8)
    .filter((c) => CONDUCT_TYPES.includes(c?.type))
    .map((c) => ({ type: c.type, note: str(c.note), ...quote(c) }));
  const provenConduct = conduct.filter((c) => c.verified);

  const claims = (Array.isArray(raw?.product_claims) ? raw.product_claims : []).slice(0, 12)
    .map((c) => ({ verdict: ['accurate', 'inaccurate', 'unverifiable'].includes(c?.verdict) ? c.verdict : 'unverifiable', note: str(c?.note), ...quote(c) }))
    .filter((c) => c.verified);
  const inaccurate = claims.filter((c) => c.verdict === 'inaccurate');

  // Recommendation: score band first, then caps that no score can override.
  let rec = percent >= th.strong ? 0 : percent >= th.recommended ? 1 : percent >= th.borderline ? 2 : 3;
  const basis = [`Score ${total} out of 100.`];
  const cap = (to, why) => { if (rec < to) { rec = to; basis.push(why); } };
  if (provenConduct.length) cap(2, `Conduct concern on the call (${[...new Set(provenConduct.map((c) => c.type.replace(/_/g, ' ')))].join(', ')}), so the recommendation cannot be higher than Borderline.`);
  if (inaccurate.length >= 2) cap(2, 'Two or more statements about Suraasa contradicted the verified facts.');
  if (coverage < 60 && claimed > 0) cap(2, `Only ${coverage}% of the proposed marks were backed by a quote found in the transcript.`);
  if (meta.unverified) basis.push('This was a live voice call. Its transcript was reported by the candidate\'s browser and could not be checked by the server, so read the transcript before relying on the score.');
  if (meta.tech_flag) basis.push('Technical problems were recorded on this call. Consider a second attempt before deciding.');

  const a = raw?.analysis || {};
  const verdict = (o) => ({ verdict: VERDICTS.includes(o?.verdict) ? o.verdict : 'partly', why: str(o?.why) });
  const moment = (o) => (o && str(o.quote) ? { ...quote(o), why: str(o.why) } : null);
  const objection = (o) => (o && str(o.objection) ? { objection: str(o.objection, 200), why: str(o.why) } : null);

  const rr = raw?.recommendations || {};
  const three = (xs) => (Array.isArray(xs) ? xs : []).map((x) => str(x, 300)).filter(Boolean).slice(0, 3);
  const active = personas.filter((q) => q.active !== false);
  let next = active.find((q) => q.id === rr?.next_scenario?.persona_id && q.id !== meta.persona_id);
  let nextWhy = str(rr?.next_scenario?.why);
  if (!next) { next = active.find((q) => q.id !== meta.persona_id) || null; nextWhy = next ? 'A different teacher to practise against.' : ''; }

  return {
    v: 1,
    meta,
    params, total, percent, coverage,
    category: categoryFor(percent, th),
    strongest: ranked[0] ? { key: ranked[0].key, name: ranked[0].name } : null,
    weakest: ranked.length ? { key: ranked[ranked.length - 1].key, name: ranked[ranked.length - 1].name } : null,
    analysis: {
      best_response: moment(a.best_response),
      worst_response: moment(a.worst_response),
      best_objection_handled: objection(a.best_objection_handled),
      unhandled_objection: objection(a.unhandled_objection),
      missed_discovery_questions: (Array.isArray(a.missed_discovery_questions) ? a.missed_discovery_questions : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 5),
      understood_needs: verdict(a.understood_needs),
      value_communicated: verdict(a.value_communicated),
      next_step_secured: verdict(a.next_step_secured),
    },
    recommendations: {
      strengths: three(rr.strengths),
      improvements: three(rr.improvements),
      exercises: three(rr.exercises),
      better_response: rr.better_response && str(rr.better_response.try) ? { instead_of: str(rr.better_response.instead_of, 300), try: str(rr.better_response.try, 500) } : null,
      next_scenario: next ? { persona_id: next.id, name: next.label || next.name, why: nextWhy } : null,
    },
    conduct,
    product: { checked: meta.facts_used > 0, claims },
    hiring: { recommendation: RECOMMENDATIONS[rec], basis, rationale: str(raw?.rationale, 700) },
  };
}

/** What a candidate is allowed to see. Recruiter-only material is removed on the server, not hidden in the page. */
export function reportForCandidate(report, policy) {
  if (!report || policy === 'none') return null;
  const base = {
    v: report.v, limited: true,
    meta: { persona_name: report.meta.persona_name, difficulty: report.meta.difficulty, level: report.meta.level, started_at: report.meta.started_at, duration_sec: report.meta.duration_sec, candidate_name: report.meta.candidate_name, candidate_code: report.meta.candidate_code },
    total: report.total, percent: report.percent, category: report.category,
    strongest: report.strongest, weakest: report.weakest,
    recommendations: { ...report.recommendations },
  };
  if (policy === 'summary') return base;
  return {
    ...base,
    params: report.params.map((q) => ({ key: q.key, name: q.name, max: q.max, marks: q.marks, no_evidence: q.no_evidence, did_well: q.did_well, did_wrong: q.did_wrong, missed: q.missed, improve: q.improve, evidence: q.evidence })),
    analysis: report.analysis,
  };
}
