import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { getSession, setSession, rpc } from './api.js';
import { ToastProvider, useHash, Icon, Loading, go } from './ui.jsx';
import Login from './pages/Login.jsx';
import CandidateHome from './pages/CandidateHome.jsx';
import Call from './pages/Call.jsx';
import Result from './pages/Result.jsx';
import { AdminProvider, useAdmin } from './pages/admin.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Candidates, { CandidateDetail, Compare } from './pages/Candidates.jsx';
import Leaderboard from './pages/Leaderboard.jsx';
import Training from './pages/Training.jsx';
import SessionPage from './pages/SessionPage.jsx';
import Teachers from './pages/Teachers.jsx';
import Assessments from './pages/Assessments.jsx';
import Settings from './pages/Settings.jsx';

const ROLE = { super_admin: 'Super Admin', recruiter: 'Recruiter', candidate: 'Candidate' };

function Brand() {
  return <div className="brand"><i>S</i><div>Suraasa<small>Setter Assessment</small></div></div>;
}

function CandidateApp({ user, signOut }) {
  const route = useHash();
  if (route[0] === 'call' && route[1]) return <Call assignmentId={route[1]} personaId={route[2] || ''} />;
  return (
    <>
      <div className="topbar"><Brand /><span className="right small hide-m">{user.name}</span><button className="btn sm" onClick={signOut}>Sign out</button></div>
      {route[0] === 'result' && route[1] ? <Result sessionId={route[1]} /> : <CandidateHome user={user} />}
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
  if (!data) return <Loading text="Loading your workspace" />;
  return <>{refreshing && <div className="refreshing no-print" role="status"><span className="spin" style={{ width: 12, height: 12, borderWidth: 2 }} />Updating the list</div>}<Page route={route} /></>;
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
          {links}
          <div className="who"><div style={{ color: '#fff', fontWeight: 700 }}>{user.name}</div><div>{ROLE[user.role]}</div><button className="btn sm mt" onClick={signOut}>Sign out</button></div>
        </aside>
        <main className="main"><StaffPages route={route} /></main>
        <nav className="bottomnav no-print">{links}</nav>
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

createRoot(document.getElementById('root')).render(<ToastProvider><App /></ToastProvider>);
