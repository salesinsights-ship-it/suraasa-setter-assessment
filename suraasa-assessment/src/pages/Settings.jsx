import React, { useEffect, useState } from 'react';
import { rpc } from '../api.js';
import { Badge, Btn, Area, CodeReveal, Field, Input, Pager, Select, Modal, Tabs, Loading, fmtDateTime, useAction, usePager } from '../ui.jsx';
import { useAdmin } from './admin.jsx';

const ROLE = { super_admin: 'Super Admin', recruiter: 'Recruiter' };

function People() {
  const { data, reload } = useAdmin();
  const [form, setForm] = useState(null);
  const [code, setCode] = useState(null);
  const [run, busy] = useAction();
  const staff = data.users.filter((u) => u.role !== 'candidate');
  const save = async (e) => {
    e.preventDefault();
    const r = await run(() => rpc('saveUser', form), form.id ? 'Saved' : null);
    if (!r) return;
    reload();
    if (r.access_code) setCode({ name: form.name, email: form.email, code: r.access_code });
    setForm(null);
  };
  const reset = async (u) => { const r = await run(() => rpc('resetCode', { user_id: u.id })); if (r) setCode({ name: u.name, email: u.email, code: r.access_code }); };
  return (
    <>
      <div className="row between wrap" style={{ marginBottom: 12 }}><p className="muted">People who can run assessments. Candidates are added on the Candidates page.</p><Btn kind="primary" onClick={() => setForm({ name: '', email: '', role: 'recruiter' })}>Add a recruiter or admin</Btn></div>
      <div className="table-wrap" tabIndex={0} role="group" aria-label="Table, scrolls sideways on small screens"><table>
        <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th><span className="sr">Actions</span></th></tr></thead>
        <tbody>{staff.map((u) => (
          <tr key={u.id}><td><b>{u.name}</b><div className="small muted">{u.email}</div></td><td>{ROLE[u.role]}</td><td><Badge tone={u.active ? 'good' : ''}>{u.active ? 'Active' : 'Off'}</Badge></td><td className="small muted">{u.last_login ? fmtDateTime(u.last_login) : 'Never'}</td>
            <td><div className="row gap-s">{u.id !== data.user.id && <Btn size="sm" onClick={() => setForm({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active })}>Edit</Btn>}<Btn size="sm" busy={busy} onClick={() => reset(u)}>Reset code</Btn></div></td></tr>
        ))}</tbody>
      </table></div>
      <div className="card mt-l"><h2>What each role can do</h2>
        <div className="grid g3 mt small">
          <div><b>Super Admin</b><br />Everything: all candidates and reports, recruiters, teachers, evaluation criteria, AI models, data retention, the audit log, and deleting candidates.</div>
          <div><b>Recruiter</b><br />Their own candidates only: add, assign calls, read transcripts and reports, compare, record recommendations, review AI scores, verify product facts, test teachers.</div>
          <div><b>Candidate</b><br />Their own assigned calls and the feedback the template allows. Never other candidates, transcripts of others, teacher instructions, or hiring recommendations.</div>
        </div></div>
      {form && (
        <Modal title={form.id ? 'Edit person' : 'Add a recruiter or admin'} onClose={() => setForm(null)}>
          <form className="col" onSubmit={save}>
            <Field label="Full name"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            {!form.id && <Field label="Work email"><Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>}
            <Field label="Role"><Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} options={Object.entries(ROLE)} /></Field>
            {form.id && <label className="row small"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />Active. Untick to stop this person signing in.</label>}
            <div className="row"><Btn kind="primary" type="submit" busy={busy}>{form.id ? 'Save' : 'Add and create access code'}</Btn><Btn onClick={() => setForm(null)}>Cancel</Btn></div>
          </form>
        </Modal>
      )}
      {code && <CodeReveal {...code} onClose={() => setCode(null)} />}
    </>
  );
}

