import React, { useRef, useState } from 'react';
import { rpc } from '../api.js';
import { Avatar, Badge, Btn, Area, Field, Input, Select, Modal, useAction } from '../ui.jsx';
import { useAdmin } from './admin.jsx';

const BLANK = {
  name: '', label: '', difficulty: 'Medium', level: 2, gender: 'female', age_range: '', experience: '', subject: '', school_type: '', public_bio: '',
  personality: '', style: '', english: 'fluent', language: 'en', interest: 5, pain_points: [], objections: [], decision: '', behaviour: '', greeting: ['Hello?'],
  eval_focus: '', prior_knowledge: '', do_not_call: false, interrupt_after_sec: 0, active: true,
};
const lines = (v) => (Array.isArray(v) ? v.join('\n') : v || '');

/** A typed test call with the teacher as currently filled in, saved or not. Nothing is stored. */
function Preview({ persona }) {
  const [items, setItems] = useState([]);
  const [text, setText] = useState('');
  const [level, setLevel] = useState(persona.level || 2);
  const [run, busy] = useAction();
  const box = useRef(null);
  const scroll = () => setTimeout(() => box.current?.scrollTo(0, 99999), 30);
  const start = async () => { const r = await run(() => rpc('previewTurn', { persona, items: [], level })); if (r) { setItems([{ r: 't', x: r.reply, t: 0 }]); scroll(); } };
  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const mine = text.trim(); setText('');
    const r = await run(() => rpc('previewTurn', { persona, items, text: mine, level }));
    if (r) { setItems([...items, { r: 'c', x: mine, t: 0 }, { r: 't', x: r.reply + (r.ended ? '  (hangs up)' : ''), t: 0 }]); scroll(); }
  };
  return (
    <div className="col">
      <div className="row wrap"><h3>Test this teacher</h3><div style={{ width: 210 }}><Select value={level} onChange={(e) => setLevel(Number(e.target.value))} options={[[1, 'Level 1: Beginner'], [2, 'Level 2: Intermediate'], [3, 'Level 3: Advanced']]} aria-label="Difficulty level" /></div><Btn size="sm" busy={busy && !items.length} onClick={start}>{items.length ? 'Restart' : 'Start a test call'}</Btn></div>
      <p className="small muted">Type as the candidate would speak. This uses the teacher exactly as filled in on this form, including unsaved changes. Test calls are not stored or scored.</p>
      {items.length > 0 && (
        <>
          <div className="chat" ref={box} data-testid="preview-chat">{items.map((it, i) => <p key={i} className={it.r}>{it.x}</p>)}</div>
          <form className="row" onSubmit={send}><div className="grow"><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Hello ma'am, this is ... from Suraasa" aria-label="Your line" /></div><Btn kind="primary" type="submit" busy={busy}>Send</Btn></form>
        </>
      )}
    </div>
  );
}

