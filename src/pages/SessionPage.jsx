import React, { useCallback, useEffect, useState } from 'react';
import { rpc } from '../api.js';
import { Badge, Btn, Area, Field, Input, Loading, Modal, Select, STATUS, Tabs, downloadText, fmtDateTime, fmtDur, recTone, useAction } from '../ui.jsx';
import { useAdmin } from './admin.jsx';
import ReportView, { Transcript } from './ReportView.jsx';

const RECS = ['Strongly Recommended', 'Recommended', 'Borderline', 'Not Recommended'];

function HumanReview({ d, onDone }) {
  const params = d.template.data.parameters;
  const [scores, setScores] = useState(d.session.human?.scores || Object.fromEntries(params.map((p) => [p.key, ''])));
  const [note, setNote] = useState(d.session.human?.note || '');
  const [run, busy] = useAction();
  const total = params.reduce((a, p) => a + (Number(scores[p.key]) || 0), 0);
  return (
    <Modal title="Score this call yourself" onClose={() => onDone(false)} wide>
      <p className="small muted">Read the transcript first and give your own marks without looking at the AI's. The two are compared under Assessments, Calibration, to check that the AI is scoring fairly and consistently.</p>
      <form className="col mt" onSubmit={async (e) => { e.preventDefault(); if (await run(() => rpc('humanReview', { session_id: d.session.id, scores, note }), 'Review saved')) onDone(true); }}>
        <div className="grid g2">{params.map((p) => <Field key={p.key} label={p.name} hint={`0 to ${p.max}`}><Input type="number" min="0" max={p.max} step="0.5" required value={scores[p.key]} onChange={(e) => setScores({ ...scores, [p.key]: e.target.value })} /></Field>)}</div>
        <Field label="Note" hint="optional"><Area value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="row"><Btn kind="primary" type="submit" busy={busy}>Save review ({total} / 100)</Btn><Btn onClick={() => onDone(false)}>Cancel</Btn></div>
      </form>
    </Modal>
  );
}