function Engine() {
  const { data, reload } = useAdmin();
  const c = data.config;
  const [f, setF] = useState({ voice_engine: c.voice_engine || 'auto', teacher_models: (c.teacher_models || []).join('\n'), evaluator_models: (c.evaluator_models || []).join('\n'), retention_days: c.retention_days || 0, recruiters_edit_templates: !!c.recruiters_edit_templates, review_every: c.review_every || 5, record_audio: !!c.record_audio });
  const [test, setTest] = useState(null);
  const [run, busy] = useAction();
  const save = async (e) => { e.preventDefault(); if (await run(() => rpc('saveConfig', { config: f }), 'Settings saved')) reload(); };
  const check = async () => { const r = await run(() => rpc('aiTest')); if (r) setTest(r); };
  return (
    <form className="col gap-l" onSubmit={save}>
      <div className="card col">
        <div className="row between wrap"><h2>AI and voice services</h2><div className="row gap-s"><Badge tone="good">Google Sheet connected</Badge><Badge tone={data.status.ai ? 'good' : 'bad'}>{data.status.ai ? 'AI key present' : 'AI key missing'}</Badge><Badge tone={data.status.live ? 'good' : ''}>{data.status.live ? 'Live voice key present' : 'Live voice not set up'}</Badge></div></div>
        <p className="small muted">Keys are stored in Vercel, never in this site or the Sheet. Models are tried in order, so if Groq retires one the next is used. Leave a box empty to use the built-in list.</p>
        <div className="grid g2">
          <Field label="Teacher models" hint="one per line, fastest first"><Area value={f.teacher_models} onChange={(e) => setF({ ...f, teacher_models: e.target.value })} placeholder={c.default_models.teacher.join('\n')} /></Field>
          <Field label="Evaluator models" hint="one per line, strongest first"><Area value={f.evaluator_models} onChange={(e) => setF({ ...f, evaluator_models: e.target.value })} placeholder={c.default_models.evaluator.join('\n')} /></Field>
        </div>
        <Field label="Voice on calls" hint={data.status.live ? '' : 'live voice needs GEMINI_API_KEY in Vercel'}>
          <Select value={f.voice_engine} onChange={(e) => setF({ ...f, voice_engine: e.target.value })} options={[['auto', 'Live voice (Gemini) when available, standard voice otherwise'], ['browser', 'Standard browser voice only']]} />
        </Field>
        <p className="tiny muted">Live voice sounds natural and replies instantly, and candidates can interrupt. On Google's free tier the audio may be used to improve Google's products, and the transcript reaches this site through the candidate's browser, so reports mark it "not verified". Standard voice is slower and robotic, but every line is signed by the server.</p>
        <label className="row small" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={f.record_audio} onChange={(e) => setF({ ...f, record_audio: e.target.checked })} style={{ marginTop: 3 }} data-testid="record-audio" /><span><b>Record live voice calls.</b> The audio of both voices is saved to a private folder in your Google Drive ("Setter Assessment recordings") and can be played from the call's report. Callers are told before the call. Needs the latest Google Sheet script. Calls on the standard browser voice are not recorded.</span></label>
        <div className="row wrap"><Btn onClick={check} busy={busy}>Test the AI connection</Btn>{test && <span className="small muted">Your key can use {test.count} models.</span>}</div>
        {test?.live?.configured && <div className={'note small ' + (test.live.ok ? 'good' : 'bad')}>{test.live.ok ? `Live voice is ready. Google accepted the key and model ${test.live.model}.` : `Live voice is not working yet. ${test.live.error}`}</div>}
        {test?.all?.length > 0 && <details className="small"><summary>Show all models this key can use</summary><p className="muted" style={{ marginTop: 6, wordBreak: 'break-word' }}>{test.all.join(', ')}</p></details>}
        {test && <div className="grid g2 small">{[['Teacher', test.teacher], ['Evaluator', test.evaluator]].map(([t, xs]) => <div key={t}><b>{t}</b>{xs.map((m) => <div key={m.model} className="row gap-s"><Badge tone={m.available ? 'good' : 'bad'}>{m.available ? 'Available' : 'Not available'}</Badge>{m.model}</div>)}</div>)}</div>}
        <p className="tiny muted">Voice: the candidate's browser does the listening and speaking (Chrome or Edge), so there is no voice key. To use a different AI provider, set GROQ_BASE_URL in Vercel to any OpenAI-compatible service. Live voice uses a Gemini key (GEMINI_API_KEY in Vercel). To use a different voice provider, replace src/live.js or src/voice.js.</p>
      </div>
      <div className="card col">
        <h2>Data and permissions</h2>
        <div className="grid g2">
          <Field label="Delete transcripts and reports after" hint="days, 0 keeps them for good"><Input type="number" min="0" max="3650" value={f.retention_days} onChange={(e) => setF({ ...f, retention_days: e.target.value })} /></Field>
          <Field label="Ask for a human check of the AI score on 1 call in every"><Input type="number" min="1" max="50" value={f.review_every} onChange={(e) => setF({ ...f, review_every: e.target.value })} /></Field>
        </div>
        <label className="row small"><input type="checkbox" checked={f.recruiters_edit_templates} onChange={(e) => setF({ ...f, recruiters_edit_templates: e.target.checked })} />Recruiters may create and change evaluation templates</label>
        <p className="tiny muted">Deletion runs in the daily job, which also backs up the Sheet. Turn the job on from the Sheet menu: Setter Assessment, Turn on daily backup and clean-up. Score summaries are kept after a transcript is deleted.</p>
      </div>
      <div><Btn kind="primary" type="submit" busy={busy}>Save settings</Btn></div>
    </form>
  );
}

function Audit() {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { rpc('audit').then((r) => setRows(r.rows)).catch(() => setRows([])); }, []);
  const shownAll = (rows || []).filter((r) => (r.action + r.actor + r.target + r.detail).toLowerCase().includes(q.toLowerCase()));
  const pager = usePager(shownAll, 50);
  if (!rows) return <Loading />;
  const shown = pager.rows;
  return (
    <>
      <div style={{ maxWidth: 360, marginBottom: 12 }}><Input placeholder="Filter by person, action or candidate ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter the audit log" /></div>
      <div className="table-wrap" tabIndex={0} role="group" aria-label="Table, scrolls sideways on small screens"><table data-testid="audit"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
        <tbody>{shown.map((r) => <tr key={r.id}><td className="nowrap small">{fmtDateTime(r.at)}</td><td>{r.actor}</td><td><Badge>{r.action}</Badge></td><td className="small">{r.target}</td><td className="small muted">{r.detail}</td></tr>)}</tbody></table><Pager p={pager} noun="entries" /></div>
      <p className="tiny muted mt">The latest 400 entries. The full log is in the AuditLog tab of the Sheet.</p>
    </>
  );
}

export default function Settings() {
  const { isAdmin } = useAdmin();
  const [tab, setTab] = useState('people');
  if (!isAdmin) return (<><div className="head"><h1>Settings and permissions</h1></div><div className="note">Settings are managed by a Super Admin. As a recruiter you can add candidates, assign calls, review reports and record recommendations for your own candidates.</div></>);
  return (
    <>
      <div className="head"><div><h1>Settings and permissions</h1><p className="muted">People, AI services, data retention and the audit log</p></div></div>
      <Tabs tabs={[['people', 'People and roles'], ['engine', 'AI, data and permissions'], ['audit', 'Audit log']]} value={tab} onChange={setTab} />
      {tab === 'people' && <People />}
      {tab === 'engine' && <Engine />}
      {tab === 'audit' && <Audit />}
    </>
  );
}
