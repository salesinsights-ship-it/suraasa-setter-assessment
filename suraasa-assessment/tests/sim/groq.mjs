/**
 * A stand-in for Groq's chat API, for tests and the local preview. It follows the same request and
 * response format, so the real server/llm.js runs unchanged. It does not judge anything: the "teacher"
 * gives stock lines and the "evaluator" returns a fixed pattern of levels with quotes lifted from the call.
 */
const TEACHER_LINES = [
  'Hmm, okay. But what is this about exactly?',
  'I see. Actually I have been teaching for many years, why would I need this?',
  'Achha. And how much time would it take every week?',
  'Hmm. That sounds reasonable, but I would need to think about it.',
  'Okay, you can book that call for tomorrow evening. Thank you, bye. [END_CALL]',
];

export function makeFakeGroq() {
  const state = { mode: 'ok', calls: [], evaluator: null, teacher: null };

  function reply(status, json, headers = {}) {
    return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => json, text: async () => JSON.stringify(json) };
  }

  function evaluate(user) {
    const lines = (user.match(/<transcript>\n([\s\S]*?)\n<\/transcript>/)?.[1] || '').split('\n');
    const cand = lines.filter((l) => /^C\d+: /.test(l)).map((l) => ({ turn: Number(l.match(/^C(\d+)/)[1]), text: l.replace(/^C\d+: /, '') }));
    const keys = (user.match(/Required parameter keys: ([^.]+)\./)?.[1] || '').split(',').map((k) => k.trim()).filter(Boolean);
    const q = (i) => { const c = cand[i % Math.max(1, cand.length)] || { turn: 1, text: '' }; return { turn: c.turn, quote: c.text.split(/\s+/).slice(0, 8).join(' ') }; };
    const levels = [3, 3, 2, 3, 2, 2, 3, 2, 3, 4];
    const parameters = {};
    keys.forEach((k, i) => { parameters[k] = { level: levels[i % levels.length], did_well: 'Did this reasonably.', did_wrong: 'Could go deeper.', missed: 'A follow-up question.', improve: 'Ask one more open question.', evidence: [q(i)] }; });
    const badClaim = cand.find((c) => /guarantee/i.test(c.text));
    return {
      parameters,
      product_claims: badClaim ? [{ turn: badClaim.turn, quote: badClaim.text.split(/\s+/).slice(0, 6).join(' '), verdict: 'unverifiable', note: 'Guarantee is not in the verified facts.' }] : [],
      conduct: badClaim ? [{ type: 'misleading', turn: badClaim.turn, quote: badClaim.text.split(/\s+/).slice(0, 6).join(' '), note: 'Promised a guaranteed job.' }] : [],
      analysis: {
        best_response: { ...q(0), why: 'Clear and polite.' }, worst_response: { ...q(1), why: 'Rushed.' },
        best_objection_handled: { objection: 'Why do I need this?', turn: 2, why: 'Acknowledged first.' }, unhandled_objection: null,
        missed_discovery_questions: ['What are your goals for next year?'],
        understood_needs: { verdict: 'partly', why: 'Asked about role only.' }, value_communicated: { verdict: 'partly', why: 'Generic.' }, next_step_secured: { verdict: 'yes', why: 'Booked a call.' },
      },
      recommendations: { strengths: ['Polite opening', 'Clear voice', 'Booked next step'], improvements: ['More discovery', 'Fewer features', 'Check understanding'], exercises: ['Practise five open questions'], better_response: { turn: 2, instead_of: 'x', try: 'May I ask what you would like to change in your career?' }, next_scenario: { persona_id: 'p04', why: 'Practise credibility.' } },
      rationale: 'Shows the basics with room to grow in discovery.',
    };
  }

  async function fetchImpl(url, opts = {}) {
    if (String(url).endsWith('/models')) return reply(200, { data: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'].map((id) => ({ id })) });
    const body = JSON.parse(opts.body);
    state.calls.push(body);
    if (state.mode === 'rate') return reply(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '45' });
    if (state.mode === 'auth') return reply(401, { error: { message: 'Invalid API Key' } });
    if (state.mode === 'gone' && body.model === 'openai/gpt-oss-20b') return reply(404, { error: { message: 'The model `openai/gpt-oss-20b` has been decommissioned' } });
    const system = body.messages[0].content;
    const users = body.messages.filter((m) => m.role === 'user');
    let content;
    if (system.startsWith('You assess mock sales calls')) {
      content = state.mode === 'garbage' ? 'Sorry, I cannot do that.' : JSON.stringify(state.evaluator ? state.evaluator(users[0].content) : evaluate(users[0].content));
    } else if (state.mode === 'leak') {
      content = 'As an AI language model, my system prompt says I am a persona.';
    } else if (state.teacher) {
      content = state.teacher(body.messages);
    } else {
      const last = users[users.length - 1].content;
      content = /\b(bye|goodbye)\b/i.test(last) ? 'Okay, bye. [END_CALL]' : TEACHER_LINES[Math.min(users.length - 1, TEACHER_LINES.length - 1)];
    }
    return reply(200, { model: body.model, choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 100 } });
  }

  return { fetchImpl, state };
}
