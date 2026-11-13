import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { rpc, takeHome } from '../api.js';

const Ctx = createContext(null);
export const useAdmin = () => useContext(Ctx);

/** Loads everything a recruiter or admin is allowed to see, once, and reloads it after each change. */
export function AdminProvider({ children }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(0);
  const reload = useCallback(async () => {
    // The change just made (or the sign-in) already brought the updated lists with it: use them, no second request.
    const given = takeHome('adminHome');
    if (given) { setData(given); setError(''); return given; }
    setRefreshing((n) => n + 1);
    try { const d = await rpc('adminHome'); setData(d); setError(''); return d; } catch (e) { setError(e.message); return null; } finally { setRefreshing((n) => n - 1); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const value = useMemo(() => {
    if (!data) return { data: null, error, reload, refreshing: false };
    const byId = (xs) => Object.fromEntries(xs.map((x) => [x.id, x]));
    return {
      data, error, reload, refreshing: refreshing > 0,
      isAdmin: data.user.role === 'super_admin',
      cands: byId(data.candidates), personas: byId(data.personas), templates: byId(data.templates), users: byId(data.users),
    };
  }, [data, error, reload, refreshing]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** True for an intern's practice call. Practice calls belong on the Training page, never in hiring figures. */
export function isPractice(session, assignments) {
  if (session.flags?.practice) return true;
  return !!assignments && assignments.some((a) => a.id === session.assignment_id && a.persona_mode === 'practice');
}

/** The session that represents a candidate on the leaderboard: their latest scored hiring call that still counts. */
export function latestScored(sessions, candidateId) {
  return sessions.filter((s) => s.candidate_id === candidateId && s.status === 'scored' && !s.voided && !s.flags?.practice).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0] || null;
}

export function latestDecision(decisions, candidateId) {
  return decisions.filter((d) => d.candidate_id === candidateId).sort((a, b) => (a.at < b.at ? 1 : -1))[0] || null;
}

/** Candidates whose most recent call cannot be relied on: too short, dropped, set aside, unscored or technically flagged. */
export function needsReassessment(data) {
  return data.candidates.filter((c) => c.status === 'active').filter((c) => {
    const mine = data.sessions.filter((s) => s.candidate_id === c.id && !isPractice(s, data.assignments)).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
    const last = mine[0];
    if (!last) return false;
    return last.voided || ['incomplete', 'abandoned', 'ended'].includes(last.status) || (last.status === 'scored' && last.flags?.tech);
  });
}
