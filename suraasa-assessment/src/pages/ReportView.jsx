import React from 'react';
import { Badge, Bar, ScoreRing, fmtDateTime, fmtDur, recTone } from '../ui.jsx';

const VERDICT = { yes: ['Yes', 'good'], partly: ['Partly', 'warn'], no: ['No', 'bad'] };
const OUTCOME = {
  booked: ['Counselling session booked', 'good'],
  clean_disqualification: ['Cleanly disqualified', 'good'],
  respectful_exit: ['Quick, respectful exit', 'good'],
  pushed_after_refusal: ['Pushed after a refusal', 'bad'],
  no_next_step: ['No booking, no clean close', 'bad'],
};
const HANDOFF = { held: ['Held the handoff', 'good'], partly: ['Partly held', 'warn'], crossed: ['Did the mentor\'s job', 'bad'] };
const CONDUCT = { pressure: 'Pressure or false urgency', misleading: 'Misleading claim', ignored_do_not_call: 'Ignored a request not to be called', disrespect: 'Disrespect', gaming: 'Tried to influence the assessment' };

function Quote({ q }) {
  if (!q?.quote) return null;
  return <div className={'quote ' + (q.verified ? '' : 'unv')}>"{q.quote}" <span className="tiny muted">{q.verified ? `Candidate, turn ${q.turn}` : 'Not found in the transcript, so not counted'}</span></div>;
}

function Moment({ title, m }) {
  if (!m) return null;
  return <div className="col gap-s"><h3>{title}</h3><Quote q={m} />{m.why && <p className="small">{m.why}</p>}</div>;
}

