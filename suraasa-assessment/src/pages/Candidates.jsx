import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { rpc } from '../api.js';
import { Badge, Bar, Btn, CodeReveal, Empty, Field, Input, Area, Pager, Select, Modal, STATUS, LEVEL_NAMES, fmtDate, fmtDateTime, fmtDur, go, recTone, useAction, usePager } from '../ui.jsx';
import { useAdmin, latestScored, latestDecision } from './admin.jsx';

function CandidateForm({ cand, onClose, onCode }) {
  const { data, isAdmin, reload } = useAdmin();
  const [f, setF] = useState(cand || { name: '', email: '', phone: '', role_applied: 'Pre-Sales Intern', source: '', notes: '', recruiter_id: data.user.id });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const staff = data.users.filter((u) => u.role !== 'candidate' && u.active !== false);
  async function save(e) {
    e.preventDefault();
    const r = await run(() => rpc('saveCandidate', f));
    if (!r) return;
    reload();
    if (r.access_code) onCode({ name: f.name, email: f.email, code: r.access_code }); else onClose();
  }
  return (
    <Modal title={cand ? 'Edit candidate' : 'Add a candidate'} onClose={onClose}>
      <form className="col" onSubmit={save}>
        <Field label="Full name"><Input required value={f.name} onChange={set('name')} /></Field>
        <Field label="Email" hint={cand ? 'Changing it creates a new access code' : 'They sign in with this'}><Input required type="email" value={f.email} onChange={set('email')} /></Field>
        <div className="grid g2">
          <Field label="Phone" hint="optional"><Input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Role applied for"><Input value={f.role_applied} onChange={set('role_applied')} /></Field>
        </div>
        <Field label="Source" hint="optional, for example the college or drive"><Input value={f.source} onChange={set('source')} /></Field>
        {isAdmin && <Field label="Recruiter"><Select value={f.recruiter_id} onChange={set('recruiter_id')} options={staff.map((u) => [u.id, u.name])} /></Field>}
        <Field label="Notes" hint="optional, seen by recruiters only"><Area value={f.notes} onChange={set('notes')} /></Field>
        <div className="row"><Btn kind="primary" type="submit" busy={busy}>{cand ? 'Save' : 'Add candidate'}</Btn><Btn onClick={onClose}>Cancel</Btn></div>
      </form>
    </Modal>
  );
}

