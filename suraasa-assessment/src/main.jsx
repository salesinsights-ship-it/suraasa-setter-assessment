import React, { Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { getSession, setSession, rpc } from './api.js';
import { ToastProvider, ConfirmProvider, useHash, Icon, Loading, Skeleton, go } from './ui.jsx';
import Login from './pages/Login.jsx';
import { AdminProvider, useAdmin } from './pages/admin.jsx';

// Each part of the site is downloaded only when someone opens it. A candidate never downloads the recruiter
// pages, and nobody downloads the call screen (voice, live audio, recording) until they start a call.
const CandidateHome = lazy(() => import('./pages/CandidateHome.jsx'));
const Call = lazy(() => import('./pages/Call.jsx'));
const Result = lazy(() => import('./pages/Result.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Candidates = lazy(() => import('./pages/Candidates.jsx'));
const CandidateDetail = lazy(() => import('./pages/Candidates.jsx').then((m) => ({ default: m.CandidateDetail })));
const Compare = lazy(() => import('./pages/Candidates.jsx').then((m) => ({ default: m.Compare })));
const Leaderboard = lazy(() => import('./pages/Leaderboard.jsx'));
const Training = lazy(() => import('./pages/Training.jsx'));
const SessionPage = lazy(() => import('./pages/SessionPage.jsx'));
const Teachers = lazy(() => import('./pages/Teachers.jsx'));
const Assessments = lazy(() => import('./pages/Assessments.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));

const ROLE = { super_admin: 'Super Admin', recruiter: 'Recruiter', candidate: 'Candidate' };

function Brand() {
  return <div className="brand"><i>S</i><div>Suraasa<small>Setter Assessment</small></div></div>;
}

function CandidateApp({ user, signOut }) {
  const route = useHash();
  if (route[0] === 'call' && route[1]) return <main style={{ height: '100%' }}><Suspense fallback={<Loading text="Getting the call ready" />}><Call assignmentId={route[1]} personaId={route[2] || ''} /></Suspense></main>;
  return (
    <>
      <header className="topbar"><Brand /><span className="right small hide-m muted">{user.name}</span><button className="btn sm" onClick={signOut}>Sign out</button></header>
      <main><Suspense fallback={<div className="page"><Skeleton /></div>}>{route[0] === 'result' && route[1] ? <Result sessionId={route[1]} /> : <CandidateHome user={user} />}</Suspense></main>
    </>
  );
}

const NAV = [
  ['', 'Dashboard', 'home'], ['candidates', 'Candidates', 'users'], ['leaderboard', 'Leaderboard', 'trophy'], ['training', 'Training', 'mic'],
  ['teachers', 'Teachers', 'teacher'], ['assessments', 'Assessments', 'sliders'], ['settings', 'Settings', 'cog'],
];

function StaffPages({ route }) {
  const { data, error, refreshing } = useAdmin();
  if (error && !data) return <div className="note bad">{error}</div>;
  if (!data) return <Skeleton label="Loading your workspace" />;
  return <>{refreshing && <div className="refreshing no-print" role="status"><span className="spin" style={{ width: 12, height: 12, borderWidth: 2 }} />Updating</div>}<Suspense fallback={<Skeleton />}><Page route={route} /></Suspense></>;
}

function Page({ route }) {
  switch (route[0] || '') {
    case '': return <Dashboard />;
    case 'candidates': return route[1] ? <CandidateDetail id={route[1]} /> : <Candidates />;
    case 'compare': return <Compare ids={(route[1] || '').split(',').filter(Boolean)} />;
    case 'leaderboard': return <Leaderboard />;
    case 'training': return <Training />;
    case 'session': return <SessionPage id={route[1]} />;
    case 'teachers': return <Teachers />;
    case 'assessments': return <Assessments />;
    case 'settings': return <Settings />;
    default: return <div className="empty"><h3>Page not found</h3><p className="mt"><a href="#/">Back to the dashboard</a></p></div>;
  }
}

function StaffApp({ user, signOut }) {
  const route = useHash();
  const here = ['candidates', 'compare', 'session'].includes(route[0]) ? (route[0] === 'session' ? 'candidates' : route[0] === 'compare' ? 'leaderboard' : 'candidates') : route[0] || '';
  const links = NAV.map(([path, label, icon]) => <a key={path} href={'#/' + path} className={'nav' + (here === path ? ' on' : '')}><Icon name={icon} /><span>{label}</span></a>);
  return (
    <AdminProvider>
      <div className="shell">
        <aside className="side no-print">
          <Brand />
          <nav className="col" style={{ gap: 2 }} aria-label="Main">{links}</nav>
          <div className="who"><b>{user.name}</b><div>{ROLE[user.role]}</div><button className="btn sm mt" onClick={signOut}>Sign out</button></div>
        </aside>
        <main className="main"><StaffPages route={route} /></main>
        <nav className="bottomnav no-print" aria-label="Main, mobile">{links}</nav>
      </div>
    </AdminProvider>
  );
}

function App() {
  const [session, setS] = useState(getSession());
  const [checked, setChecked] = useState(!getSession());
  useEffect(() => {
    if (!session || checked) return;
    rpc('me').then((r) => { const next = { ...session, user: r.user }; setSession(next); setS(next); }).catch(() => {}).finally(() => setChecked(true));
  }, [session, checked]);
  const signOut = () => { setSession(null); setS(null); go('/'); };
  if (!session) return <Login onSignedIn={(s) => { setSession(s); setS(s); setChecked(true); go('/'); }} />;
  if (!checked) return <Loading />;
  return session.user.role === 'candidate' ? <CandidateApp user={session.user} signOut={signOut} /> : <StaffApp user={session.user} signOut={signOut} />;
}

createRoot(document.getElementById('root')).render(<ToastProvider><ConfirmProvider><App /></ConfirmProvider></ToastProvider>);
