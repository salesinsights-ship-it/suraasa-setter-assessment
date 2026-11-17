import React, { useRef, useState } from 'react';
import { rpc } from '../api.js';
import { Avatar, Badge, Btn, Area, Field, Icon, Input, Select, Modal, useAction } from '../ui.jsx';
import { useAdmin } from './admin.jsx';

const BLANK = {
  name: '', label: '', difficulty: 'Medium', level: 2, gender: 'female', age_range: '', experience: '', subject: '', school_type: '', public_bio: '',
  personality: '', style: '', english: 'fluent', language: 'en', interest: 5, pain_points: [], goals: [], objections: [], decision: '', behaviour: '', greeting: ['Hello?'],
  eval_focus: '', prior_knowledge: '', do_not_call: false, interrupt_after_sec: 0, active: true,
};
const lines = (v) => (Array.isArray(v) ? v.join('\n') : v || '');
const MAX_GOALS = 8;
const GOAL_IDEAS = [
  'Become a coordinator within two years',
  'Move to an international curriculum school',
  'Earn a better salary',
  'Teach abroad one day',
  'Handle a large class with confidence',
  'Hold a qualification that schools recognise',
];

/** The teacher's own goals, one row each. Admins add, reword and remove them by hand. */
function Goals({ goals, onChange, readOnly }) {
  const set = (i, v) => onChange(goals.map((g, j) => (j === i ? v : g)));
  const add = (v = '') => { if (goals.length < MAX_GOALS) onChange([...goals, v]); };
  const ideas = GOAL_IDEAS.filter((x) => !goals.some((g) => g.trim().toLowerCase() === x.toLowerCase()));
  return (
    <section className="goals" data-testid="goals">
      <div className="row between wrap">
        <div><h3 className="row gap-s"><span className="goal-mark"><Icon name="target" /></span>Goals</h3>
          <p className="small muted" style={{ marginTop: 4 }}>What this teacher wants for their own career. Candidates never see these. The teacher shares one only when asked a sincere question, and the report checks whether the candidate found them.</p></div>
        <Badge>{goals.filter((g) => g.trim()).length} of {MAX_GOALS}</Badge>
      </div>
      {goals.length === 0 && <p className="small muted goal-empty">No goals yet. {readOnly ? '' : 'Add the first one below.'}</p>}
      <ol className="goal-list">
        {goals.map((g, i) => (
          <li key={i}>
            <span className="goal-n num">{i + 1}</span>
            <input className="input" value={g} maxLength={200} onChange={(e) => set(i, e.target.value)} placeholder="For example: become head of department in three years" aria-label={`Goal ${i + 1}`} data-testid="goal-input" />
            {!readOnly && <button type="button" className="btn sm ghost" onClick={() => onChange(goals.filter((_, j) => j !== i))} aria-label={`Remove goal ${i + 1}`}>Remove</button>}
          </li>
        ))}
      </ol>
      {!readOnly && (
        <div className="row wrap gap-s">
          <Btn size="sm" onClick={() => add()} disabled={goals.length >= MAX_GOALS} data-testid="add-goal">Add a goal</Btn>
          {goals.length < MAX_GOALS && ideas.slice(0, 4).map((x) => <button key={x} type="button" className="chip" onClick={() => add(x)}>+ {x}</button>)}
        </div>
      )}
    </section>
  );
}

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
  const clean = { ...p, goals: (p.goals || []).map((x) => x.trim()).filter(Boolean), pain_points: p.pain_points.filter((x) => x.trim()), objections: p.objections.filter((x) => x.trim()), greeting: p.greeting.filter((x) => x.trim()), level: Number(p.level), interest: Number(p.interest), interrupt_after_sec: Number(p.interrupt_after_sec) };
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
          <Goals goals={p.goals || []} onChange={(goals) => setP({ ...p, goals })} readOnly={ro} />
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

const TONE = { Easy: 'good', Medium: 'warn', Hard: 'bad' };
const LANG = { en: 'English', hinglish: 'Hinglish', hi: 'Hindi', mirror: 'Any language' };

export default function Teachers() {
  const { data, isAdmin } = useAdmin();
  const [edit, setEdit] = useState(null);
  const [show, setShow] = useState('All');
  const order = { Easy: 0, Medium: 1, Hard: 2 };
  const all = [...data.personas].sort((a, b) => Number(b.active) - Number(a.active) || order[a.difficulty] - order[b.difficulty]);
  const list = show === 'All' ? all : all.filter((p) => p.difficulty === show);
  const count = (d) => data.personas.filter((p) => d === 'All' || p.difficulty === d).length;
  const noGoals = data.personas.filter((p) => p.active && !(p.goals || []).length).length;
  return (
    <>
      <div className="head"><div><span className="eyebrow">Call partners</span><h1>AI teachers</h1><p className="muted">{data.personas.filter((p) => p.active).length} active. {isAdmin ? 'Add, edit or switch off teachers here. No code changes are needed.' : 'A Super Admin can edit these. You can open any teacher to test it.'}</p></div>
        {isAdmin && <Btn kind="primary" onClick={() => setEdit(BLANK)} data-testid="new-teacher">New teacher</Btn>}</div>
      <div className="row wrap between" style={{ marginBottom: 16 }}>
        <div className="row wrap gap-s" role="group" aria-label="Filter by difficulty">
          {['All', 'Easy', 'Medium', 'Hard'].map((d) => <button key={d} type="button" className={'chip' + (show === d ? ' on' : '')} aria-pressed={show === d} onClick={() => setShow(d)}>{d} <span className="num">{count(d)}</span></button>)}
        </div>
        {isAdmin && noGoals > 0 && <span className="small muted">{noGoals} active teacher{noGoals === 1 ? ' has' : 's have'} no goals yet. Open one to add them.</span>}
      </div>
      <div className="grid g3">
        {list.map((p) => {
          const goals = p.goals || [];
          return (
            <button key={p.id} type="button" className={'card teacher ' + (TONE[p.difficulty] || '')} style={{ opacity: p.active ? 1 : 0.6 }} onClick={() => setEdit(p)} data-testid="teacher-card">
              <div className="row"><Avatar name={p.name} gender={p.gender} /><div className="grow"><div className="strong">{p.name}</div><div className="small muted">{p.label}</div></div></div>
              <div className="row wrap gap-s" style={{ margin: '12px 0 8px' }}><Badge tone={TONE[p.difficulty]}>{p.difficulty}</Badge><Badge>{LANG[p.language]}</Badge>{!p.active && <Badge>Off</Badge>}</div>
              <p className="small">{p.subject} · {p.school_type}</p>
              <div className="teacher-goals" data-testid="card-goals">
                <div className="tiny strong row gap-s"><span className="goal-mark sm"><Icon name="target" /></span>Goals</div>
                {goals.length ? <ul>{goals.slice(0, 2).map((g, i) => <li key={i}>{g}</li>)}{goals.length > 2 && <li className="muted">and {goals.length - 2} more</li>}</ul> : <p className="tiny muted">None added yet</p>}
              </div>
              <p className="small muted" style={{ marginTop: 10 }}>Tests: {p.eval_focus}</p>
            </button>
          );
        })}
      </div>
      {edit && <Editor start={edit} canEdit={isAdmin} onClose={() => setEdit(null)} />}
    </>
  );
}