function AssignForm({ cand, onClose }) {
  const { data, reload, isAdmin } = useAdmin();
  const tpls = data.templates.filter((t) => t.active);
  const active = data.personas.filter((p) => p.active);
  const [f, setF] = useState({ template_id: tpls[0]?.id || '', persona_mode: 'random', persona_ids: [], level: 0, duration_min: tpls[0]?.data.duration_min || 8, attempts: tpls[0]?.data.attempts || 1, due: '', allow_typed: false, practice: false, per_day: 3 });
  const [run, busy] = useAction();
  const trainingTpl = tpls.find((t) => t.id === 't_training');
  const trainingIds = active.filter((p) => p.id.startsWith('tr')).map((p) => p.id);
  // Intern practice: the intern picks any listed teacher, as often as the daily limit allows, and sees full feedback.
  const setKind = (practice, pack) => setF(practice
    ? { ...f, practice: true, persona_mode: 'practice', level: 0, template_id: pack?.template_id || trainingTpl?.id || f.template_id, duration_min: trainingTpl?.data.duration_min || 15, persona_ids: pack?.persona_ids || (trainingIds.length ? trainingIds : active.map((p) => p.id)) }
    : { ...f, practice: false, persona_mode: 'random', persona_ids: [], template_id: tpls[0]?.id || '', duration_min: tpls[0]?.data.duration_min || 8, attempts: tpls[0]?.data.attempts || 1 });
  const install = async () => { const r = await run(() => rpc('installTraining'), 'Training teachers and rubric added'); if (r) { await reload(); setKind(true, r); } };
  const toggle = (id) => setF({ ...f, persona_ids: f.persona_mode === 'fixed' ? [id] : f.persona_ids.includes(id) ? f.persona_ids.filter((x) => x !== id) : [...f.persona_ids, id] });
  const shown = active;
  async function save(e) {
    e.preventDefault();
    const r = await run(() => rpc('saveAssignment', { ...f, candidate_id: cand.id }), 'Mock call assigned');
    if (r) { reload(); onClose(); }
  }
  return (
    <Modal title={`Assign a mock call to ${cand.name}`} onClose={onClose} wide>
      <form className="col" onSubmit={save}>
        <div className="row gap-s wrap" data-testid="assign-kind">
          <button type="button" className={'btn sm ' + (!f.practice ? 'primary' : '')} onClick={() => setKind(false)}>Hiring assessment</button>
          <button type="button" className={'btn sm ' + (f.practice ? 'primary' : '')} onClick={() => setKind(true)} data-testid="kind-practice">Intern practice</button>
          <span className="small muted">{f.practice ? 'The intern calls any teacher below, several times a day, and sees full feedback after each call.' : 'A fixed number of attempts, scored for a hiring recommendation.'}</span>
        </div>
        {f.practice && (!trainingTpl || trainingIds.length < 10) && (
          <div className="note">The intern training pack (10 training teachers and the 8-skill, 100-mark rubric) has not been fully added to this site yet.
            {isAdmin ? <div className="mt"><Btn size="sm" onClick={install} busy={busy} data-testid="install-training">Add the training pack</Btn></div> : ' Ask a Super Admin to add it from this screen.'}</div>
        )}
        <div className="grid g2">
          <Field label="Assessment template"><Select value={f.template_id} onChange={(e) => { const t = tpls.find((x) => x.id === e.target.value); setF({ ...f, template_id: e.target.value, duration_min: t.data.duration_min, attempts: t.data.attempts }); }} options={tpls.map((t) => [t.id, t.name])} /></Field>
          <Field label="Difficulty level"><Select value={f.level} onChange={(e) => setF({ ...f, level: Number(e.target.value) })} options={Object.entries(LEVEL_NAMES)} /></Field>
          <Field label="Call length" hint="minutes, up to 20"><Input type="number" min="3" max="20" value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: e.target.value })} /></Field>
          {f.practice
            ? <Field label="Practice calls a day" hint="1 to 10"><Input type="number" min="1" max="10" value={f.per_day} onChange={(e) => setF({ ...f, per_day: e.target.value })} /></Field>
            : <Field label="Attempts allowed"><Input type="number" min="1" max="5" value={f.attempts} onChange={(e) => setF({ ...f, attempts: e.target.value })} /></Field>}
          <Field label={f.practice ? 'Practice open until' : 'Complete by'} hint="optional"><Input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
          {!f.practice && <Field label="Teacher"><Select data-testid="persona-mode" value={f.persona_mode} onChange={(e) => setF({ ...f, persona_mode: e.target.value, persona_ids: [] })} options={[['random', 'Random teacher, hidden until the call'], ['fixed', 'One teacher I choose'], ['choice', 'Candidate picks from my shortlist']]} /></Field>}
        </div>
        <div>
          <div className="small strong" style={{ marginBottom: 8 }}>{f.practice ? 'Teachers the intern can call' : f.persona_mode === 'random' ? 'Limit the random draw to these teachers (optional: none ticked means all)' : f.persona_mode === 'fixed' ? 'Choose one teacher' : 'Choose two or more teachers'}</div>
          <div className="grid g2">
            {shown.map((p) => (
              <label key={p.id} className="card flat tight row" style={{ cursor: 'pointer', borderColor: f.persona_ids.includes(p.id) ? 'var(--blue)' : undefined }}>
                <input type={f.persona_mode === 'fixed' ? 'radio' : 'checkbox'} name="persona" checked={f.persona_ids.includes(p.id)} onChange={() => toggle(p.id)} />
                <span className="grow"><b>{p.label || p.name}</b><br /><span className="small muted">{p.name} · {p.eval_focus}</span></span><Badge>{p.difficulty}</Badge>
              </label>
            ))}
          </div>
        </div>
        <label className="row small"><input type="checkbox" checked={f.allow_typed} onChange={(e) => setF({ ...f, allow_typed: e.target.checked })} />Allow a typed call if the candidate's browser or microphone cannot do voice (the report says it was typed)</label>
        <div className="row"><Btn kind="primary" type="submit" busy={busy}>Assign</Btn><Btn onClick={onClose}>Cancel</Btn></div>
      </form>
    </Modal>
  );
}

