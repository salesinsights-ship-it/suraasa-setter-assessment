import React, { useMemo, useState } from 'react';
import { Badge, Bar, Btn, Empty, Input, Pager, Spark, TrendChart, csvCell, downloadText, fmtDate, go, recTone, usePager } from '../ui.jsx';
import { useAdmin, isPractice } from './admin.jsx';

const REC_ORDER = { 'Ready for live calls': 0, 'Nearly ready': 1, 'Needs more practice': 2, 'Needs coaching': 3 };
const round = (n) => Math.round(n * 10) / 10;
const istDay = (iso) => new Date(Date.parse(iso) + 5.5 * 3600000).toISOString().slice(0, 10);

/** Everything a trainer needs about interns' practice calls on one page: who is practising, how they score, where they are weak. */
export default function Training() {
  const { data, cands, personas, templates } = useAdmin();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(['avg', -1]);

  const model = useMemo(() => {
    const practiceAssignments = data.assignments.filter((a) => a.persona_mode === 'practice' && a.status === 'open');
    const calls = data.sessions.filter((s) => isPractice(s, data.assignments) && !s.voided);
    const scored = calls.filter((s) => s.status === 'scored');
    const internIds = new Set([...practiceAssignments.map((a) => a.candidate_id), ...calls.map((s) => s.candidate_id)]);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    // Skill averages as a share of each skill's maximum, so skills with different marks can be compared.
    const skills = (list) => {
      const sum = {};
      for (const s of list) {
        for (const p of templates[s.template_id]?.data.parameters || []) {
          const v = s.scores?.[p.key];
          if (typeof v !== 'number') continue;
          sum[p.key] = sum[p.key] || { key: p.key, name: p.name, got: 0, max: 0, n: 0 };
          sum[p.key].got += v; sum[p.key].max += p.max; sum[p.key].n++;
        }
      }
      return Object.values(sum).map((x) => ({ ...x, pct: x.max ? Math.round((x.got / x.max) * 100) : 0 }));
    };

    const interns = [...internIds].map((id) => cands[id]).filter((c) => c && c.status === 'active').map((c) => {
      const mine = scored.filter((s) => s.candidate_id === c.id).sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
      const last = mine[mine.length - 1] || null;
      const sk = skills(mine).sort((a, b) => a.pct - b.pct);
      const recent = mine.slice(-3);
      const earlier = mine.slice(-6, -3);
      const mean = (xs) => (xs.length ? xs.reduce((a, s) => a + s.total, 0) / xs.length : null);
      const change = earlier.length && recent.length ? round(mean(recent) - mean(earlier)) : null;
      return {
        c, calls: mine.length, week: mine.filter((s) => s.started_at >= weekAgo).length,
        avg: mine.length ? round(mean(mine)) : null, best: mine.length ? Math.max(...mine.map((s) => s.total)) : null,
        last, weakest: sk[0] || null, change, trend: mine.slice(-6).map((s) => s.total),
        teachers: new Set(mine.map((s) => s.persona_id)).size,
        unscored: calls.filter((s) => s.candidate_id === c.id && s.status === 'ended').length,
        // Ready means the latest two scored calls both reached the top band, so one lucky call is not enough.
        ready: mine.length >= 2 && mine.slice(-2).every((s) => s.recommendation === 'Ready for live calls'),
      };
    });
    // Team average for each day that had scored practice calls, oldest first, for the trend chart.
    const byDay = new Map();
    for (const s of scored) { const d = istDay(s.started_at); const e = byDay.get(d) || { sum: 0, n: 0 }; e.sum += s.total; e.n++; byDay.set(d, e); }
    const trend = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30).map(([d, e]) => ({ label: new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }), value: round(e.sum / e.n), note: `${e.n} call${e.n === 1 ? '' : 's'}` }));
    return { interns, scored, calls, teamSkills: skills(scored).sort((a, b) => a.pct - b.pct), weekAgo, trend };
  }, [data, cands, templates]);

  const val = (x) => ({ name: x.c.name.toLowerCase(), calls: x.calls, avg: x.avg ?? -1, best: x.best ?? -1, last: x.last?.total ?? -1, change: x.change ?? -999, weakest: x.weakest?.pct ?? 999, rec: -(REC_ORDER[x.last?.recommendation] ?? 9), date: x.last?.started_at || '' }[sort[0]]);
  const rows = model.interns.filter((x) => (x.c.name + x.c.email + x.c.code).toLowerCase().includes(q.toLowerCase())).sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort[1]);
  const pager = usePager(rows, 25);
  const head = (key, label) => <th key={key} className="sort" onClick={() => setSort([key, sort[0] === key ? -sort[1] : key === 'name' ? 1 : -1])} aria-sort={sort[0] === key ? (sort[1] > 0 ? 'ascending' : 'descending') : 'none'}>{label}{sort[0] === key ? (sort[1] > 0 ? ' ↑' : ' ↓') : ''}</th>;

  const withCalls = model.interns.filter((x) => x.calls);
  const teamAvg = model.scored.length ? round(model.scored.reduce((a, s) => a + s.total, 0) / model.scored.length) : null;
  const stats = [
    ['Interns with practice access', model.interns.length],
    ['Practice calls scored', model.scored.length, `${model.scored.filter((s) => s.started_at >= model.weekAgo).length} in the last 7 days`],
    ['Average score', teamAvg ?? '–'],
    ['Ready for live calls', model.interns.filter((x) => x.ready).length, 'top band on their last two calls'],
  ];
  const quiet = model.interns.filter((x) => !x.week);
  const stuck = withCalls.filter((x) => x.calls >= 4 && x.change !== null && x.change <= 0 && !x.ready);

  const exportCsv = () => {
    const lines = [['Intern ID', 'Intern', 'Scored calls', 'Calls in last 7 days', 'Average', 'Best', 'Latest', 'Change (last 3 vs 3 before)', 'Weakest skill', 'Weakest skill %', 'Teachers tried', 'Latest recommendation', 'Last call'].map(csvCell).join(',')];
    for (const x of rows) lines.push([x.c.code, x.c.name, x.calls, x.week, x.avg ?? '', x.best ?? '', x.last?.total ?? '', x.change ?? '', x.weakest?.name || '', x.weakest?.pct ?? '', x.teachers, x.last?.recommendation || '', x.last ? fmtDate(x.last.started_at) : ''].map(csvCell).join(','));
    downloadText('intern-training.csv', lines.join('\r\n'), 'text/csv');
  };

  if (!model.interns.length) {
    return (<><div className="head"><div><h1>Intern training</h1><p className="muted">Practice calls with the AI teachers</p></div></div>
      <Empty title="No interns have practice access yet">Open a person under Candidates, click Assign a mock call, then Intern practice. Their calls and scores will appear here.</Empty></>);
  }

  return (
    <>
      <div className="head"><div><h1>Intern training</h1><p className="muted">Practice calls with the AI teachers. Hiring assessments are on the Dashboard and Leaderboard.</p></div><Btn onClick={exportCsv}>Download CSV</Btn></div>

      <div className="grid kpis" data-testid="training-stats">
        {stats.map(([label, value, sub]) => <div className="card stat" key={label}><b className="num">{value}</b><span>{label}</span>{sub && <div className="small muted">{sub}</div>}</div>)}
      </div>

      <div className="grid g2 mt-l">
        <div className="card" data-testid="team-skills">
          <h2>Where the team is weakest</h2>
          <p className="small muted">Average marks as a share of each skill's maximum, across all scored practice calls. Weakest first.</p>
          <div className="col mt gap-s">
            {!model.teamSkills.length && <p className="muted small">No scored practice calls yet.</p>}
            {model.teamSkills.map((k) => <div key={k.key}><div className="row between small"><span className="strong">{k.name}</span><span className="num">{k.pct}%</span></div><Bar value={k.pct} max={100} /></div>)}
          </div>
        </div>
        <div className="card">
          <h2>Needs your attention</h2>
          <div className="col mt">
            {!quiet.length && !stuck.length && !model.interns.some((x) => x.unscored) && <p className="muted small">Nothing right now.</p>}
            {model.interns.filter((x) => x.unscored).map((x) => <a key={'u' + x.c.id} className="row between" href={'#/candidates/' + x.c.id}><span>{x.c.name}: {x.unscored} call{x.unscored === 1 ? '' : 's'} saved but not scored</span><Badge tone="warn">Score</Badge></a>)}
            {stuck.map((x) => <a key={'s' + x.c.id} className="row between" href={'#/candidates/' + x.c.id}><span>{x.c.name}: not improving over the last six calls{x.weakest ? `, weakest on ${x.weakest.name.toLowerCase()}` : ''}</span><Badge tone="warn">Coach</Badge></a>)}
            {quiet.slice(0, 8).map((x) => <a key={'q' + x.c.id} className="row between" href={'#/candidates/' + x.c.id}><span>{x.c.name}: no scored practice call in the last 7 days</span><Badge>Nudge</Badge></a>)}
            {quiet.length > 8 && <p className="small muted">and {quiet.length - 8} more with no call this week.</p>}
          </div>
        </div>
      </div>

      <div className="card mt-l">
        <h2>Team average score by day</h2>
        <p className="small muted" style={{ marginBottom: 8 }}>Average of all scored practice calls on each day, out of 100. Hover a point for the number of calls.</p>
        <TrendChart points={model.trend} />
      </div>

      <div className="row between wrap mt-l" style={{ marginBottom: 12 }}><h2>Interns</h2><div style={{ flex: '0 1 300px' }}><Input placeholder="Search name, email or ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search interns" /></div></div>
      <div className="table-wrap" tabIndex={0} role="group" aria-label="Table, scrolls sideways on small screens">
        <table data-testid="training-table">
          <thead><tr>{[['name', 'Intern'], ['calls', 'Scored calls'], ['avg', 'Average'], ['best', 'Best'], ['last', 'Latest'], ['change', 'Change'], ['weakest', 'Weakest skill'], ['rec', 'Latest recommendation'], ['date', 'Last call']].map(([k, l]) => head(k, l))}</tr></thead>
          <tbody>{pager.rows.map((x) => (
            <tr key={x.c.id} className="click" onClick={() => go(x.last ? '/session/' + x.last.id : '/candidates/' + x.c.id)}>
              <td><b>{x.c.name}</b> {x.ready && <Badge tone="good">Ready</Badge>}<div className="small muted">{x.c.code} · {x.teachers} of the teachers tried</div></td>
              <td className="num">{x.calls}<div className="small muted">{x.week} this week</div></td>
              <td className="num strong" style={{ fontSize: 17 }}>{x.avg ?? '–'}</td>
              <td className="num">{x.best ?? '–'}</td>
              <td className="num">{x.last?.total ?? '–'}<Spark values={x.trend} /></td>
              <td className="num" style={{ color: x.change > 0 ? 'var(--good)' : x.change < 0 ? 'var(--bad, #c0392b)' : undefined }}>{x.change === null ? '–' : (x.change > 0 ? '+' : '') + x.change}</td>
              <td>{x.weakest ? <>{x.weakest.name}<div className="small muted">{x.weakest.pct}% of marks</div></> : '–'}</td>
              <td>{x.last ? <Badge tone={recTone(x.last.recommendation)}>{x.last.recommendation}</Badge> : <span className="muted">No scored call yet</span>}</td>
              <td className="nowrap">{x.last ? fmtDate(x.last.started_at) : '–'}<div className="small muted">{x.last ? personas[x.last.persona_id]?.name : ''}</div></td>
            </tr>
          ))}</tbody>
        </table>
        <Pager p={pager} noun="interns" />
      </div>
      <p className="small muted mt">Change compares the average of the last three scored calls with the three before them. "Ready" needs the top band on the last two scored calls. Click a row to open the intern's latest report.</p>
    </>
  );
}
