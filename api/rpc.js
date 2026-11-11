import { handle } from '../server/handlers.js';
import { makeStore } from '../server/store.js';
import { makeGroq, LlmError } from '../server/llm.js';
import { AppError } from '../server/auth.js';

/**
 * The single server entry point. Keys live here, in Vercel's environment, and never reach the browser.
 *   APPS_SCRIPT_URL  the /exec link of the Google Sheet script
 *   SHEET_SECRET     the connection secret shown by the Sheet's setup menu
 *   GROQ_API_KEY     the AI key
 *   GROQ_BASE_URL    optional, to point at another OpenAI-compatible provider
 */
const env = process.env;
const store = makeStore({ url: env.APPS_SCRIPT_URL, secret: env.SHEET_SECRET });
const llm = makeGroq({ apiKey: env.GROQ_API_KEY, baseUrl: env.GROQ_BASE_URL || undefined });
const deps = { store, llm, secret: env.SHEET_SECRET || '', configured: { sheet: !!(env.APPS_SCRIPT_URL && env.SHEET_SECRET), ai: !!env.GROQ_API_KEY } };

export async function respond(body, d = deps) {
  try {
    if (!d.configured.sheet && body?.action !== 'status') throw new AppError('not_configured', 'The Google Sheet is not connected yet. Add APPS_SCRIPT_URL and SHEET_SECRET in Vercel, then redeploy.', 503);
    return { status: 200, json: await handle(body, d) };
  } catch (e) {
    if (e instanceof AppError) return { status: e.status, json: { ok: false, code: e.code, error: e.message, ...e.extra } };
    if (e instanceof LlmError) return { status: e.kind === 'rate' ? 429 : 502, json: { ok: false, code: 'ai_' + e.kind, error: e.message, retry_after: e.retryAfter || null } };
    console.error(e);
    return { status: 500, json: { ok: false, code: 'server', error: 'Something went wrong on the server. Try again.' } };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (JSON.stringify(body || {}).length > 600000) return res.status(413).json({ ok: false, error: 'Request too large.' });
  const out = await respond(body || {});
  return res.status(out.status).json(out.json);
}
