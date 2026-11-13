import { AppError } from './auth.js';

/** Field types. Everything is text in the Sheet; these lists say what to turn back into numbers, booleans and JSON. */
const TYPES = {
  Users: { bool: ['active'] },
  Candidates: {},
  Personas: { bool: ['active'], json: ['data'] },
  Templates: { bool: ['active'], num: ['version'], json: ['data'] },
  Assignments: { num: ['level', 'duration_min', 'attempts'], bool: ['allow_typed'], json: ['persona_ids'] },
  Sessions: {
    num: ['template_version', 'level', 'duration_sec', 'candidate_turns', 'candidate_words', 'total', 'percent', 'coverage'],
    bool: ['voided', 'purged'],
    json: ['tech', 'scores', 'flags', 'engine', 'human'],
  },
  Decisions: {},
  Knowledge: {},
  Config: { json: ['value'] },
  AuditLog: {},
};

const BLOB_PART = 40000;

function decode(tab, row) {
  const t = TYPES[tab] || {};
  const out = { ...row };
  for (const f of t.num || []) out[f] = out[f] === '' || out[f] === undefined ? null : Number(out[f]);
  for (const f of t.bool || []) out[f] = out[f] === 'true' || out[f] === true || out[f] === 'TRUE';
  for (const f of t.json || []) {
    if (out[f] === '' || out[f] === undefined) out[f] = null;
    else { try { out[f] = JSON.parse(out[f]); } catch { out[f] = null; } }
  }
  return out;
}

function encode(tab, row) {
  const t = TYPES[tab] || {};
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) out[k] = '';
    else if ((t.json || []).includes(k)) out[k] = JSON.stringify(v);
    else if (typeof v === 'boolean') out[k] = v ? 'true' : 'false';
    else out[k] = String(v);
  }
  return out;
}

export function makeStore({ url, secret, fetchImpl = fetch, ttlMs = 15000, timeoutMs = 25000, now = () => Date.now() }) {
  const cache = new Map();

  async function call(body) {
    if (!url || !secret) throw new AppError('not_configured', 'The Google Sheet is not connected yet. Add APPS_SCRIPT_URL and SHEET_SECRET in Vercel, then redeploy.', 503);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...body, secret }),
        redirect: 'follow',
        // A stuck Google request must not hold the page for a minute. The caller sees a plain "try again".
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch {
      throw new AppError('sheet_unreachable', 'The Google Sheet script did not answer. Try again in a moment.', 502);
    }
    let data;
    try { data = JSON.parse(await res.text()); } catch {
      throw new AppError('sheet_bad_reply', 'The Google Sheet script did not answer correctly. Check that it is deployed as a Web app with access set to Anyone.', 502);
    }
    if (!data.ok) {
      if (data.error === 'unauthorized') throw new AppError('sheet_secret', 'The Google Sheet rejected the connection secret. Check SHEET_SECRET in Vercel against Setter Assessment > Show connection secret.', 502);
      throw new AppError('sheet_error', 'The Google Sheet reported a problem: ' + data.error, 502);
    }
    return data;
  }

  /**
   * Read whole tabs, all in one request to the Sheet. Uses a short cache so a call in progress never waits on the Sheet.
   * maxAgeMs lets a caller accept older copies, for data that cannot matter if it is a minute or two old.
   */
  async function read(tabs, { fresh = false, maxAgeMs = ttlMs } = {}) {
    const out = {};
    const missing = [];
    for (const tab of tabs) {
      const hit = cache.get(tab);
      if (!fresh && hit && now() - hit.at < maxAgeMs) out[tab] = hit.rows;
      else missing.push(tab);
    }
    if (missing.length) {
      const { data } = await call({ action: 'read', tabs: missing });
      for (const tab of missing) {
        const rows = (data[tab] || []).map((r) => decode(tab, r));
        cache.set(tab, { at: now(), rows });
        out[tab] = rows;
      }
    }
    return out;
  }

  async function write(ops) {
    if (!ops.length) return;
    const wire = ops.map((o) => {
      if (o.op === 'append') return { ...o, row: encode(o.tab, o.row) };
      if (o.op === 'update') return { ...o, patch: encode(o.tab, o.patch) };
      if (o.op === 'putBlob') {
        const text = JSON.stringify(o.value);
        const parts = [];
        for (let i = 0; i < text.length; i += BLOB_PART) parts.push(text.slice(i, i + BLOB_PART));
        return { op: 'putBlob', tab: o.tab, key: o.key, parts };
      }
      return o;
    });
    for (const o of ops) cache.delete(o.tab);
    await call({ action: 'write', ops: wire });
  }

  async function getBlob(tab, key) {
    const { data } = await call({ action: 'readBlob', tab, key });
    if (!data) return null;
    try { return JSON.parse(data); } catch { return null; }
  }

  async function ping() { return call({ action: 'ping' }); }

  /* Call recordings: small binary files in a private Drive folder, sent and fetched as base64 text. */
  /** False when the Sheet script is an older version that cannot store files yet. */
  async function filesReady() { try { return !!(await call({ action: 'files' })).files; } catch { return false; } }
  async function putFile(name, data, mime) { await call({ action: 'putFile', name, data, mime }); }
  async function getFile(name) { return (await call({ action: 'getFile', name })).data || null; }
  async function removeFiles(prefix) { try { return (await call({ action: 'removeFiles', prefix })).removed || 0; } catch { return 0; } }

  return { read, write, getBlob, ping, filesReady, putFile, getFile, removeFiles, _cache: cache };
}