/** The evaluation report. Staff see everything; a candidate sees only what the server sent them. */
export default function ReportView({ report, staff }) {
  const m = report.meta;
  const full = !!report.params;
  // Where the rubric is in parts (Connecting, Augmenting, ...), show a subtotal for each part first.
  const parts = [];
  for (const q of report.params || []) {
    if (!q.group) continue;
    let g = parts.find((x) => x.name === q.group);
    if (!g) parts.push(g = { name: q.group, marks: 0, max: 0 });
    g.marks += q.marks; g.max += report.scope ? q.applicable_max || 0 : q.max;
  }
  return (
    <div className="col gap-l">
      <div className="card">
        <div className="row gap-l wrap">
          <ScoreRing value={report.total} />
          <div className="grow">
            <div className="row wrap gap-s"><Badge tone={report.band != null ? ['good', 'good', 'warn', 'bad'][report.band] : report.percent >= 65 ? 'good' : report.percent >= 50 ? 'warn' : 'bad'}>{report.category}</Badge><span className="small muted">{report.percent}%</span></div>
            <dl className="kv mt">
              <dt>Candidate</dt><dd><b>{m.candidate_name}</b> · {m.candidate_code}</dd>
              <dt>Date</dt><dd>{fmtDateTime(m.started_at)}</dd>
              <dt>Teacher</dt><dd>{m.persona_name}{m.persona_label ? ` (${m.persona_label})` : ''}</dd>
              <dt>Difficulty</dt><dd>{m.difficulty} · Level {m.level}</dd>
              <dt>Call length</dt><dd>{fmtDur(m.duration_sec)}</dd>
              {report.strongest && <><dt>Strongest skill</dt><dd>{report.strongest.name}</dd></>}
              {report.weakest && <><dt>Weakest skill</dt><dd>{report.weakest.name}</dd></>}
            </dl>
          </div>
        </div>
      </div>

      {(staff || report.training) && (() => {
        const rec = report.training || report.hiring;
        const claims = report.product?.claims || [];
        return (
          <div className="card col" data-testid="recommendation">
            <div className="row between wrap"><h2>{report.training ? 'Training recommendation' : 'AI hiring recommendation'}</h2><Badge tone={recTone(rec.recommendation)}>{rec.recommendation}</Badge></div>
            <p>{rec.rationale}</p>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{rec.basis.map((b, i) => <li key={i}>{b}</li>)}</ul>
            {staff && <p className="tiny muted">{report.training ? 'This guides the intern\'s practice. It is not a performance rating.' : 'This supports your judgement. It is not a hiring decision.'} Scores are calculated by the app from the AI's evidence: {report.coverage}% of proposed marks were backed by a quote found in the transcript. Model: {m.model}. Rubric: {m.template_name}, version {m.template_version}.</p>}
            {report.scope && <div className="note">{staff ? 'This teacher could not be booked on this call, so the right outcome was a quick, warm exit.' : 'This teacher could not be booked, so the right outcome was a quick, warm exit.'} The score covers only the opening, the exit and professionalism ({report.scope.max} marks), rescaled to 100. The rest of the call is marked "not applicable".</div>}
            {staff && report.checks && (report.checks.unjustified > 0 || report.checks.generic_removed > 0 || report.checks.unquoted > 0) && <div className="note warn small">Quality of the AI's feedback: {[report.checks.unquoted ? `${report.checks.unquoted} criteria had points without a real quote and were scored 0` : '', report.checks.unjustified ? `${report.checks.unjustified} criteria came with neither a quote nor a statement of what was missing` : '', report.checks.generic_removed ? `${report.checks.generic_removed} generic sentence${report.checks.generic_removed === 1 ? ' was' : 's were'} removed` : ''].filter(Boolean).join('; ')}.{report.checks.repaired ? ' The AI was asked once to correct its assessment.' : ''}</div>}
            {staff && m.unverified && <div className="note warn">Live voice call. The transcript came from the candidate's browser and could not be checked by the server. Read it through before relying on this score.</div>}
            {staff && m.tech_flag && <div className="note warn">Technical problems were recorded on this call ({m.tech?.stt_errors || 0} speech recognition errors, {m.tech?.reconnects || 0} reconnections). Consider voiding it and allowing another attempt.</div>}
            {staff && m.long_gaps > 0 && <div className="note warn">There {m.long_gaps === 1 ? 'was 1 silence' : `were ${m.long_gaps} silences`} of over two minutes before the candidate replied.</div>}
            {report.product && !report.product.checked && <div className="note warn">{staff ? 'Product accuracy was not checked, because no product facts have been verified yet. Approve them under Assessments, then score again.' : 'What you said about Suraasa was not checked for accuracy on this call, because the product facts have not been approved yet.'}</div>}
            {(report.conduct || []).filter((c) => c.verified).map((c, i) => (
              <div className="note bad" key={i}><b>{CONDUCT[c.type]}.</b> {c.note}<div style={{ marginTop: 6 }}><Quote q={c} /></div></div>
            ))}
            {claims.length > 0 && (
              <div className="col gap-s"><h3>{staff ? 'What the candidate said about Suraasa' : 'What you said about Suraasa'}</h3>
                {claims.map((c, i) => <div key={i} className="row" style={{ alignItems: 'flex-start' }}><Badge tone={c.verdict === 'accurate' ? 'good' : c.verdict === 'inaccurate' ? 'bad' : 'warn'}>{c.verdict === 'unverifiable' ? 'Not in verified facts' : c.verdict}</Badge><span className="small grow">"{c.quote}" {c.note && <span className="muted">{c.note}</span>}</span></div>)}
              </div>
            )}
          </div>
        );
      })()}

      {(report.outcome?.result || report.handoff) && (
        <div className="card col gap-l" data-testid="outcome">
          <h2>Did the call do the setter's job?</h2>
          <div className="grid g2">
            {report.outcome?.result && (
              <div className="col gap-s">
                <div className="row between wrap"><h3>Outcome</h3><Badge tone={OUTCOME[report.outcome.result][1]}>{OUTCOME[report.outcome.result][0]}</Badge></div>
                {staff && m.win_condition && <p className="small muted">Win condition for this teacher: {m.win_condition}</p>}
                {report.outcome.win_condition_met && <p className="small"><b>Win condition met:</b> {VERDICT[report.outcome.win_condition_met][0]}</p>}
                <Quote q={report.outcome} />
                {report.outcome.why && <p className="small">{report.outcome.why}</p>}
              </div>
            )}
            {report.handoff && (
              <div className="col gap-s">
                <div className="row between wrap"><h3>Handoff to the senior mentor</h3><Badge tone={HANDOFF[report.handoff.verdict][1]}>{HANDOFF[report.handoff.verdict][0]}</Badge></div>
                <p className="small muted">The setter qualifies and books. Programme detail, fees and eligibility belong to the mentor.</p>
                <Quote q={report.handoff} />
                {report.handoff.why && <p className="small">{report.handoff.why}</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {full && (
        <div className="card">
          <h2 style={{ marginBottom: 16 }}>Detailed evaluation</h2>
          {parts.length > 0 && (
            <div className="table-wrap" style={{ marginBottom: 20 }} tabIndex={0} role="group" aria-label="Score for each part of the call">
              <table data-testid="parts">
                <thead><tr><th>Part of the call</th><th className="num">Score</th><th style={{ width: '45%' }}><span className="sr">Share of marks</span></th></tr></thead>
                <tbody>{parts.filter((g) => g.max > 0).map((g) => <tr key={g.name}><td className="strong">{g.name}</td><td className="num">{g.marks} / {g.max}</td><td><Bar value={g.marks} max={g.max} /></td></tr>)}</tbody>
              </table>
            </div>
          )}
          {report.params.map((q, i) => (
            <div className="param" key={q.key} data-testid="param">
              {q.group && q.group !== report.params[i - 1]?.group && <p className="small muted strong" style={{ textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>{q.group}</p>}
              <div className="row between"><h3>{q.name}</h3>{q.na ? <Badge>Not applicable</Badge> : <span className="strong num">{q.marks} / {report.scope ? q.applicable_max : q.max}</span>}</div>
              {!q.na && <div style={{ margin: '8px 0 10px' }}><Bar value={q.marks} max={report.scope ? q.applicable_max : q.max} /></div>}
              {q.dnc_zeroed && <div className="note bad small" style={{ marginBottom: 8 }}>Set to 0: the caller carried on after the teacher asked not to be called again.</div>}
              {q.no_evidence && <div className="note warn small" style={{ marginBottom: 8 }}>No evidence. The AI proposed marks here, but its quote was not found in the transcript, so this scores 0.</div>}
              {q.criteria?.length > 0 && (
                <ul className="small" data-testid="criteria" style={{ listStyle: 'none', padding: 0, margin: '0 0 10px' }}>
                  {q.criteria.map((c) => (
                    <li key={c.key} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                      <div className="row between"><span>{c.name}</span>{c.na ? <span className="tiny muted">not applicable</span> : <span className="num">{c.marks} / {c.max}</span>}</div>
                      {!c.na && c.quote && <div className={'tiny ' + (c.verified ? 'muted' : '')} style={{ marginTop: 2 }}>{c.verified ? `"${c.quote}" (turn ${c.turn})` : `Quote not found in the transcript, so not counted: "${c.quote}"`}</div>}
                      {!c.na && !c.quote && c.absent && <div className="tiny muted" style={{ marginTop: 2 }}><i>{c.absent}</i></div>}
                      {!c.na && c.unjustified && <div className="tiny" style={{ marginTop: 2, color: 'var(--bad)' }}>No quote and no reason given.</div>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid g2 small">
                {q.did_well && <div><b>Did well</b><br />{q.did_well}</div>}
                {q.did_wrong && <div><b>Went wrong</b><br />{q.did_wrong}</div>}
                {q.missed && <div><b>Missed</b><br />{q.missed}</div>}
                {q.improve && <div><b>To improve</b><br />{q.improve}</div>}
              </div>
              <div className="col gap-s" style={{ marginTop: 10 }}>{q.evidence.map((e, i) => <Quote key={i} q={e} />)}</div>
            </div>
          ))}
        </div>
      )}

      {report.analysis && (
        <div className="card col gap-l">
          <h2>Conversation analysis</h2>
          <div className="grid g3">
            {[['Understood the teacher\'s needs', report.analysis.understood_needs], ['Communicated Suraasa\'s value', report.analysis.value_communicated], ['Secured a next step', report.analysis.next_step_secured]].map(([t, v]) => (
              <div key={t} className="card flat tight"><div className="row between"><span className="small strong">{t}</span><Badge tone={VERDICT[v.verdict][1]}>{VERDICT[v.verdict][0]}</Badge></div><p className="small mt" style={{ marginTop: 8 }}>{v.why}</p></div>
            ))}
          </div>
          <div className="grid g2">
            <Moment title="Best response" m={report.analysis.best_response} />
            <Moment title="Weakest response" m={report.analysis.worst_response} />
            {report.analysis.best_objection_handled && <div className="col gap-s"><h3>Best objection handled</h3><p className="small"><b>{report.analysis.best_objection_handled.objection}</b><br />{report.analysis.best_objection_handled.why}</p></div>}
            {report.analysis.unhandled_objection && <div className="col gap-s"><h3>Objection not handled well</h3><p className="small"><b>{report.analysis.unhandled_objection.objection}</b><br />{report.analysis.unhandled_objection.why}</p></div>}
          </div>
          {report.analysis.missed_discovery_questions.length > 0 && <div><h3>Discovery questions that were missed</h3><ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{report.analysis.missed_discovery_questions.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        </div>
      )}

      <div className="card col gap-l">
        <h2>Recommendations</h2>
        <div className="grid g2">
          <div><h3>Strengths</h3><ol className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{report.recommendations.strengths.map((x, i) => <li key={i}>{x}</li>)}</ol></div>
          <div><h3>Areas to improve</h3><ol className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{report.recommendations.improvements.map((x, i) => <li key={i}>{x}</li>)}</ol></div>
        </div>
        {report.recommendations.exercises.length > 0 && <div><h3>Practice exercises</h3><ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{report.recommendations.exercises.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        {report.recommendations.better_response && (
          <div data-testid="better-line"><h3>The weakest moment, and the words to use instead</h3>
            {report.recommendations.better_response.instead_of && <p className="small muted" style={{ marginTop: 6 }}>Instead of{report.recommendations.better_response.turn ? ` (turn ${report.recommendations.better_response.turn})` : ''}: "{report.recommendations.better_response.instead_of}"</p>}
            <p className="small strong" style={{ marginTop: 6 }}>Say:</p>
            <div className="quote" style={{ marginTop: 6, borderLeftColor: 'var(--good)', background: 'var(--good-l)' }}>{report.recommendations.better_response.try}</div></div>
        )}
        {report.recommendations.next_scenario && <div><h3>Recommended next practice</h3><p className="small" style={{ marginTop: 6 }}><b>{report.recommendations.next_scenario.name}.</b> {report.recommendations.next_scenario.why}</p></div>}
      </div>
    </div>
  );
}

export function Transcript({ items, persona }) {
  let c = 0;
  return (
    <div className="card">
      <h2 style={{ marginBottom: 10 }}>Call transcript</h2>
      {items.map((it, i) => (
        <div key={i} className={'tline ' + it.r}>
          <b>{fmtDur(it.t / 1000)} {it.r === 'c' ? `· C${++c}` : ''}</b>
          <p><span className="strong">{it.r === 'c' ? 'Candidate' : persona?.name || 'Teacher'}:</span> {it.x}</p>
        </div>
      ))}
      <p className="tiny muted mt">The candidate's words are as heard by the browser's speech recognition, so small errors are possible.</p>
    </div>
  );
}
