import React, { useState } from 'react';
import { rpc } from '../api.js';
import { Badge, Btn, Area, Empty, Field, Input, Select, Modal, Tabs, fmtDate, useAction } from '../ui.jsx';
import { useAdmin } from './admin.jsx';

const NEW_TEMPLATE = { name: '', active: true, data: { duration_min: 8, attempts: 1, min_turns: 4, candidate_feedback: 'summary', show_previous: true, thresholds: { strong: 80, recommended: 65, borderline: 50 }, parameters: [] } };

function TemplateEditor({ start, canEdit, onClose }) {
  const { reload } = useAdmin();
  const [t, setT] = useState(structuredClone(start));
  const [run, busy] = useAction();
  const d = t.data;
  const setD = (patch) => setT({ ...t, data: { ...d, ...patch } });
  const setP = (i, patch) => setD({ parameters: d.parameters.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const sum = d.parameters.reduce((a, p) => a + (Number(p.max) || 0), 0);
  const save = async (e) => { e.preventDefault(); if (await run(() => rpc('saveTemplate', { template: t }), 'Template saved')) { reload(); onClose(); } };
  return (
    <Modal title={t.id ? t.name : 'New assessment template'} onClose={onClose} wide>
      <form className="col" onSubmit={save}>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }} className="col">
          <Field label="Template name"><Input required value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
          <div className="grid g3">
            <Field label="Call length" hint="minutes, 3 to 15"><Input type="number" min="3" max="15" value={d.duration_min} onChange={(e) => setD({ duration_min: Number(e.target.value) })} /></Field>
            <Field label="Attempts" hint="1 to 5"><Input type="number" min="1" max="5" value={d.attempts} onChange={(e) => setD({ attempts: Number(e.target.value) })} /></Field>
            <Field label="Fewest candidate turns to assess"><Input type="number" min="2" max="12" value={d.min_turns} onChange={(e) => setD({ min_turns: Number(e.target.value) })} /></Field>
          </div>
          <h3>Score needed for each recommendation</h3>
          <div className="grid g3">
            <Field label="Strongly Recommended, from"><Input type="number" min="1" max="100" value={d.thresholds.strong} onChange={(e) => setD({ thresholds: { ...d.thresholds, strong: Number(e.target.value) } })} /></Field>
            <Field label="Recommended (pass mark), from"><Input type="number" min="1" max="100" value={d.thresholds.recommended} onChange={(e) => setD({ thresholds: { ...d.thresholds, recommended: Number(e.target.value) } })} /></Field>
            <Field label="Borderline, from"><Input type="number" min="1" max="100" value={d.thresholds.borderline} onChange={(e) => setD({ thresholds: { ...d.thresholds, borderline: Number(e.target.value) } })} /></Field>
          </div>
          <div className="grid g2">
            <Field label="What candidates see after a call"><Select value={d.candidate_feedback} onChange={(e) => setD({ candidate_feedback: e.target.value })} options={[['none', 'Nothing: a "submitted" message only'], ['summary', 'Score, strengths and areas to improve'], ['full', 'Full feedback on every skill']]} /></Field>
            <label className="row small" style={{ alignSelf: 'end', paddingBottom: 10 }}><input type="checkbox" checked={d.show_previous} onChange={(e) => setD({ show_previous: e.target.checked })} />Candidates can see feedback on earlier attempts</label>
          </div>
          <p className="tiny muted">Candidates never see the hiring recommendation, conduct notes or recruiter decisions, whatever is chosen here.</p>
          <div className="row between"><h3>Evaluation parameters</h3><Badge tone={sum === 100 ? 'good' : 'bad'}>{sum} of 100 marks</Badge></div>
          {d.parameters.map((p, i) => (
            <div key={i} className="card flat tight col gap-s">
              <div className="row wrap">
                <div style={{ flex: '2 1 200px' }}><Input aria-label="Parameter name" placeholder="Name" value={p.name} onChange={(e) => setP(i, { name: e.target.value })} /></div>
                <div style={{ flex: '1 1 120px' }}><Input aria-label="Key" placeholder="key" value={p.key} onChange={(e) => setP(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></div>
                <div style={{ width: 90 }}><Input aria-label="Marks" type="number" min="1" max="60" value={p.max} onChange={(e) => setP(i, { max: Number(e.target.value) })} /></div>
                {canEdit && <Btn size="sm" kind="danger" onClick={() => setD({ parameters: d.parameters.filter((_, j) => j !== i) })}>Remove</Btn>}
              </div>
              <Area aria-label="What good looks like" placeholder="What good looks like, and what to mark down" value={p.guide || ''} onChange={(e) => setP(i, { guide: e.target.value })} style={{ minHeight: 54 }} />
            </div>
          ))}
          {canEdit && <div><Btn size="sm" onClick={() => setD({ parameters: [...d.parameters, { key: 'new_' + (d.parameters.length + 1), name: '', max: 5, guide: '' }] })}>Add a parameter</Btn></div>}
          <label className="row small"><input type="checkbox" checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} />Active (can be used for new assignments)</label>
        </fieldset>
        <p className="tiny muted">Saving a change creates a new version. Calls already scored keep the version they were scored with. The keys clarity, objection and closing feed the leaderboard columns.</p>
        {canEdit && <div className="row"><Btn kind="primary" type="submit" busy={busy} disabled={sum !== 100}>Save template</Btn><Btn onClick={onClose}>Cancel</Btn></div>}
      </form>
    </Modal>
  );
}

function Facts() {
  const { data, isAdmin, users, reload } = useAdmin();
  const [edit, setEdit] = useState(null);
  const [run, busy] = useAction();
  const setStatus = async (k, status) => { if (await run(() => rpc('saveKnowledge', { item: { ...k, status } }), status === 'verified' ? 'Verified. The evaluator will use it.' : 'Updated')) reload(); };
  const save = async (e) => { e.preventDefault(); if (await run(() => rpc('saveKnowledge', { item: edit }), 'Saved')) { reload(); setEdit(null); } };
  const remove = async (k) => { if (window.confirm('Delete this fact?') && await run(() => rpc('saveKnowledge', { item: k, remove: true }), 'Deleted')) reload(); };
  const order = { unverified: 0, verified: 1, rejected: 2 };
  const rows = [...data.knowledge].sort((a, b) => order[a.status] - order[b.status]);
  const verified = rows.filter((k) => k.status === 'verified').length;
  return (
    <>
      <div className="note" style={{ marginBottom: 16 }}>
        These are the only Suraasa facts the evaluator may use to judge whether a candidate's claims are accurate. <b>{verified} verified</b>, {rows.filter((k) => k.status === 'unverified').length} waiting. Unverified drafts were taken from Suraasa's public website and are ignored until someone who knows the programme approves them. Add fees or other details only if setters are expected to state them.
      </div>
      <div className="row" style={{ marginBottom: 12 }}><Btn kind="primary" onClick={() => setEdit({ topic: '', fact: '', source: '', status: 'verified' })}>Add a fact</Btn></div>
      <div className="table-wrap">
        <table data-testid="facts">
          <thead><tr><th>Topic</th><th>Fact</th><th>Status</th><th>Updated</th><th /></tr></thead>
          <tbody>{rows.map((k) => (
            <tr key={k.id}>
              <td className="strong nowrap">{k.topic}</td>
              <td>{k.fact}{k.source && <div className="tiny"><a href={k.source} target="_blank" rel="noreferrer noopener">Source</a></div>}</td>
              <td><Badge tone={k.status === 'verified' ? 'good' : k.status === 'rejected' ? 'bad' : 'warn'}>{k.status}</Badge></td>
              <td className="small muted nowrap">{fmtDate(k.updated_at)}<br />{users[k.updated_by]?.name || (k.updated_by === 'setup' ? 'Starter draft' : '')}</td>
              <td><div className="row gap-s">
                {k.status !== 'verified' && <Btn size="sm" kind="primary" busy={busy} onClick={() => setStatus(k, 'verified')}>Verify</Btn>}
                {k.status !== 'rejected' && <Btn size="sm" onClick={() => setStatus(k, 'rejected')}>Reject</Btn>}
                <Btn size="sm" onClick={() => setEdit(k)}>Edit</Btn>
                {isAdmin && <Btn size="sm" kind="danger" onClick={() => remove(k)}>Delete</Btn>}
              </div></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit fact' : 'Add a fact'} onClose={() => setEdit(null)}>
          <form className="col" onSubmit={save}>
            <Field label="Topic"><Input required value={edit.topic} onChange={(e) => setEdit({ ...edit, topic: e.target.value })} /></Field>
            <Field label="Fact" hint="one clear statement"><Area required value={edit.fact} onChange={(e) => setEdit({ ...edit, fact: e.target.value })} /></Field>
            <Field label="Source" hint="optional link or document name"><Input value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} /></Field>
            <Field label="Status"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })} options={[['verified', 'Verified: I confirm this is correct'], ['unverified', 'Unverified: needs checking'], ['rejected', 'Rejected: do not use']]} /></Field>
            <div className="row"><Btn kind="primary" type="submit" busy={busy}>Save</Btn><Btn onClick={() => setEdit(null)}>Cancel</Btn></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function Calibration() {
  const { data, cands, templates } = useAdmin();
  const reviewed = data.sessions.filter((s) => s.human && s.status === 'scored');
  if (!reviewed.length) return <Empty title="No human reviews yet">Open a scored call and choose "Score it yourself". Once a few calls have both an AI score and a human score, this page shows how closely they agree. The dashboard reminds you to review 1 in every {data.config.review_every || 5} calls.</Empty>;
  const diffs = {};
  for (const s of reviewed) for (const p of templates[s.template_id]?.data.parameters || []) {
    const h = s.human.scores?.[p.key]; const a = s.scores?.[p.key];
    if (h === undefined || a === undefined) continue;
    (diffs[p.key] ||= { name: p.name, max: p.max, n: 0, abs: 0, bias: 0 });
    diffs[p.key].n++; diffs[p.key].abs += Math.abs(a - h) / p.max; diffs[p.key].bias += (a - h) / p.max;
  }
  const meanGap = reviewed.reduce((x, s) => x + Math.abs(s.total - s.human.total), 0) / reviewed.length;
  const bias = reviewed.reduce((x, s) => x + (s.total - s.human.total), 0) / reviewed.length;
  return (
    <>
      <div className="grid g3">
        <div className="card stat"><b className="num">{reviewed.length}</b><span>Calls reviewed by a person</span></div>
        <div className="card stat"><b className="num">{meanGap.toFixed(1)}</b><span>Average gap between AI and human, in marks</span></div>
        <div className="card stat"><b className="num">{bias > 0 ? '+' : ''}{bias.toFixed(1)}</b><span>{Math.abs(bias) < 2 ? 'No clear lean' : bias > 0 ? 'AI scores higher than people' : 'AI scores lower than people'}</span></div>
      </div>
      {meanGap > 10 && <div className="note warn mt">The AI and your reviewers differ by more than 10 marks on average. Tighten the wording of the parameters where the gap is largest, or rely more on human review until it narrows.</div>}
      <h2 className="mt-l">By skill</h2>
      <div className="table-wrap mt"><table><thead><tr><th>Skill</th><th>Reviews</th><th>Average gap</th><th>Direction</th></tr></thead>
        <tbody>{Object.values(diffs).sort((a, b) => b.abs / b.n - a.abs / a.n).map((x) => { const g = (x.abs / x.n) * x.max; const b = (x.bias / x.n) * x.max; return <tr key={x.name}><td className="strong">{x.name}</td><td className="num">{x.n}</td><td className="num">{g.toFixed(1)} of {x.max}</td><td>{Math.abs(b) < 0.25 ? 'Even' : b > 0 ? `AI higher by ${b.toFixed(1)}` : `AI lower by ${Math.abs(b).toFixed(1)}`}</td></tr>; })}</tbody></table></div>
      <h2 className="mt-l">Reviewed calls</h2>
      <div className="table-wrap mt"><table><thead><tr><th>Candidate</th><th>AI</th><th>Human</th><th>Gap</th><th>Reviewer</th></tr></thead>
        <tbody>{reviewed.map((s) => <tr key={s.id} className="click" onClick={() => { window.location.hash = '#/session/' + s.id; }}><td className="strong">{cands[s.candidate_id]?.name}</td><td className="num">{s.total}</td><td className="num">{s.human.total}</td><td className="num">{(s.total - s.human.total > 0 ? '+' : '') + (s.total - s.human.total)}</td><td>{s.human.by_name}</td></tr>)}</tbody></table></div>
    </>
  );
}

export default function Assessments() {
  const { data, isAdmin } = useAdmin();
  const [tab, setTab] = useState('templates');
  const [edit, setEdit] = useState(null);
  const canEdit = isAdmin || data.config.recruiters_edit_templates;
  return (
    <>
      <div className="head"><div><h1>Assessment configuration</h1><p className="muted">How calls are run, scored and checked</p></div>{tab === 'templates' && canEdit && <Btn kind="primary" onClick={() => setEdit(NEW_TEMPLATE)}>New template</Btn>}</div>
      <Tabs tabs={[['templates', 'Templates and marks'], ['facts', 'Product facts'], ['calibration', 'Calibration']]} value={tab} onChange={setTab} />
      {tab === 'templates' && (
        <div className="grid g2">
          {data.templates.map((t) => (
            <button key={t.id} type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer', opacity: t.active ? 1 : 0.55 }} onClick={() => setEdit(t)} data-testid="template-card">
              <div className="row between"><h3>{t.name}</h3><Badge>Version {t.version}</Badge></div>
              <p className="small muted mt" style={{ marginTop: 6 }}>{t.data.parameters.length} parameters · {t.data.duration_min} min · {t.data.attempts} attempt{t.data.attempts === 1 ? '' : 's'} · pass mark {t.data.thresholds.recommended}</p>
              <div className="row wrap gap-s mt">{t.data.parameters.map((p) => <Badge key={p.key}>{p.name} {p.max}</Badge>)}</div>
              {!canEdit && <p className="tiny muted mt">Only a Super Admin can change evaluation criteria.</p>}
            </button>
          ))}
        </div>
      )}
      {tab === 'facts' && <Facts />}
      {tab === 'calibration' && <Calibration />}
      {edit && <TemplateEditor start={edit} canEdit={canEdit} onClose={() => setEdit(null)} />}
    </>
  );
}
