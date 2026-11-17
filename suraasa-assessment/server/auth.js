import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
export const hmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
export const rand = (n = 10) => crypto.randomBytes(16).toString('hex').slice(0, n);

/** Separate keys per purpose, all derived from the one connection secret. */
export const subKey = (secret, purpose) => hmac(secret, 'key:' + purpose);

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const normCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Must match hashCode_() in apps-script/Code.gs. */
export function hashCode(secret, email, code) {
  return sha256(secret + '|' + String(email).toLowerCase() + '|' + normCode(code));
}

export function newCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 4) out += '-';
  }
  return out;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

export function signToken(secret, purpose, payload) {
  const body = b64(JSON.stringify(payload));
  return body + '.' + hmac(subKey(secret, purpose), body);
}

export function readToken(secret, purpose, token, now) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !safeEqual(sig, hmac(subKey(secret, purpose), body))) return null;
  let payload;
  try { payload = JSON.parse(unb64(body)); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}

/**
 * Transcript chain. The server signs every turn on top of the previous signature,
 * so a transcript sent back by the browser can be checked word for word.
 */
export function chainStart(secret, sessionId) {
  return hmac(subKey(secret, 'chain'), 'start|' + sessionId);
}

export function chainAdd(secret, prev, item) {
  return hmac(subKey(secret, 'chain'), [prev, item.r, String(item.t), item.x].join('\n'));
}

export function chainOf(secret, sessionId, items) {
  let c = chainStart(secret, sessionId);
  for (const item of items) c = chainAdd(secret, c, item);
  return c;
}
