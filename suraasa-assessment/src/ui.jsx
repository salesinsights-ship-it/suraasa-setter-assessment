import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

/* ---------------------------------------------------------------- helpers */

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
export const fmtDur = (sec) => { const s = Math.max(0, Math.round(sec || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const initials = (name) => String(name || '?').replace(/^Dr\.?\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
export const recTone = (r) => ({ 'Strongly Recommended': 'good', Recommended: 'blue', Borderline: 'warn', 'Not Recommended': 'bad', 'Ready for live calls': 'good', 'Nearly ready': 'blue', 'Needs more practice': 'warn', 'Needs coaching': 'bad' }[r] || '');
export const pctTone = (p) => (p >= 75 ? 'good' : p >= 50 ? '' : p >= 35 ? 'warn' : 'bad');
export const STATUS = {
  in_progress: ['In progress', 'blue'], ended: ['Awaiting score', 'warn'], scored: ['Scored', 'good'],
  incomplete: ['Too short to assess', 'warn'], abandoned: ['Dropped', ''],
};
export const LEVEL_NAMES = { 0: 'Teacher\'s own level', 1: 'Level 1: Beginner', 2: 'Level 2: Intermediate', 3: 'Level 3: Advanced' };

export function useHash() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const on = () => { setHash(window.location.hash || '#/'); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#/, '').split('/').filter(Boolean);
}
export const go = (path) => { window.location.hash = '#' + path; };

/* ------------------------------------------------------------------ toast */

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [t, setT] = useState(null);
  const show = useCallback((text, bad = false) => { setT({ text, bad, id: Date.now() }); }, []);
  useEffect(() => { if (!t) return undefined; const h = setTimeout(() => setT(null), t.bad ? 6000 : 3200); return () => clearTimeout(h); }, [t]);
  return <ToastCtx.Provider value={show}>{children}{t && <div className={'toast' + (t.bad ? ' bad' : '')} role="status">{t.text}</div>}</ToastCtx.Provider>;
}

/** Runs an action, shows a busy state, and reports any error in plain words. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okText) => {
    setBusy(true);
    try { const out = await fn(); if (okText) toast(okText); return out; } catch (e) { toast(e.message || 'Something went wrong.', true); return null; } finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}

/* ----------------------------------------------------------------- pieces */

export const Btn = ({ kind = '', size = '', busy, children, ...p }) => (
  <button type="button" className={`btn ${kind} ${size}`} {...p} disabled={busy || p.disabled} aria-busy={busy || undefined}>{busy && <span className="spin" style={{ width: 14, height: 14, borderWidth: 2 }} />}{busy ? 'Working, please wait' : children}</button>
);
export const Badge = ({ tone = '', children }) => <span className={'badge ' + tone}>{children}</span>;
export const Field = ({ label, hint, children }) => <label className="field"><span>{label} {hint && <em>{hint}</em>}</span>{children}</label>;
export const Input = (p) => <input className="input" {...p} />;
export const Area = (p) => <textarea className="input" {...p} />;
export const Select = ({ options, ...p }) => <select className="input" {...p}>{options.map((o) => (Array.isArray(o) ? <option key={o[0]} value={o[0]}>{o[1]}</option> : <option key={o} value={o}>{o}</option>))}</select>;
export const Loading = ({ text = 'Loading' }) => <div className="loading"><span className="spin" /><span>{text}</span></div>;
/** A grey outline of a page (title, summary cards, table rows) shown while its data is on the way. */
export const Skeleton = ({ label = 'Loading' }) => (
  <div role="status" aria-label={label} data-testid="skeleton">
    <div className="skel" style={{ height: 28, width: 220, marginBottom: 10 }} />
    <div className="skel" style={{ height: 14, width: 320, maxWidth: '80%', marginBottom: 22 }} />
    <div className="grid g4 keep2">{[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 76 }} />)}</div>
    <div className="col" style={{ marginTop: 24, gap: 8 }}>{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skel" style={{ height: 40 }} />)}</div>
  </div>
);

/** Splits a long list into pages so a table with hundreds of rows stays quick to draw and easy to scan. */
export function usePager(rows, size = 25) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(page, pages - 1);
  return { rows: rows.slice(at * size, at * size + size), page: at, pages, setPage, total: rows.length, size };
}
export function Pager({ p, noun = 'rows' }) {
  if (p.total <= p.size) return null;
  return (
    <div className="pager no-print" data-testid="pager">
      <span>{p.page * p.size + 1} to {Math.min(p.total, (p.page + 1) * p.size)} of {p.total} {noun}</span>
      <span className="row gap-s"><button className="btn sm" disabled={p.page === 0} onClick={() => p.setPage(p.page - 1)}>Previous</button><button className="btn sm" disabled={p.page >= p.pages - 1} onClick={() => p.setPage(p.page + 1)}>Next</button></span>
    </div>
  );
}

export const Empty = ({ title, children }) => <div className="empty"><h3>{title}</h3><p className="small mt">{children}</p></div>;
export const Bar = ({ value, max = 100 }) => { const p = max ? (value / max) * 100 : 0; return <div className={'bar ' + pctTone(p)}><i style={{ width: Math.max(0, Math.min(100, p)) + '%' }} /></div>; };
export const Avatar = ({ name, gender, size = '' }) => <div className={`avatar ${gender === 'male' ? 'm' : ''} ${size}`} aria-hidden="true">{initials(name)}</div>;

export function Tabs({ tabs, value, onChange }) {
  return <div className="tabs no-print" role="tablist">{tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={value === id} className={'tab' + (value === id ? ' on' : '')} onClick={() => onChange(id)}>{label}</button>)}</div>;
}