function Editor({ start, canEdit, onClose }) {
  const { reload } = useAdmin();
  const [p, setP] = useState({ ...BLANK, ...start });
  const [run, busy] = useAction();
  const set = (k) => (e) => setP({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const setLines = (k) => (e) => setP({ ...p, [k]: e.target.value.split('\n') });
  const clean = { ...p, pain_points: p.pain_points.filter((x) => x.trim()), objections: p.objections.filter((x) => x.trim()), greeting: p.greeting.filter((x) => x.trim()), level: Number(p.level), interest: Number(p.interest), interrupt_after_sec: Number(p.interrupt_after_sec) };
  const save = async (e) => { e.preventDefault(); if (await run(() => rpc('savePersona', { persona: clean }), 'Teacher saved')) { reload(); onClose(); } };
  const ro = !canEdit;
  return (
    <Modal title={p.id ? p.name : 'New teacher'} onClose={onClose} wide>
      <form className="col" onSubmit={save}>
        <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0 }} className="col">
          <div className="grid g2">
            <Field label="Name"><Input required value={p.name} onChange={set('name')} /></Field>
            <Field label="Type" hint="for example: Skeptical Teacher"><Input value={p.label} onChange={set('label')} /></Field>
            <Field label="Difficulty"><Select value={p.difficulty} onChange={set('difficulty')} options={['Easy', 'Medium', 'Hard']} /></Field>
            <Field label="Usual level"><Select value={p.level} onChange={set('level')} options={[[1, 'Level 1: Beginner'], [2, 'Level 2: Intermediate'], [3, 'Level 3: Advanced']]} /></Field>
            <Field label="Voice"><Select value={p.gender} onChange={set('gender')} options={[['female', 'Female'], ['male', 'Male']]} /></Field>
            <Field label="Age range"><Input value={p.age_range} onChange={set('age_range')} /></Field>
            <Field label="Teaching experience"><Input value={p.experience} onChange={set('experience')} /></Field>
            <Field label="Subject and grades"><Input value={p.subject} onChange={set('subject')} /></Field>
            <Field label="School type and city"><Input value={p.school_type} onChange={set('school_type')} /></Field>
            <Field label="Language"><Select value={p.language} onChange={set('language')} options={[['en', 'English'], ['hinglish', 'Hindi and English mixed'], ['hi', 'Hindi'], ['mirror', 'Whatever the caller uses']]} /></Field>
            <Field label="English proficiency"><Select value={p.english} onChange={set('english')} options={['fluent', 'moderate', 'basic']} /></Field>
            <Field label="Starting interest" hint="1 cold to 10 keen"><Input type="number" min="1" max="10" value={p.interest} onChange={set('interest')} /></Field>
          </div>
          <Field label="Profile shown to the candidate" hint="like a lead card: role, school, why they are being called"><Area required value={p.public_bio} onChange={set('public_bio')} /></Field>
          <div className="note small">Everything below is hidden from candidates. It shapes how the teacher behaves.</div>
          <div className="grid g2">
            <Field label="Personality"><Area required value={p.personality} onChange={set('personality')} /></Field>
            <Field label="Communication style"><Area value={p.style} onChange={set('style')} /></Field>
            <Field label="Pain points" hint="one per line"><Area value={lines(p.pain_points)} onChange={setLines('pain_points')} /></Field>
            <Field label="Objections" hint="one per line"><Area required value={lines(p.objections)} onChange={setLines('objections')} /></Field>
            <Field label="How they decide"><Area value={p.decision} onChange={set('decision')} /></Field>
            <Field label="Behaviour on the call" hint="what changes their mood, what they reveal and when"><Area value={p.behaviour} onChange={set('behaviour')} /></Field>
            <Field label="How they answer the phone" hint="one per line, one is picked at random"><Area required value={lines(p.greeting)} onChange={setLines('greeting')} /></Field>
            <Field label="What this teacher tests" hint="shown to recruiters and the evaluator"><Area value={p.eval_focus} onChange={set('eval_focus')} /></Field>
            <Field label="What they already know about Suraasa"><Area value={p.prior_knowledge} onChange={set('prior_knowledge')} /></Field>
            <Field label="Cuts in on long speeches after" hint="seconds, 0 means never"><Input type="number" min="0" max="90" value={p.interrupt_after_sec} onChange={set('interrupt_after_sec')} /></Field>
          </div>
          <label className="row small"><input type="checkbox" checked={p.do_not_call} onChange={set('do_not_call')} />May ask not to be called again, and ends the call once the caller accepts it</label>
          <label className="row small"><input type="checkbox" checked={p.active} onChange={set('active')} />Active (can be assigned to candidates)</label>
        </fieldset>
        {canEdit && <div className="row"><Btn kind="primary" type="submit" busy={busy}>Save teacher</Btn><Btn onClick={onClose}>Cancel</Btn></div>}
      </form>
      <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '20px 0' }} />
      <Preview persona={clean} />
    </Modal>
  );
}

export default function Teachers() {
  const { data, isAdmin } = useAdmin();
  const [edit, setEdit] = useState(null);
  const order = { Easy: 0, Medium: 1, Hard: 2 };
  const list = [...data.personas].sort((a, b) => Number(b.active) - Number(a.active) || order[a.difficulty] - order[b.difficulty]);
  return (
    <>
      <div className="head"><div><h1>AI teachers</h1><p className="muted">{data.personas.filter((p) => p.active).length} active. {isAdmin ? 'Add, edit or switch off teachers here. No code changes are needed.' : 'A Super Admin can edit these. You can open any teacher to test it.'}</p></div>
        {isAdmin && <Btn kind="primary" onClick={() => setEdit(BLANK)} data-testid="new-teacher">New teacher</Btn>}</div>
      <div className="grid g3">
        {list.map((p) => (
          <button key={p.id} type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer', opacity: p.active ? 1 : 0.55 }} onClick={() => setEdit(p)} data-testid="teacher-card">
            <div className="row"><Avatar name={p.name} gender={p.gender} /><div className="grow"><div className="strong">{p.name}</div><div className="small muted">{p.label}</div></div></div>
            <div className="row wrap gap-s" style={{ margin: '12px 0 8px' }}><Badge tone={p.difficulty === 'Hard' ? 'bad' : p.difficulty === 'Medium' ? 'warn' : 'good'}>{p.difficulty}</Badge><Badge>{{ en: 'English', hinglish: 'Hinglish', hi: 'Hindi', mirror: 'Any language' }[p.language]}</Badge>{!p.active && <Badge>Off</Badge>}</div>
            <p className="small">{p.subject} · {p.school_type}</p>
            <p className="small muted" style={{ marginTop: 6 }}>Tests: {p.eval_focus}</p>
          </button>
        ))}
      </div>
      {edit && <Editor start={edit} canEdit={isAdmin} onClose={() => setEdit(null)} />}
    </>
  );
}
