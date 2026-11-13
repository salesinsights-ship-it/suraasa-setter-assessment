import React, { useCallback, useEffect, useRef, useState } from 'react';
import { rpc, rpcRetry } from '../api.js';
import { Avatar, Btn, Icon, Loading, fmtDur, go } from '../ui.jsx';
import { createVoice, voiceSupported, isPhone, ring } from '../voice.js';
import { createLive, liveSupported } from '../live.js';
import { uploadRecording } from '../recording.js';

const KEY = (id) => 'sa.call.' + id;
const load = (id) => { try { return JSON.parse(localStorage.getItem(KEY(id)) || 'null'); } catch { return null; } };
const save = (id, v) => { try { if (v) localStorage.setItem(KEY(id), JSON.stringify(v)); else localStorage.removeItem(KEY(id)); } catch { /* storage full or blocked */ } };

const STATE_TEXT = {
  ringing: 'Ringing', teacher: 'Teacher is speaking', listening: 'Your turn. Speak now', thinking: 'Teacher is thinking',
  reconnecting: 'Reconnecting', muted: 'You are on mute', ending: 'Ending the call',
};

export default function Call({ assignmentId, personaId }) {
  const [info, setInfo] = useState(null); // the assignment, from myHome
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('check'); // check | live | saving | scoring | done
  const [live, setLive] = useState('ringing');
  const [call, setCall] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [heard, setHeard] = useState('');
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [lang, setLang] = useState('en-IN');
  const [headset, setHeadset] = useState(false);
  const [consent, setConsent] = useState(false);
  const [mic, setMic] = useState('unknown'); // unknown | ok | blocked | none
  const [notice, setNotice] = useState('');
  const [typed, setTyped] = useState('');
  const [doneInfo, setDoneInfo] = useState(null);
  const [starting, setStarting] = useState(false);
  const tabs = useRef(null);
  const tabId = useRef(Math.random().toString(36).slice(2));

  // The same person with the site open in two tabs: when a call starts in one, any call sounding in another stops.
  useEffect(() => {
    if (!window.BroadcastChannel) return undefined;
    const ch = new BroadcastChannel('sa-call'); tabs.current = ch;
    ch.onmessage = (ev) => {
      if (ev.data?.type !== 'call-started' || ev.data.id === tabId.current) return;
      const r = ref.current;
      if (!r.voice && !r.call) return;
      window.speechSynthesis?.cancel?.();
      r.voice?.close(); r.voice = null; r.finishing = true;
      setError('A call was started in another tab, so the call in this tab was stopped. Close this tab and carry on in the other one.');
    };
    return () => { ch.close(); tabs.current = null; };
  }, []);

  const ref = useRef({ call: null, voice: null, busy: false, ended: false, reconnects: 0, finishing: false, queue: [] });
  const saved = useRef(load(assignmentId));

  useEffect(() => {
    rpc('myHome').then((d) => {
      const a = d.assignments.find((x) => x.id === assignmentId);
      if (!a) setError('This call was not found.'); else setInfo({ ...a, live: !!d.live && liveSupported(), record: !!d.record });
    }).catch((e) => setError(e.message));
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); ref.current.voice?.close(); };
  }, [assignmentId]);

  // The clock runs from the server's start time, so reloading the page cannot add time.
  useEffect(() => {
    if (phase !== 'live' || !call) return undefined;
    const tick = () => {
      const e = Math.floor((Date.now() - call.client_start) / 1000);
      setElapsed(e);
      if (call.engine === 'live' && e >= call.duration_sec - 60 && !ref.current.warned) { ref.current.warned = true; ref.current.voice?.note?.('[time: one minute left]'); }
      if (e >= call.duration_sec + 20 && !ref.current.finishing) finish('time');
    };
    tick();
    const h = setInterval(tick, 500);
    return () => clearInterval(h);
  }, [phase, call]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase !== 'live') return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const persist = (c) => { ref.current.call = c; setCall(c); save(assignmentId, c); };

  const finish = useCallback(async (reason) => {
    const r = ref.current;
    if (r.finishing || !r.call) return;
    r.finishing = true;
    r.voice?.flush?.(); // a live call may still hold a half-finished line
    const c = r.call;
    const vs = r.voice?.stats() || {};
    const meta = { ...vs, reconnects: r.reconnects + (vs.live_reconnects || 0), headset: c.headset, browser: navigator.userAgent.slice(0, 110) };
    setPhase('saving');
    if (r.audio === undefined) r.audio = (await r.voice?.stopRecording?.()) || null;
    r.voice?.close();
    try {
      const done = await rpcRetry('endCall', { callToken: c.callToken, items: c.items, chain: c.chain, meta, reason }, { tries: 6 });
      save(assignmentId, null);
      if (done.status !== 'ended') { setDoneInfo(done); setPhase('done'); return; }
      setPhase('scoring');
      // The transcript is safe first. The recording then goes up while the call is being assessed; if it fails, the call still counts.
      const upload = r.audio ? uploadRecording(c.callToken, r.audio).catch(() => false) : Promise.resolve(false);
      for (let i = 0; i < 8; i++) {
        // eslint-disable-next-line no-await-in-loop
        const s = await rpc('score', { session_id: done.session_id }).catch(() => ({ pending: true, retry_after: 10 }));
        if (!s.pending) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, Math.min(30, s.retry_after || 10) * 1000));
      }
      setPhase('recording');
      await Promise.race([upload, new Promise((res) => setTimeout(res, 120000))]);
      go('/result/' + done.session_id);
    } catch (e) {
      r.finishing = false;
      setError(e.code === 'offline' ? 'Your call could not be saved because the connection dropped. Keep this page open and press Try again.' : e.message);
      setPhase('saving-failed');
    }
  }, [assignmentId]);

  const sendTurn = useCallback(async (text, extra = {}) => {
    const r = ref.current;
    if (r.finishing || r.ended) return;
    if (r.busy) { r.queue.push(text); return; }
    r.busy = true;
    r.voice?.pause();
    setHeard(''); setLive('thinking'); setNotice('');
    try {
      const c = r.call;
      const out = await rpcRetry('turn', { callToken: c.callToken, items: c.items, chain: c.chain, text, interrupt: !!extra.interrupt }, {
        tries: 6, onRetry: (n, e) => { r.reconnects++; setLive('reconnecting'); setNotice(e.code === 'ai_rate' ? 'The AI is busy. Holding the line.' : 'Connection problem. Trying again.'); },
      });
      setNotice('');
      const next = { ...r.call, items: r.call.items.concat(out.items), chain: out.chain };
      persist(next);
      if (out.ended) r.ended = true;
      const reply = out.items[out.items.length - 1].x;
      if (next.mode !== 'typed') { setLive('teacher'); await r.voice.speak(reply, next.persona.gender); }
      r.busy = false;
      if (r.ended) { finish('teacher'); return; }
      if (r.queue.length) { const q = r.queue.join(' '); r.queue = []; sendTurn(q); return; }
      setLive(r.muted ? 'muted' : 'listening');
      if (next.mode !== 'typed') r.voice.listen();
    } catch (e) {
      r.busy = false;
      if (e.code === 'call_expired' || e.code === 'bad_transcript' || e.code === 'too_long') { finish('connection'); return; }
      setNotice(e.message + ' Say that again, or end the call.');
      setLive('listening');
      if (r.call.mode !== 'typed') r.voice.listen();
    }
  }, [finish]); // eslint-disable-line react-hooks/exhaustive-deps

  function makeVoice(c) {
    return createVoice({
      lang: c.lang, headset: c.headset, interruptAfterSec: c.interrupt_after_sec,
      onInterim: setHeard, onLevel: setLevel,
      onUtterance: (text, m) => sendTurn(text, m),
      onError: (code) => {
        if (code === 'mic_blocked') { setMic('blocked'); setNotice('The microphone is blocked. Click the lock icon in the address bar and allow it.'); }
        else if (code === 'no_mic') setNotice('No microphone was found. Check that one is connected.');
        else if (code === 'stt_network') setNotice('Speech recognition lost its connection for a moment. Keep speaking.');
      },
    });
  }

  function makeLive(c) {
    const add = (it) => { const cur = ref.current.call; persist({ ...cur, items: cur.items.concat([it]) }); };
    return createLive({
      getToken: (modelIndex, items, quiet) => rpc('liveToken', { callToken: c.callToken, model_index: modelIndex, items, greeting: c.greet, quiet: !!quiet }),
      clock: () => Date.now() - c.client_start,
      items: () => ref.current.call.items,
      canEnd: () => ref.current.call.items.filter((x) => x.r === 'c').length >= (c.hangup_after || 4),
      onItem: add, onInterim: setHeard, onLevel: setLevel,
      onState: (s) => { if (!ref.current.ringing) setLive(s); },
      onEnd: () => finish('teacher'),
      onLost: () => finish('connection'),
      record: !!c.record, headset: !!c.headset,
    });
  }

  async function checkMic() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setMic('ok');
    } catch (e) { setMic(e.name === 'NotFoundError' ? 'none' : 'blocked'); }
  }

  async function begin(resume) {
    // One call at a time: a second press while the first is still connecting does nothing, and any voice left
    // over from an earlier attempt is hung up before a new one starts.
    if (ref.current.starting) return;
    ref.current.starting = true; setStarting(true);
    window.speechSynthesis?.cancel?.();
    ref.current.voice?.close(); ref.current.voice = null;
    setError('');
    try {
      tabs.current?.postMessage({ type: 'call-started', id: tabId.current, assignment: assignmentId });
      let c = resume;
      if (!c) {
        const canVoice = info.live || voiceSupported();
        const mode = info.allow_typed && (!canVoice || mic !== 'ok') ? 'typed' : info.live ? 'live' : 'voice';
        const out = await rpc('startCall', { assignment_id: assignmentId, persona_id: personaId || undefined, lang, mode });
        c = { ...out, lang, headset, client_start: Date.now() };
      }
      ref.current.ended = false; ref.current.finishing = false; ref.current.audio = undefined;
      persist(c);
      setPhase('live');
      if (c.mode === 'live' && c.engine !== 'browser') {
        // Live voice. The teacher's own greeting replaces the one the server prepared for the standard voice.
        const liveCall = { ...c, engine: 'live', greet: c.greet || c.items[0]?.x, items: resume ? c.items : [] };
        persist(liveCall);
        const lv = makeLive(liveCall); ref.current.voice = lv;
        setLive(resume ? 'reconnecting' : 'ringing');
        ref.current.ringing = true;
        try {
          await Promise.all([lv.start(resume ? liveCall.items : null), resume ? null : ring()]);
          lv.note(resume ? '[call reconnected]' : '[call connected]'); // the teacher picks up once the ringing stops
          ref.current.ringing = false;
          setLive('listening');
          return;
        } catch (e) {
          lv.close(); ref.current.voice = null; ref.current.ringing = false;
          if (e.name === 'NotAllowedError' || e.name === 'NotFoundError') { setMic(e.name === 'NotFoundError' ? 'none' : 'blocked'); setError('The microphone could not be used. Allow it in your browser and try again.'); return; }
          if (resume || !voiceSupported()) { setError('Live voice could not be started' + (e.message ? ': ' + e.message : '.') + ' Go back and try again.'); if (resume) finish('connection'); return; }
          setNotice('Live voice could not start, so this call is using the standard voice.');
          c = { ...c, engine: 'browser' };
          persist(c);
        }
      }
      if (c.mode !== 'typed') {
        const v = makeVoice(c); ref.current.voice = v;
        await v.openMic().catch(() => {});
        if (!resume) { setLive('ringing'); await ring(); }
        const last = c.items[c.items.length - 1];
        setLive('teacher');
        await v.speak(resume ? (c.lang.startsWith('hi') ? 'हेलो? आवाज़ कट गई थी। आप बोलिए।' : 'Hello? The line dropped for a moment. Please go on.') : last.x, c.persona.gender);
        setLive('listening'); v.listen();
      } else setLive('listening');
    } catch (e) { setError(e.message); } finally { ref.current.starting = false; setStarting(false); }
  }

  function toggleMute() {
    const m = !muted; setMuted(m); ref.current.muted = m; ref.current.voice?.setMuted(m);
    if (live === 'listening' || live === 'muted') setLive(m ? 'muted' : 'listening');
  }
  function switchLang() {
    const l = lang === 'en-IN' ? 'hi-IN' : 'en-IN'; setLang(l); ref.current.voice?.setLang(l);
    if (ref.current.call) persist({ ...ref.current.call, lang: l });
  }
  function endByUser() {
    const turns = (ref.current.call?.items || []).filter((x) => x.r === 'c').length;
    if (turns < (call?.min_turns || 4) && !window.confirm('This call is too short to be assessed. If you end it now it will not be scored. End the call?')) return;
    finish('candidate');
  }

  /* ------------------------------------------------------------- screens */

  if (error && phase !== 'saving-failed') return <div className="page"><div className="note bad">{error}</div><p className="mt"><a href="#/">Back to your dashboard</a></p></div>;
  if (!info) return <Loading />;

  if (phase === 'check') {
    const resume = saved.current && Date.now() - saved.current.client_start < (saved.current.duration_sec + 600) * 1000 ? saved.current : null;
    const supported = info.live || voiceSupported();
    const canTyped = info.allow_typed;
    const ready = consent && (mic === 'ok' ? supported || canTyped : canTyped);
    return (
      <div className="page" style={{ maxWidth: 640 }}>
        <p><a href="#/">Back</a></p>
        <h1 className="mt">Before you call</h1>
        <p className="muted">This takes a minute. The call itself is {info.practice ? 'up to ' : ''}{info.duration_min} minutes.</p>
        {resume && (
          <div className="note warn mt"><b>You have a call in progress.</b> It was interrupted before it finished. You can pick it up where it stopped.
            <div className="mt"><Btn kind="primary" busy={starting} onClick={() => begin(resume)}>Resume the call</Btn></div></div>
        )}
        <div className="card mt col">
          <div className="row between wrap"><div><h3>1. Browser</h3><p className="small muted">{supported ? 'This browser supports voice calls.' : 'This browser cannot do voice calls. Use Chrome or Edge.'}</p></div><span className={'badge ' + (supported ? 'good' : 'bad')}>{supported ? 'Ready' : 'Not supported'}</span></div>
          {isPhone() && <div className="note warn small">Phones are less reliable for voice calls. A computer with Chrome or Edge works best.</div>}
          <div className="row between wrap"><div><h3>2. Microphone</h3><p className="small muted">{mic === 'ok' ? 'Microphone is allowed.' : mic === 'blocked' ? 'Blocked. Click the lock icon in the address bar, allow the microphone, then check again.' : mic === 'none' ? 'No microphone found. Connect one and check again.' : 'Allow the microphone when your browser asks.'}</p></div>
            {mic === 'ok' ? <span className="badge good">Ready</span> : <Btn size="sm" onClick={checkMic}>Check microphone</Btn>}</div>
          <div style={{ display: info.live ? 'none' : undefined }}><h3>3. How you will speak</h3>
            <div className="row mt wrap gap-s">
              {[['en-IN', 'Mostly English'], ['hi-IN', 'Mostly Hindi']].map(([v, t]) => <button key={v} type="button" className={'btn sm ' + (lang === v ? 'primary' : '')} onClick={() => setLang(v)}>{t}</button>)}
            </div>
            <p className="small muted mt">This only helps the browser hear you correctly. You can switch during the call, and you will not lose marks for speaking Hindi or Hinglish.</p></div>
          <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={headset} onChange={(e) => setHeadset(e.target.checked)} style={{ marginTop: 4 }} /><span><b>I am wearing a headset or earphones.</b><br /><span className="small muted">{info.live ? 'Strongly recommended. With a headset you can talk over the teacher, as on a real call. Without one, your microphone is paused while the teacher is speaking so the teacher does not hear their own voice, so wait for them to finish.' : 'Lets you speak while the teacher is speaking. Without one, wait for "Your turn" so the teacher\'s voice is not picked up by your microphone.'}</span></span></label>
        </div>
        <div className="card mt col">
          <h3>What to expect</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>You are calling a teacher who is played by AI. Treat it as a real call.</li>
            <li>The teacher answers first. Then introduce yourself and take the call forward.</li>
            <li>{info.live ? (headset ? 'Speak as you would on a phone call. You can talk over the teacher, and the teacher can talk over you.' : 'Speak as you would on a phone call. Without a headset, let the teacher finish before you reply.') : 'Pause when you finish a thought. The teacher replies after a short silence.'}</li>
            <li>The call ends at {info.duration_min} minutes, or earlier if you or the teacher end it. You need at least {info.min_turns} turns for it to be assessed.</li>
            <li>{info.practice ? `You have ${info.left} practice call${info.left === 1 ? '' : 's'} left today.` : `You have ${info.left} attempt${info.left === 1 ? '' : 's'}.`} A call that drops for technical reasons can be resumed.</li>
          </ul>
          <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 4 }} data-testid="consent" /><span className="small">{info.live ? 'I understand that my voice is sent to Google\'s Gemini service to run this call and turn it into text, that Google may use it to improve its products, and that the transcript and AI assessment are stored and reviewed by Suraasa\'s ' + (info.practice ? 'training' : 'recruitment') + ' team.' + (info.record ? ' The audio of this call is recorded and kept in Suraasa\'s Google Drive.' : '') : 'I understand that my speech is turned into text by my browser\'s speech service, and that the transcript and AI assessment are stored and reviewed by Suraasa\'s ' + (info.practice ? 'training' : 'recruitment') + ' team.'}</span></label>
        </div>
        {!supported && canTyped && <div className="note mt">Your recruiter has allowed a typed call for this assessment. You will type instead of speaking.</div>}
        <div className="row mt wrap"><Btn kind="primary lg" disabled={!ready || !!info.blocked || starting} onClick={() => begin(null)} data-testid="start-call">Start the call</Btn>{!consent && <span className="small muted">Tick the box above to continue.</span>}{consent && !ready && <span className="small muted">Check your microphone first.</span>}</div>
      </div>
    );
  }

  if (phase === 'saving' || phase === 'scoring' || phase === 'recording' || phase === 'saving-failed') {
    return (
      <div className="phone-wrap"><div className="phone" style={{ justifyContent: 'center', gap: 16 }}>
        {phase !== 'saving-failed' && <span className="spin" style={{ width: 36, height: 36 }} />}
        <h1>{phase === 'saving' ? 'Saving your call' : phase === 'scoring' ? 'Assessing your call' : phase === 'recording' ? 'Saving the recording' : 'Could not save yet'}</h1>
        <p className="sub">{phase === 'scoring' ? 'This usually takes under a minute. Keep this page open.' : phase === 'saving' ? 'One moment.' : phase === 'recording' ? 'Almost done. Keep this page open.' : error}</p>
        {phase === 'saving-failed' && <Btn kind="primary" onClick={() => { setError(''); finish('connection'); }}>Try again</Btn>}
      </div></div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="page" style={{ maxWidth: 560 }}>
        <h1>Call ended</h1>
        <div className="note warn mt">This call was too short to be assessed, so it has not been scored and it has not used an attempt. An assessed call needs at least {doneInfo?.min_turns || 4} turns from you.</div>
        <div className="row mt"><Btn kind="primary" onClick={() => go('/')}>Back to your dashboard</Btn></div>
      </div>
    );
  }

  const p = call.persona;
  const left = Math.max(0, call.duration_sec - elapsed);
  const state = !online ? 'reconnecting' : live;
  const bars = [0.5, 0.8, 1, 0.7, 0.45].map((k) => 4 + Math.round(22 * Math.min(1, level * k * 1.6)));
  return (
    <div className="phone-wrap">
      <div className="phone" data-testid="phone" data-state={state}>
        <div className="conn"><span className={'dot ' + (!online || state === 'reconnecting' ? 'bad' : notice ? 'warn' : '')} />{!online ? 'No connection' : state === 'reconnecting' ? 'Reconnecting' : state === 'ringing' ? 'Calling' : 'Connected'}</div>
        <div className={'ring ' + (state === 'teacher' ? 'speaking' : '')}><Avatar name={p.name} gender={p.gender} size="lg" /></div>
        <h1>{p.name}</h1>
        <p className="sub">{p.subject}<br />{p.school_type}</p>
        <div className="timer" aria-label="Call time">{fmtDur(elapsed)}</div>
        <div className="tiny" style={{ color: left <= 60 ? '#fbbf24' : '#8a97c6' }}>{left <= 60 ? `${left} seconds left` : `${Math.ceil(left / 60)} min left`}</div>
        <div className="state" role="status" aria-live="polite">{STATE_TEXT[state]}</div>
        {call.mode !== 'typed' && <div className="meter" aria-hidden="true">{bars.map((h, i) => <i key={i} style={{ height: state === 'listening' ? h : 4 }} />)}</div>}
        <div className="heard">{notice || (heard ? `"${heard.length > 110 ? '…' + heard.slice(-110) : heard}"` : '')}</div>
        {call.mode === 'typed' && (
          <>
            <div className="bubble" data-testid="teacher-line">{call.items[call.items.length - 1].x}</div>
            <form className="typed" onSubmit={(e) => { e.preventDefault(); if (typed.trim() && !ref.current.busy) { sendTurn(typed.trim()); setTyped(''); } }}>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type what you would say" aria-label="Your reply" maxLength={1200} /><Btn kind="primary" type="submit" disabled={state !== 'listening'}>Send</Btn>
            </form>
          </>
        )}
        <div className="controls">
          {call.mode !== 'typed' && <button className={'cbtn ' + (muted ? 'on' : '')} onClick={toggleMute} aria-pressed={muted}><i><Icon name={muted ? 'micOff' : 'mic'} /></i>{muted ? 'Unmute' : 'Mute'}</button>}
          <button className="cbtn end" onClick={endByUser} data-testid="end-call"><i><Icon name="hang" /></i>End call</button>
          {call.mode !== 'typed' && call.engine !== 'live' && <button className="cbtn" onClick={switchLang}><i><Icon name="lang" /></i>{lang === 'en-IN' ? 'English' : 'हिंदी'}</button>}
        </div>
      </div>
    </div>
  );
}
