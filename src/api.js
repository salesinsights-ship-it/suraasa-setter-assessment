const KEY = 'sa.session';

export function getSession() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; }
}
export function setSession(v) {
  if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
  else sessionStorage.removeItem(KEY);
}

export class ApiError extends Error {
  constructor(message, code, status, data) { super(message); this.code = code; this.status = status; this.data = data; }
}

/** One call to the server. Network failures become code "offline" so callers can retry. */
export async function rpc(action, payload = {}) {
  const token = getSession()?.token;
  let res;
  try {
    res = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, token, ...payload }) });
  } catch {
    throw new ApiError('You seem to be offline. Check your connection and try again.', 'offline', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* below */ }
  if (!data) throw new ApiError('The server did not answer correctly. Try again.', res.status >= 500 ? 'offline' : 'server', res.status);
  if (!data.ok) {
    if (data.code === 'signed_out' && action !== 'signIn') { setSession(null); window.location.hash = '#/'; window.location.reload(); }
    throw new ApiError(data.error || 'Something went wrong.', data.code, res.status, data);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retries through short network drops. Used during a live call so a blip does not end it. */
export async function rpcRetry(action, payload, { tries = 5, onRetry } = {}) {
  let wait = 1200;
  for (let i = 0; ; i++) {
    try { return await rpc(action, payload); } catch (e) {
      const retryable = e.code === 'offline' || e.code === 'ai_network' || e.code === 'sheet_unreachable' || e.code === 'ai_rate';
      if (!retryable || i >= tries - 1) throw e;
      onRetry?.(i + 1, e);
      await sleep(e.code === 'ai_rate' ? Math.min(20000, (e.data?.retry_after || 8) * 1000) : wait);
      wait = Math.min(8000, wait * 2);
    }
  }
}
