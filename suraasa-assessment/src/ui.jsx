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
      <svg width="132" height="132" viewBox="0 0 132 132"><circle cx="66" cy="66" r={r} fill="none" stroke="#eaedf5" strokeWidth="10" /><circle cx="66" cy="66" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} /></svg>
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

export function downloadText(filename, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: type + ';charset=utf-8' }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
