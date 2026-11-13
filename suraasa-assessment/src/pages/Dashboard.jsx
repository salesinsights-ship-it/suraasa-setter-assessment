import React from 'react';
import { Badge, Empty, STATUS, fmtDateTime, go, recTone } from '../ui.jsx';
import { useAdmin, latestScored, needsReassessment, isPractice } from './admin.jsx';

export default function Dashboard() {
  const { data, cands, personas, isAdmin } = useAdmin();
  const active = data.candidates.filter((c) => c.status === 'active');
  // Hiring figures only. Interns' practice calls are on the Training page.
  const hiring = data.sessions.filter((s) => !isPractice(s, data.assignments));
  const counted = hiring.filter((s) => !s.voided);
  const completed = counted.filter((s) => ['scored', 'ended'].includes(s.status));
  const scored = counted.filter((s) => s.status === 'scored');
  const pending = data.assignments.filter((a) => a.status === 'open' && a.persona_mode !== 'practice' && cands[a.candidate_id]?.status === 'active' && completed.filter((s) => s.assignment_id === a.id).length < a.attempts);
  const best = active.map((c) => ({ c, s: latestScored(data.sessions, c.id) })).filter((x) => x.s).sort((a, b) => b.s.total - a.s.total);
  const avg = best.length ? Math.round((best.reduce((a, x) => a + x.s.total, 0) / best.length) * 10) / 10 : null;
  const strong = best.filter((x) => x.s.recommendation === 'Strongly Recommended');
  const again = needsReassessment(data);
  const unscored = counted.filter((s) => s.status === 'ended');
  const every = data.config.review_every || 5;
  const reviewDue = scored.sort((a, b) => (a.started_at < b.started_at ? -1 : 1)).filter((s, i) => i % every === 0 && !s.human);
  const unverified = data.knowledge.filter((k) => k.status === 'unverified').length;
  const recent = [...hiring].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).slice(0, 8);

  const stats = [
    ['Total candidates', active.length], ['Mock calls completed', completed.length], ['Mock calls pending', pending.length], ['Average score', avg ?? '–'],
    ['Highest score', best[0] ? `${best[0].s.total}` : '–', best[0]?.c.name], ['Strongly recommended', strong.length], ['Need another assessment', again.length],
  ];

  return (
    <>
      <div className="head"><div><h1>Recruitment dashboard</h1><p className="muted">Pre-Sales Intern mock call assessments{isAdmin ? '' : ' for your candidates'}</p></div><a className="btn primary" href="#/candidates">Add or assign candidates</a></div>

      {!data.status.ai && <div className="note bad" style={{ marginBottom: 16 }}>The AI is not connected, so calls cannot run. Add GROQ_API_KEY in Vercel and redeploy.</div>}
      {unverified > 0 && data.knowledge.every((k) => k.status !== 'verified') && <div className="note warn" style={{ marginBottom: 16 }}>No Suraasa product facts are verified yet, so reports cannot check whether a candidate's claims are accurate. <a href="#/assessments">Review the {unverified} draft facts</a>.</div>}

      <div className="grid kpis" data-testid="stats">
        {stats.map(([label, value, sub]) => <div className="card stat" key={label}><b className="num">{value}</b><span>{label}</span>{sub && <div className="small muted">{sub}</div>}</div>)}
      </div>

      <div className="grid g2 mt-l">
        <div className="card">
          <h2>Needs your attention</h2>
          <div className="col mt">
            {!again.length && !unscored.length && !reviewDue.length && <p className="muted small">Nothing right now.</p>}
            {unscored.map((s) => <a key={s.id} className="row between" href={'#/session/' + s.id}><span>{cands[s.candidate_id]?.name}: call saved but not scored</span><Badge tone="warn">Score it</Badge></a>)}
            {again.map((c) => <a key={c.id} className="row between" href={'#/candidates/' + c.id}><span>{c.name}: last call cannot be relied on</span><Badge tone="warn">Reassess</Badge></a>)}
            {reviewDue.slice(0, 5).map((s) => <a key={s.id} className="row between" href={'#/session/' + s.id}><span>{cands[s.candidate_id]?.name}: due for a human check of the AI score</span><Badge tone="blue">Review</Badge></a>)}
          </div>
        </div>
        <div className="card">
          <h2>Top candidates</h2>
          <div className="col mt">
            {!best.length && <p className="muted small">No scored calls yet.</p>}
            {best.slice(0, 5).map(({ c, s }, i) => <a key={c.id} className="row between" href={'#/session/' + s.id}><span><b className="num">{i + 1}.</b> {c.name}</span><span className="row gap-s"><Badge tone={recTone(s.recommendation)}>{s.recommendation}</Badge><b className="num">{s.total}</b></span></a>)}
          </div>
        </div>
      </div>

      <h2 className="mt-l">Recent calls</h2>
      <div className="table-wrap mt">
        {!recent.length ? <Empty title="No calls yet">Add a candidate, assign a mock call and share their access code.</Empty> : (
          <table>
            <thead><tr><th>Candidate</th><th>Teacher</th><th>When</th><th>Status</th><th>Score</th><th>AI recommendation</th></tr></thead>
            <tbody>{recent.map((s) => (
              <tr key={s.id} className="click" onClick={() => go('/session/' + s.id)}>
                <td className="strong">{cands[s.candidate_id]?.name}</td><td>{personas[s.persona_id]?.name}</td><td className="nowrap">{fmtDateTime(s.started_at)}</td>
                <td>{s.voided ? <Badge>Set aside</Badge> : <Badge tone={STATUS[s.status]?.[1]}>{STATUS[s.status]?.[0]}</Badge>}</td>
                <td className="num strong">{s.total ?? '–'}</td><td>{s.recommendation ? <Badge tone={recTone(s.recommendation)}>{s.recommendation}</Badge> : '–'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
