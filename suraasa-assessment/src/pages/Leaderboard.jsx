import React, { useMemo, useState } from 'react';
import { Badge, Btn, Empty, Field, Input, Select, csvCell, downloadText, fmtDate, go, recTone } from '../ui.jsx';
import { useAdmin, latestScored, latestDecision } from './admin.jsx';

const COLS = [
  ['name', 'Candidate'], ['total', 'Total'], ['clarity', 'Communication'], ['objection', 'Objection handling'], ['closing', 'Closing'], ['rec', 'AI recommendation'], ['date', 'Assessed'],
];
const REC_ORDER = { 'Strongly Recommended': 0, Recommended: 1, Borderline: 2, 'Not Recommended': 3 };

export default function Leaderboard() {
  const { data, personas } = useAdmin();
  const [sort, setSort] = useState(['total', -1]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [role, setRole] = useState('');
  const [picked, setPicked] = useState([]);

  const roles = [...new Set(data.candidates.map((c) => c.role_applied).filter(Boolean))];
  const rows = useMemo(() => {
    const list = data.candidates.filter((c) => c.status === 'active').map((c) => ({ c, s: latestScored(data.sessions, c.id), d: latestDecision(data.decisions, c.id) })).filter((x) => x.s)
      .filter((x) => !role || x.c.role_applied === role)
      .filter((x) => { const day = new Date(Date.parse(x.s.started_at) + 5.5 * 3600000).toISOString().slice(0, 10); return (!from || day >= from) && (!to || day <= to); });
    const val = (x) => ({ name: x.c.name.toLowerCase(), total: x.s.total, clarity: x.s.scores?.clarity ?? -1, objection: x.s.scores?.objection ?? -1, closing: x.s.scores?.closing ?? -1, rec: -REC_ORDER[x.s.recommendation], date: x.s.started_at }[sort[0]]);
    return list.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort[1]);
  }, [data, sort, from, to, role]);

  const head = (key, label) => <th key={key} className="sort" onClick={() => setSort([key, sort[0] === key ? -sort[1] : key === 'name' ? 1 : -1])} aria-sort={sort[0] === key ? (sort[1] > 0 ? 'ascending' : 'descending') : 'none'}>{label}{sort[0] === key ? (sort[1] > 0 ? ' ↑' : ' ↓') : ''}</th>;
  const toggle = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : picked.length < 4 ? [...picked, id] : picked);
  const exportCsv = () => {
    const lines = [['Rank', 'Candidate ID', 'Candidate', 'Role', 'Teacher', 'Level', 'Total', 'Communication', 'Objection handling', 'Closing', 'AI recommendation', 'Recruiter decision', 'Assessed'].map(csvCell).join(',')];
    rows.forEach((x, i) => lines.push([i + 1, x.c.code, x.c.name, x.c.role_applied, personas[x.s.persona_id]?.name, x.s.level, x.s.total, x.s.scores?.clarity, x.s.scores?.objection, x.s.scores?.closing, x.s.recommendation, x.d?.decision || '', fmtDate(x.s.started_at)].map(csvCell).join(',')));
    downloadText('setter-assessment-leaderboard.csv', lines.join('\r\n'), 'text/csv');
  };

  return (
    <>
      <div className="head">
        <div><h1>Leaderboard</h1><p className="muted">Each candidate's latest scored call</p></div>
        <div className="row"><Btn disabled={picked.length < 2} onClick={() => go('/compare/' + picked.join(','))} data-testid="compare">Compare {picked.length ? `(${picked.length})` : ''}</Btn><Btn onClick={exportCsv} disabled={!rows.length}>Download CSV</Btn></div>
      </div>
      <div className="row wrap" style={{ marginBottom: 14, alignItems: 'flex-end' }}>
        <Field label="Assessed from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)} options={[['', 'All roles'], ...roles.map((r) => [r, r])]} /></Field>
        {(from || to || role) && <Btn kind="ghost" onClick={() => { setFrom(''); setTo(''); setRole(''); }}>Clear filters</Btn>}
      </div>
      <div className="table-wrap">
        {!rows.length ? <Empty title="No scored calls match">Scores appear here once a candidate completes a call.</Empty> : (
          <table data-testid="leaderboard">
            <thead><tr><th aria-label="Select to compare" /><th>#</th>{COLS.map(([k, l]) => head(k, l))}<th>Recruiter decision</th></tr></thead>
            <tbody>{rows.map((x, i) => (
              <tr key={x.c.id} className="click" onClick={() => go('/session/' + x.s.id)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={picked.includes(x.c.id)} onChange={() => toggle(x.c.id)} aria-label={'Compare ' + x.c.name} /></td>
                <td className="num muted">{i + 1}</td>
                <td><b>{x.c.name}</b><div className="small muted">{x.c.code} · {personas[x.s.persona_id]?.name}, level {x.s.level}</div></td>
                <td className="num strong" style={{ fontSize: 17 }}>{x.s.total}</td>
                <td className="num">{x.s.scores?.clarity ?? '–'}</td><td className="num">{x.s.scores?.objection ?? '–'}</td><td className="num">{x.s.scores?.closing ?? '–'}</td>
                <td><Badge tone={recTone(x.s.recommendation)}>{x.s.recommendation}</Badge> {x.s.flags?.conduct ? <Badge tone="bad">Conduct</Badge> : null}</td>
                <td className="nowrap">{fmtDate(x.s.started_at)}</td>
                <td>{x.d ? <Badge tone={recTone(x.d.decision)}>{x.d.decision}</Badge> : <span className="muted">–</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <p className="small muted mt">Tick two to four candidates to compare them side by side. Communication, objection handling and closing are out of 10, 15 and 5 in the standard template.</p>
    </>
  );
}