export function Modal({ title, onClose, wide, children }) {
  useEffect(() => { const on = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: 16 }}><h2>{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Close">Close</button></div>
        {children}
      </div>
    </div>
  );
}

export function CodeReveal({ name, email, code, onClose }) {
  const toast = useToast();
  const text = `Suraasa Setter Assessment\nSign in at: ${window.location.origin}\nEmail: ${email}\nAccess code: ${code}`;
  return (
    <Modal title="Access code" onClose={onClose}>
      <p>Share this privately with <b>{name}</b>. It is shown once and cannot be looked up later. If it is lost, reset it.</p>
      <div className="code mt" data-testid="access-code">{code}</div>
      <p className="small muted mt">Signs in with: {email}</p>
      <div className="row mt"><Btn kind="primary" onClick={() => { navigator.clipboard?.writeText(text).then(() => toast('Copied')); }}>Copy sign-in details</Btn><Btn onClick={onClose}>Done</Btn></div>
    </Modal>
  );
}

export function ScoreRing({ value, label = 'out of 100' }) {
  const r = 58; const c = 2 * Math.PI * r; const p = Math.max(0, Math.min(100, value || 0));
  const color = p >= 75 ? 'var(--good)' : p >= 50 ? 'var(--blue)' : p >= 35 ? 'var(--amber)' : 'var(--bad)';
  return (
    <div className="ringscore">
      <svg width="132" height="132" viewBox="0 0 132 132"><circle cx="66" cy="66" r={r} fill="none" stroke="#f1f5f9" strokeWidth="10" /><circle cx="66" cy="66" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} /></svg>
      <div><b className="num">{value ?? '–'}</b><span>{label}</span></div>
    </div>
  );
}