export default function Candidates() {
  const { data, users } = useAdmin();
  const [q, setQ] = useState('');
  const [show, setShow] = useState('active');
  const [form, setForm] = useState(false);
  const [code, setCode] = useState(null);
  // Typing in the search box stays instant: the list is filtered a moment later, and only one page of it is drawn.
  const dq = useDeferredValue(q);
  const all = useMemo(() => data.candidates.filter((c) => c.status === show && (c.name + c.email + c.code).toLowerCase().includes(dq.toLowerCase())).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)), [data.candidates, show, dq]);
  const pager = usePager(all, 25);
  const { setPage } = pager;
  useEffect(() => { setPage(0); }, [dq, show, setPage]);
  const rows = pager.rows;
  return (
    <>
      <div className="head"><div><h1>Candidates</h1><p className="muted">{data.candidates.filter((c) => c.status === 'active').length} active</p></div><Btn kind="primary" onClick={() => setForm(true)} data-testid="add-candidate">Add a candidate</Btn></div>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <div style={{ flex: '1 1 240px', maxWidth: 360 }}><Input placeholder="Search name, email or ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search candidates" /></div>
        <div className="row gap-s">{[['active', 'Active'], ['archived', 'Archived']].map(([v, t]) => <button key={v} className={'btn sm ' + (show === v ? 'primary' : '')} onClick={() => setShow(v)}>{t}</button>)}</div>
      </div>
      <div className="table-wrap">
        {!rows.length ? <Empty title={q ? 'No match' : 'No candidates here yet'}>{q ? 'Try a different search.' : 'Add a candidate to create their sign-in and assign a mock call.'}</Empty> : (
          <table>
            <thead><tr><th>ID</th><th>Candidate</th><th className="hide-l">Role</th><th className="hide-l">Recruiter</th><th>Calls</th><th>Latest score</th><th>AI recommendation</th><th>Your decision</th></tr></thead>
            <tbody>{rows.map((c) => {
              const s = latestScored(data.sessions, c.id); const d = latestDecision(data.decisions, c.id);
              const open = data.assignments.filter((a) => a.candidate_id === c.id && a.status === 'open').length;
              return (
                <tr key={c.id} className="click" onClick={() => go('/candidates/' + c.id)}>
                  <td className="num muted">{c.code}</td><td><b>{c.name}</b><div className="small muted">{c.email}</div></td><td className="hide-l">{c.role_applied}</td><td className="hide-l">{users[c.recruiter_id]?.name || '–'}</td>
                  <td>{data.sessions.filter((x) => x.candidate_id === c.id && ['scored', 'ended'].includes(x.status)).length}{!open && <span className="small muted"> · none assigned</span>}</td>
                  <td className="num strong">{s ? s.total : '–'}</td><td>{s ? <Badge tone={recTone(s.recommendation)}>{s.recommendation}</Badge> : '–'}</td><td>{d ? <Badge tone={recTone(d.decision)}>{d.decision}</Badge> : '–'}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
        <Pager p={pager} noun="candidates" />
      </div>
      {form && <CandidateForm onClose={() => setForm(false)} onCode={(c) => { setForm(false); setCode(c); }} />}
      {code && <CodeReveal {...code} onClose={() => setCode(null)} />}
    </>
  );
}

export function CandidateDetail({ id }) {
  const { data, cands, personas, templates, users, isAdmin, reload } = useAdmin();
  const [modal, setModal] = useState(null);
  const [code, setCode] = useState(null);
  const [run, busy] = useAction();
  const c = cands[id];
  if (!c) return <Empty title="Candidate not found"><a href="#/candidates">Back to candidates</a></Empty>;
  const assignments = data.assignments.filter((a) => a.candidate_id === id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const sessions = data.sessions.filter((s) => s.candidate_id === id).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  const decisions = data.decisions.filter((d) => d.candidate_id === id).sort((a, b) => (a.at < b.at ? 1 : -1));

  const reset = async () => { const r = await run(() => rpc('resetCode', { user_id: c.user_id })); if (r) setCode({ name: c.name, email: c.email, code: r.access_code }); };
  const setStatus = async (status) => { if (await run(() => rpc('setCandidateStatus', { id, status }), status === 'archived' ? 'Archived. They can no longer sign in.' : 'Restored')) reload(); };
  const cancel = async (aid) => { if (window.confirm('Cancel this assignment? The candidate will no longer be able to take it.') && await run(() => rpc('cancelAssignment', { id: aid }), 'Assignment cancelled')) reload(); };
  const remove = async () => {
    const reason = window.prompt(`Delete ${c.name} permanently?\n\nThis removes their sign-in, calls, transcripts, reports and decisions. It cannot be undone.\n\nType a reason to confirm:`);
    if (!reason || reason.trim().length < 3) return;
    if (await run(() => rpc('deleteCandidate', { id, reason }), 'Candidate deleted')) { reload(); go('/candidates'); }
  };

  return (
    <>
      <p><a href="#/candidates">All candidates</a></p>
      <div className="head mt">
        <div><h1>{c.name}</h1><p className="muted">{c.code} · {c.role_applied} · {c.email}{c.phone ? ` · ${c.phone}` : ''}</p></div>
        <div className="row wrap">
          <Btn kind="primary" onClick={() => setModal('assign')} disabled={c.status !== 'active'} data-testid="assign">Assign a mock call</Btn>
          <Btn onClick={() => setModal('edit')}>Edit</Btn>
          <Btn onClick={reset} busy={busy}>Reset access code</Btn>
          {c.status === 'active' ? <Btn onClick={() => setStatus('archived')}>Archive</Btn> : <Btn onClick={() => setStatus('active')}>Restore</Btn>}
          {isAdmin && <Btn kind="danger" onClick={remove}>Delete</Btn>}
        </div>
      </div>
      {c.status === 'archived' && <div className="note warn" style={{ marginBottom: 16 }}>Archived. This candidate cannot sign in.</div>}
      <div className="grid g2">
        <div className="card"><h2>Profile</h2>
          <dl className="kv mt"><dt>Recruiter</dt><dd>{users[c.recruiter_id]?.name || '–'}</dd><dt>Source</dt><dd>{c.source || '–'}</dd><dt>Added</dt><dd>{fmtDate(c.created_at)}</dd><dt>Notes</dt><dd>{c.notes || '–'}</dd></dl></div>
        <div className="card"><h2>Decisions</h2>
          <div className="col mt">{!decisions.length && <p className="small muted">No recruiter decision yet. Open a scored call to record one.</p>}
            {decisions.map((d) => <div key={d.id}><div className="row between"><Badge tone={recTone(d.decision)}>{d.decision}</Badge><span className="small muted">{users[d.recruiter_id]?.name} · {fmtDateTime(d.at)}</span></div>{d.reason && <p className="small" style={{ marginTop: 4 }}>{d.reason}</p>}{d.ai_recommendation && d.ai_recommendation !== d.decision && <p className="tiny muted">AI had said: {d.ai_recommendation}</p>}</div>)}</div></div>
      </div>

      <h2 className="mt-l">Assigned mock calls</h2>
      <div className="table-wrap mt">
        {!assignments.length ? <Empty title="Nothing assigned">Assign a mock call so this candidate has something to take when they sign in.</Empty> : (
          <table><thead><tr><th>Assigned</th><th className="hide-l">Template</th><th>Teacher</th><th>Level</th><th className="hide-l">Length</th><th>Attempts</th><th>Due</th><th>Status</th><th /></tr></thead>
            <tbody>{assignments.map((a) => (
              <tr key={a.id}><td className="nowrap">{fmtDate(a.created_at)}</td><td className="hide-l">{templates[a.template_id]?.name}</td>
                <td>{a.persona_mode === 'practice' ? `Practice, ${(a.persona_ids || []).length} teachers` : a.persona_mode === 'random' ? `Random${a.persona_ids?.length ? ` of ${a.persona_ids.length}` : ''}` : (a.persona_ids || []).map((p) => personas[p]?.name).join(', ')}</td>
                <td>{a.level ? `Level ${a.level}` : 'Teacher\'s own'}</td><td className="hide-l">{a.duration_min} min</td>
                <td>{a.persona_mode === 'practice' ? `${sessions.filter((s) => s.assignment_id === a.id && !s.voided && ['scored', 'ended'].includes(s.status)).length} done · ${a.attempts} a day` : `${sessions.filter((s) => s.assignment_id === a.id && !s.voided && ['scored', 'ended'].includes(s.status)).length} of ${a.attempts}`}</td><td>{a.due || '–'}</td>
                <td><Badge tone={a.status === 'open' ? 'blue' : ''}>{a.status}</Badge></td><td>{a.status === 'open' && <Btn size="sm" onClick={() => cancel(a.id)}>Cancel</Btn>}</td></tr>
            ))}</tbody></table>
        )}
      </div>

      <h2 className="mt-l">Call history</h2>
      <div className="table-wrap mt">
        {!sessions.length ? <Empty title="No calls yet">Calls appear here as soon as the candidate starts one.</Empty> : (
          <table><thead><tr><th>When</th><th>Teacher</th><th>Length</th><th>Status</th><th>Score</th><th>AI recommendation</th></tr></thead>
            <tbody>{sessions.map((s) => (
              <tr key={s.id} className="click" onClick={() => go('/session/' + s.id)}><td className="nowrap">{fmtDateTime(s.started_at)}</td><td>{personas[s.persona_id]?.name}</td><td className="num">{fmtDur(s.duration_sec)}</td>
                <td>{s.voided ? <Badge>Set aside</Badge> : <Badge tone={STATUS[s.status]?.[1]}>{STATUS[s.status]?.[0]}</Badge>} {s.flags?.tech && <Badge tone="warn">Technical issue</Badge>}</td>
                <td className="num strong">{s.total ?? '–'}</td><td>{s.recommendation ? <Badge tone={recTone(s.recommendation)}>{s.recommendation}</Badge> : '–'}</td></tr>
            ))}</tbody></table>
        )}
      </div>
      {modal === 'assign' && <AssignForm cand={c} onClose={() => setModal(null)} />}
      {modal === 'edit' && <CandidateForm cand={c} onClose={() => setModal(null)} onCode={(x) => { setModal(null); setCode(x); }} />}
      {code && <CodeReveal {...code} onClose={() => setCode(null)} />}
    </>
  );
}

export function Compare({ ids }) {
  const { data, cands, personas, templates } = useAdmin();
  const cols = ids.map((id) => ({ c: cands[id], s: latestScored(data.sessions, id) })).filter((x) => x.c && x.s).slice(0, 4);
  if (cols.length < 2) return <Empty title="Choose at least two candidates with a scored call"><a href="#/leaderboard">Back to the leaderboard</a></Empty>;
  const params = templates[cols[0].s.template_id]?.data.parameters || [];
  const best = (key) => Math.max(...cols.map((x) => x.s.scores?.[key] ?? -1));
  return (
    <>
      <p className="no-print"><a href="#/leaderboard">Back to the leaderboard</a></p>
      <div className="head mt"><div><h1>Compare candidates</h1><p className="muted">Each candidate's latest scored call</p></div><Btn onClick={() => window.print()}>Download as PDF</Btn></div>
      {new Set(cols.map((x) => x.s.template_id + ':' + x.s.template_version)).size > 1 && <div className="note warn" style={{ marginBottom: 16 }}>These calls were scored with different templates or versions, so compare with care.</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Skill</th>{cols.map(({ c }) => <th key={c.id}>{c.name}</th>)}</tr></thead>
          <tbody>
            <tr><td className="strong">Total out of 100</td>{cols.map(({ c, s }) => <td key={c.id}><a href={'#/session/' + s.id} className="strong num" style={{ fontSize: 22 }}>{s.total}</a></td>)}</tr>
            <tr><td>AI recommendation</td>{cols.map(({ c, s }) => <td key={c.id}><Badge tone={recTone(s.recommendation)}>{s.recommendation}</Badge></td>)}</tr>
            <tr><td>Teacher</td>{cols.map(({ c, s }) => <td key={c.id}>{personas[s.persona_id]?.name}<div className="small muted">{personas[s.persona_id]?.difficulty} · Level {s.level}</div></td>)}</tr>
            {params.map((p) => (
              <tr key={p.key}><td>{p.name} <span className="muted small">/ {p.max}</span></td>
                {cols.map(({ c, s }) => { const v = s.scores?.[p.key]; return <td key={c.id} style={{ minWidth: 150 }}><div className="row gap-s"><b className="num" style={{ width: 34, color: v === best(p.key) ? 'var(--good)' : undefined }}>{v ?? '–'}</b><div className="grow"><Bar value={v || 0} max={p.max} /></div></div></td>; })}</tr>
            ))}
            <tr><td>Call length</td>{cols.map(({ c, s }) => <td key={c.id} className="num">{fmtDur(s.duration_sec)}</td>)}</tr>
            <tr><td>Flags</td>{cols.map(({ c, s }) => <td key={c.id}>{s.flags?.conduct ? <Badge tone="bad">Conduct concern</Badge> : null} {s.flags?.tech ? <Badge tone="warn">Technical issue</Badge> : null} {!s.flags?.conduct && !s.flags?.tech && '–'}</td>)}</tr>
          </tbody>
        </table>
      </div>
      <p className="small muted mt">Candidates who faced different teachers or difficulty levels were tested on different things. Read the transcripts before deciding.</p>
    </>
  );
}
