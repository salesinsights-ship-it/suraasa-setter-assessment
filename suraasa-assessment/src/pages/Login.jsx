import React, { useEffect, useState } from 'react';
import { rpc } from '../api.js';
import { Btn, Field, Input } from '../ui.jsx';

export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState(null);

  useEffect(() => { rpc('status').then(setStatus).catch(() => setStatus({ sheet: false, ai: false, down: true })); }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { const r = await rpc('signIn', { email, code }); onSignedIn({ token: r.token, user: r.user }); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <main className="login">
      <div className="art">
        <div className="brand" style={{ padding: 0 }}><i>S</i><div>Suraasa<small>Setter Assessment</small></div></div>
        <div>
          <h1>A real conversation, assessed fairly.</h1>
          <p>Speak with an AI teacher the way you would on a real pre-sales call. Your call is scored on what you actually say and do.</p>
          <div className="steps">
            <div><b>1</b><span>Sign in with the email and access code your recruiter sent you.</span></div>
            <div><b>2</b><span>Take a voice call with a teacher. Use Chrome or Edge on a computer, with a headset if you can.</span></div>
            <div><b>3</b><span>Your call is scored out of 100, skill by skill, with quotes from what you said.</span></div>
          </div>
        </div>
        <div className="tiny muted">For Suraasa recruitment and training use. Calls are transcribed and stored for assessment.</div>
      </div>
      <div className="form">
        <div>
          <h1>Sign in</h1>
          <p className="muted mt" style={{ marginTop: 6 }}>Use the details from your invitation.</p>
          {status && !status.sheet && (
            <div className="note warn mt">{status.down ? 'The server is not reachable right now.' : 'This site is not connected to its Google Sheet yet. An administrator needs to finish the setup in SETUP.md.'}</div>
          )}
          <form className="col mt" onSubmit={submit} style={{ marginTop: 22 }}>
            <Field label="Email"><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></Field>
            <Field label="Access code"><Input autoComplete="current-password" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }} /></Field>
            {error && <div className="note bad" role="alert">{error}</div>}
            <Btn kind="primary lg" type="submit" busy={busy}>Sign in</Btn>
          </form>
          <p className="small muted mt">No code, or it is not working? Ask your recruiter or trainer to reset it.</p>
        </div>
      </div>
    </main>
  );
}
