import React, { useEffect, useState } from 'react';
import { rpc, takeHome } from '../api.js';
import { Avatar, Badge, Btn, Empty, Loading, STATUS, fmtDateTime, fmtDur, go } from '../ui.jsx';
import { voiceSupported } from '../voice.js';

export default function CandidateHome({ user }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState({});
  useEffect(() => { const given = takeHome('myHome'); if (given) setData(given); else rpc('myHome').then(setData).catch((e) => setError(e.message)); }, []);
  if (error) return <div className="page"><div className="note bad">{error}</div></div>;
  if (!data) return <Loading />;
  const open = data.assignments.filter((a) => a.status === 'open');
  const practice = data.sessions.filter((x) => x.practice && x.total !== null && !x.voided);
  const avg = practice.length ? Math.round(practice.reduce((n, x) => n + x.total, 0) / practice.length) : 0;
  const best = practice.length ? Math.max(...practice.map((x) => x.total)) : 0;

  return (
    <div className="page">
      <div className="head">
        <div>
          <h1>Hello, {user.name.split(' ')[0]}</h1>
          <p className="muted">Candidate {data.candidate.code} · {data.candidate.role_applied}</p>
        </div>
      </div>

      {!voiceSupported() && <div className="note warn" style={{ marginBottom: 16 }}>Voice calls need Chrome or Edge. Open this page in one of those, on a computer if you can.</div>}

      {practice.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }} data-testid="progress">
          <h2>Your practice so far</h2>
          <div className="grid g3 mt">
            <div><div className="small muted">Scored calls</div><div className="strong num" style={{ fontSize: 26 }}>{practice.length}</div></div>
            <div><div className="small muted">Average score</div><div className="strong num" style={{ fontSize: 26 }}>{avg} / 100</div></div>
            <div><div className="small muted">Best score</div><div className="strong num" style={{ fontSize: 26 }}>{best} / 100</div></div>
          </div>
          {practice.length > 1 && <p className="small muted mt">Last {Math.min(6, practice.length)} calls, oldest first: {practice.slice(0, 6).reverse().map((x) => x.total).join(', ')}</p>}
        </div>
      )}

      <h2>{open.some((a) => a.practice) && open.every((a) => a.practice) ? 'Your practice calls' : 'Your assessments'}</h2>
      <div className="col mt">
        {!open.length && <div className="card"><Empty title="Nothing assigned yet">Your recruiter or trainer will assign a mock call. Check back after you hear from them.</Empty></div>}
        {open.map((a) => {
          const saved = localStorage.getItem('sa.call.' + a.id);
          const picks = a.persona_mode === 'choice' || a.practice;
          const chosen = pick[a.id] || (a.persona_mode === 'fixed' ? a.personas[0]?.id : '');
          const needsPick = picks && !chosen;
          return (
            <div className="card" key={a.id} data-testid="assignment">
              <div className="row between wrap">
                <div>
                  <h3>{a.practice ? 'Practice with an AI teacher' : 'Mock sales call'}</h3>
                  <p className="small muted">{a.practice ? `Up to ${a.duration_min} minutes a call · ${a.left} of ${a.attempts} call${a.attempts === 1 ? '' : 's'} left today` : `${a.duration_min} minutes · ${a.left} of ${a.attempts} attempt${a.attempts === 1 ? '' : 's'} left`}{a.due ? ` · ${a.practice ? 'open until' : 'complete by'} ${a.due}` : ''}</p>
                </div>
                {a.blocked ? <Badge tone="warn">{a.left ? 'Unavailable' : a.practice ? 'Done for today' : 'Completed'}</Badge> : <Badge tone="blue">Ready</Badge>}
              </div>

              {a.persona_mode === 'random' && <p className="small mt">You will be connected to a teacher chosen at random. You will see who it is when the call starts.</p>}
              {a.persona_mode !== 'random' && (
                <div className={'grid mt ' + (a.personas.length > 1 ? 'g2' : '')}>
                  {a.personas.map((p) => (
                    <button key={p.id} type="button" className="card flat tight" onClick={() => picks && setPick({ ...pick, [a.id]: p.id })}
                      style={{ textAlign: 'left', cursor: picks ? 'pointer' : 'default', borderColor: chosen === p.id && picks ? 'var(--blue)' : undefined, boxShadow: chosen === p.id && picks ? '0 0 0 3px rgba(43,80,232,.15)' : undefined }}>
                      <div className="row"><Avatar name={p.name} gender={p.gender} /><div className="grow"><div className="strong">{p.name}</div><div className="small muted">{p.subject}</div></div><Badge>{p.difficulty}</Badge></div>
                      <p className="small mt" style={{ marginTop: 10 }}>{p.public_bio}</p>
                    </button>
                  ))}
                </div>
              )}

              <div className="note mt">
                Your task: call {a.practice ? 'any teacher above' : 'this teacher'} as a Suraasa Pre-Sales intern. Introduce yourself, understand their situation, explain how Suraasa could help, handle their concerns honestly and agree a next step such as a counselling session. Speak naturally, in English, Hindi or a mix.
              </div>
              {a.blocked && <p className="small muted mt">{a.blocked}</p>}
              {!a.blocked && (
                <div className="row mt wrap">
                  <Btn kind="primary lg" disabled={needsPick} onClick={() => go(`/call/${a.id}/${chosen || ''}`)}>{saved ? 'Resume your call' : 'Get ready for the call'}</Btn>
                  {needsPick && <span className="small muted">Choose a teacher first.</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <h2 className="mt-l">Your calls</h2>
      <div className="col mt">
        {!data.sessions.length && <p className="muted">No calls yet.</p>}
        {data.sessions.map((s) => (
          <div className="card tight row between wrap" key={s.id}>
            <div><div className="strong">{s.persona_name}</div><div className="small muted">{fmtDateTime(s.started_at)} · {fmtDur(s.duration_sec)}</div></div>
            <div className="row">
              {s.voided ? <Badge>Not counted</Badge> : <Badge tone={STATUS[s.status]?.[1]}>{STATUS[s.status]?.[0] || s.status}</Badge>}
              {s.total !== null && <span className="strong num">{s.total} / 100</span>}
              {(s.feedback || s.status === 'ended') && <a className="btn sm" href={'#/result/' + s.id}>{s.status === 'ended' ? 'Check result' : 'View feedback'}</a>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