const paths = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm13 10v-2a4 4 0 0 0-3-3.87M16 3.130a4 4 0 0 1 0 7.750',
  trophy: 'M8 21h8m-4-4v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1a3 3 0 0 0 3 3m10-4h3v1a3 3 0 0 1-3 3',
  teacher: 'M22 10L12 5 2 10l10 5 10-5zM6 12v5c3 2 9 2 12 0v-5',
  sliders: 'M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.400-3a7.400 7.400 0 0 0-.1-1.300l2-1.600-2-3.400-2.400 1a7.400 7.400 0 0 0-2.200-1.300L14.300 3h-4l-.4 2.400a7.400 7.400 0 0 0-2.200 1.300l-2.400-1-2 3.400 2 1.600a7.400 7.400 0 0 0 0 2.600l-2 1.600 2 3.400 2.400-1a7.400 7.400 0 0 0 2.200 1.300l.4 2.400h4l.4-2.400a7.400 7.400 0 0 0 2.200-1.300l2.400 1 2-3.400-2-1.600c.070-.4.1-.9.1-1.300z',
  mic: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zm7 10v1a7 7 0 0 1-14 0v-1m7 8v4m-4 0h8',
  micOff: 'M1 1l22 22M9 9v3a3 3 0 0 0 5.100 2.100M15 9.300V4a3 3 0 0 0-6-.3M19 11v1c0 .7-.1 1.400-.3 2M5 11v1a7 7 0 0 0 11.500 5.400M12 19v4m-4 0h8',
  hang: 'M22 16.920v3a2 2 0 0 1-2.180 2 19.790 19.790 0 0 1-8.630-3.070 19.500 19.500 0 0 1-6-6 19.790 19.790 0 0 1-3.070-8.670A2 2 0 0 1 4.110 2h3a2 2 0 0 1 2 1.720c.127.960.361 1.903.7 2.810a2 2 0 0 1-.45 2.110L8.090 9.910a16 16 0 0 0 6 6l1.270-1.270a2 2 0 0 1 2.110-.45c.907.339 1.850.573 2.810.7A2 2 0 0 1 22 16.920z',
  lang: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2c2.500 2.700 3.900 6.200 4 10-.1 3.800-1.500 7.300-4 10-2.500-2.700-3.900-6.200-4-10 .1-3.800 1.500-7.300 4-10z',
};
export const Icon = ({ name }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={name === 'hang' ? { transform: 'rotate(135deg)' } : undefined}><path d={paths[name]} /></svg>;

/* ---------------------------------------------------------- confirmations */

const ConfirmCtx = createContext(async () => false);
/**
 * Asks before anything that cannot be undone. `await confirm({ title, body, ok, danger })` gives true or false.
 * With `input: { label, min }` it asks for a written reason and gives the text, or null if cancelled.
 */
export const useConfirm = () => useContext(ConfirmCtx);
export function ConfirmProvider({ children }) {
  const [q, setQ] = useState(null);
  const [text, setText] = useState('');
  const ask = useCallback((opts) => new Promise((resolve) => { setText(''); setQ({ ...opts, resolve }); }), []);
  const close = (value) => { q.resolve(value); setQ(null); };
  const need = q?.input ? (q.input.min || 1) : 0;
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {q && (
        <Modal title={q.title} onClose={() => close(q.input ? null : false)}>
          <form className="col" data-testid="confirm" onSubmit={(e) => { e.preventDefault(); if (!q.input || text.trim().length >= need) close(q.input ? text.trim() : true); }}>
            {q.body && <p style={{ whiteSpace: 'pre-line' }}>{q.body}</p>}
            {q.input && <Field label={q.input.label} hint={need > 1 ? `at least ${need} characters` : ''}><Input autoFocus value={text} onChange={(e) => setText(e.target.value)} data-testid="confirm-input" /></Field>}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Btn onClick={() => close(q.input ? null : false)}>{q.cancel || 'Cancel'}</Btn>
              <Btn kind={q.danger ? 'danger' : 'primary'} type="submit" disabled={!!q.input && text.trim().length < need} data-testid="confirm-ok" autoFocus={!q.input}>{q.ok || 'Confirm'}</Btn>
            </div>
          </form>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

/* ------------------------------------------------------------------ charts */

/**
 * One line over time: a 2px line, a dot per point, light grid, and a tooltip that follows the pointer.
 * `points` is [{ label, value, note }] in time order. A single series, so the title names it and there is no legend.
 */
export function TrendChart({ points, max = 100, height = 180, unit = '' }) {
  const [at, setAt] = useState(null);
  if (points.length < 2) return <p className="small muted">A trend appears once there are scored calls on two different days.</p>;
  const W = 640; const H = height; const L = 34; const R = 14; const T = 12; const B = 26;
  const x = (i) => L + (i * (W - L - R)) / (points.length - 1);
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join('');
  const ticks = [0, max / 2, max];
  const every = Math.ceil(points.length / 7);
  const move = (e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; setAt(Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1))))); };
  const p = at === null ? null : points[at];
  return (
    <div style={{ position: 'relative' }} data-testid="trend">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Trend from ${points[0].value}${unit} on ${points[0].label} to ${points[points.length - 1].value}${unit} on ${points[points.length - 1].label}`} onMouseMove={move} onMouseLeave={() => setAt(null)} style={{ display: 'block', touchAction: 'none' }}>
        {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth="1" /><text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#5b6b82">{t}</text></g>)}
        {points.map((q, i) => (i % every === 0 || i === points.length - 1) && <text key={i} x={x(i)} y={H - 8} textAnchor={i === points.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'} fontSize="11" fill="#5b6b82">{q.label}</text>)}
        {p && <line x1={x(at)} x2={x(at)} y1={T} y2={H - B} stroke="#cbd5e1" strokeWidth="1" />}
        <path d={path} fill="none" stroke="#4666f6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((q, i) => <circle key={i} cx={x(i)} cy={y(q.value)} r={at === i ? 5 : 4} fill="#4666f6" stroke="#fff" strokeWidth="2" />)}
      </svg>
      {p && <div className="small" style={{ position: 'absolute', top: 0, left: `${(x(at) / W) * 100}%`, transform: `translateX(${at > points.length / 2 ? '-105%' : '5%'})`, background: '#0f172a', color: '#fff', padding: '6px 10px', borderRadius: 8, pointerEvents: 'none', whiteSpace: 'nowrap', boxShadow: 'var(--shadow-l)' }}><b>{p.value}{unit}</b> · {p.label}{p.note ? <div style={{ opacity: 0.8 }}>{p.note}</div> : null}</div>}
    </div>
  );
}

/** A tiny line of recent scores beside a number. The number carries the value; this only shows the direction. */
export function Spark({ values, max = 100 }) {
  if (values.length < 2) return null;
  const W = 72; const H = 22;
  const pts = values.map((v, i) => `${(2 + (i * (W - 4)) / (values.length - 1)).toFixed(1)},${(2 + (1 - v / max) * (H - 4)).toFixed(1)}`);
  const last = pts[pts.length - 1].split(',');
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" style={{ display: 'block', marginTop: 4 }}><polyline points={pts.join(' ')} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /><circle cx={last[0]} cy={last[1]} r="2.5" fill="#4666f6" /></svg>;
}

/** Loads a call recording on request and plays it. The audio is fetched only when someone presses the button. */
export function Recording({ sessionId, rec, load }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]); // free the audio from memory when the page is left
  if (!rec?.parts) return null;
  const fetchIt = async () => {
    setError(''); setBusy('Loading');
    try { setUrl(await load(sessionId, rec, (n, of) => setBusy(`Loading ${Math.round((n / of) * 100)}%`))); } catch (e) { setError(e.message || 'The recording could not be loaded.'); }
    setBusy('');
  };
  return (
    <div className="card row between wrap no-print" data-testid="recording" style={{ marginBottom: 16 }}>
      <div><h3>Call recording</h3><p className="small muted">{url ? 'Both voices, as recorded in the caller\'s browser.' : `About ${Math.max(1, Math.round((rec.bytes || 0) / 1048576 * 10) / 10)} MB. Loaded only when you ask for it.`}</p>{error && <p className="small" style={{ color: 'var(--bad)' }}>{error}</p>}</div>
      {url ? <div className="row wrap"><audio controls src={url} data-testid="recording-audio" /><a className="btn sm" href={url} download={`call-${sessionId}.${(rec.mime || '').includes('mp4') ? 'm4a' : (rec.mime || '').includes('ogg') ? 'ogg' : 'webm'}`}>Download</a></div>
        : <Btn onClick={fetchIt} busy={!!busy} data-testid="load-recording">{busy || 'Listen to the call'}</Btn>}
    </div>
  );
}

export function downloadText(filename, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: type + ';charset=utf-8' }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