export default function SessionPage({ id }) {
  const { reload } = useAdmin();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('report');
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [modal, setModal] = useState(null);
  const [run, busy] = useAction();
  const load = useCallback(() => rpc('getSession', { session_id: id }).then((x) => { setD(x); setDecision((v) => v || x.session.recommendation || ''); }).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (error) return <div className="note bad">{error}</div>;
  if (!d) return <Loading text="Opening the call" />;
  const s = d.session;
  const refresh = async () => { await load(); reload(); };

  const score = async (force) => {
    const r = await run(() => rpc('score', { session_id: id, force }));
    if (r?.pending) setError(`The AI is busy. Try again in about ${r.retry_after} seconds.`); else { setError(''); refresh(); }
  };
  const submitDecision = async () => { if (await run(() => rpc('decide', { session_id: id, decision, reason }), 'Decision recorded')) { setReason(''); refresh(); } };
  const setVoid = async (voided) => {
    const why = voided ? window.prompt('Why should this attempt not count? (for example: microphone failed)') : '';
    if (voided && !why) return;
    if (await run(() => rpc('voidSession', { session_id: id, voided, reason: why }), voided ? 'Set aside. The attempt is available again.' : 'Counting again')) refresh();
  };
  const downloadTranscript = () => {
    let c = 0;
    const lines = [`Suraasa Setter Assessment: call transcript`, `Candidate: ${d.candidate.name} (${d.candidate.code})`, `Teacher: ${d.persona?.name}`, `Date: ${fmtDateTime(s.started_at)}  Length: ${fmtDur(s.duration_sec)}`, ''];
    for (const it of d.transcript) lines.push(`[${fmtDur(it.t / 1000)}] ${it.r === 'c' ? `Candidate (C${++c})` : d.persona?.name || 'Teacher'}: ${it.x}`);
    downloadText(`${d.candidate.code}-transcript.txt`, lines.join('\r\n'));
  };
  const overriding = s.recommendation && decision && decision !== s.recommendation;

  return (
    <>
      <p className="no-print"><a href={'#/candidates/' + d.candidate.id}>{d.candidate.name}</a></p>
      <div className="head mt">
        <div><h1>Candidate evaluation report</h1>
          <p className="muted">{d.candidate.name} · {d.candidate.code} · {fmtDateTime(s.started_at)} · {s.voided ? <Badge>Set aside</Badge> : <Badge tone={STATUS[s.status]?.[1]}>{STATUS[s.status]?.[0]}</Badge>} {s.mode === 'typed' && <Badge tone="warn">Typed call</Badge>}</p></div>
        <div className="row wrap no-print">
          {d.report && <Btn onClick={() => window.print()}>Download report (PDF)</Btn>}
          {d.transcript && <Btn onClick={downloadTranscript}>Download transcript</Btn>}
          {s.status === 'scored' && <Btn onClick={() => setModal('human')}>{s.human ? 'Edit your review' : 'Score it yourself'}</Btn>}
          {s.status === 'scored' && !s.purged && <Btn busy={busy} onClick={() => window.confirm('Score this call again? The current AI report will be replaced.') && score(true)}>Score again</Btn>}
          {s.voided ? <Btn onClick={() => setVoid(false)}>Count this attempt</Btn> : <Btn kind="danger" onClick={() => setVoid(true)}>Set aside</Btn>}
        </div>
      </div>

      {s.voided && <div className="note warn" style={{ marginBottom: 16 }}>This attempt was set aside and does not count. Reason: {s.void_reason}</div>}
      {s.purged && <div className="note warn" style={{ marginBottom: 16 }}>The transcript and report were deleted under the data retention setting. Only the score summary remains.</div>}
      {s.status === 'ended' && <div className="card col" style={{ marginBottom: 16 }}><h2>Saved, not yet scored</h2><p>The transcript is safe. Scoring did not finish, usually because the free AI limit was reached.</p>{error && <div className="note bad">{error}</div>}<div><Btn kind="primary" busy={busy} onClick={() => score(false)}>Score this call</Btn></div></div>}
      {s.status === 'incomplete' && <div className="note warn" style={{ marginBottom: 16 }}>This call had {s.candidate_turns} candidate turn{s.candidate_turns === 1 ? '' : 's'} and {s.candidate_words} words, which is too little to assess. It was not scored and did not use an attempt.</div>}
      {['in_progress', 'abandoned'].includes(s.status) && <div className="note" style={{ marginBottom: 16 }}>{s.status === 'in_progress' ? 'This call is in progress, or was dropped without being saved.' : 'This call was dropped and restarted. Nothing was saved from it.'}</div>}

      <Tabs tabs={[['report', 'Report'], ['transcript', 'Transcript'], ['decision', 'Your decision']]} value={tab} onChange={setTab} />

      {tab === 'report' && (d.report ? <ReportView report={d.report} staff /> : s.status === 'scored' && s.purged ? (
        <div className="card"><h2>{s.total} / 100</h2><p className="mt"><Badge tone={recTone(s.recommendation)}>{s.recommendation}</Badge></p></div>
      ) : <p className="muted">No report for this call.</p>)}
      {tab === 'report' && d.report && <div className="print-only mt">{d.transcript && <Transcript items={d.transcript} persona={d.persona} />}</div>}

      {tab === 'transcript' && (d.transcript ? <Transcript items={d.transcript} persona={d.persona} /> : <p className="muted">No transcript is stored for this call.</p>)}

      {tab === 'decision' && (
        <div className="grid g2">
          <div className="card col">
            <h2>Record your recommendation</h2>
            {s.status !== 'scored' ? <p className="muted">A recommendation can be recorded once the call is scored.</p> : (
              <>
                <p className="small muted">The AI said: <b>{s.recommendation}</b>. You make the call. If you disagree, say why, so the reason is on record.</p>
                <Field label="Your recommendation"><Select value={decision} onChange={(e) => setDecision(e.target.value)} options={RECS} data-testid="decision" /></Field>
                <Field label={overriding ? 'Reason for changing the AI recommendation' : 'Reason'} hint={overriding ? 'required' : 'optional'}><Area value={reason} onChange={(e) => setReason(e.target.value)} data-testid="reason" /></Field>
                <div><Btn kind="primary" busy={busy} onClick={submitDecision} data-testid="save-decision">Save recommendation</Btn></div>
              </>
            )}
          </div>
          <div className="card col">
            <h2>History</h2>
            {!d.decisions.length && <p className="small muted">Nothing recorded yet.</p>}
            {[...d.decisions].reverse().map((x) => <div key={x.id}><div className="row between wrap"><Badge tone={recTone(x.decision)}>{x.decision}</Badge><span className="small muted">{x.recruiter_name} · {fmtDateTime(x.at)}</span></div>{x.reason && <p className="small" style={{ marginTop: 4 }}>{x.reason}</p>}{x.ai_recommendation && x.ai_recommendation !== x.decision && <p className="tiny muted">Changed from the AI's: {x.ai_recommendation}</p>}</div>)}
            {s.human && <div className="note"><b>Human review:</b> {s.human.total} / 100 by {s.human.by_name} (AI: {s.total}). {s.human.note}</div>}
          </div>
        </div>
      )}
      {modal === 'human' && <HumanReview d={d} onDone={(saved) => { setModal(null); if (saved) refresh(); }} />}
    </>
  );
}
