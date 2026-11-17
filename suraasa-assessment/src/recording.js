/**
 * Call recordings. The audio is recorded in the caller's browser during a live voice call, then sent to the
 * server in small pieces after the call and kept in a private Google Drive folder. Nothing here holds a key.
 */
import { rpc, rpcRetry } from './api.js';

const PIECE = 360000; // bytes per piece: under the server's request limit once turned into text

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Sends a finished recording. Resolves true when every piece is stored, false if recording had to be given up. */
export async function uploadRecording(callToken, blob, onProgress) {
  if (!blob || blob.size < 2000) return false;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parts = Math.ceil(bytes.length / PIECE);
  if (parts > 60) return false;
  for (let n = 0; n < parts; n++) {
    // eslint-disable-next-line no-await-in-loop
    await rpcRetry('putRecordingPart', { callToken, n, data: toBase64(bytes.subarray(n * PIECE, (n + 1) * PIECE)) }, { tries: 4 });
    onProgress?.(n + 1, parts);
  }
  await rpcRetry('saveRecording', { callToken, parts, mime: blob.type || 'audio/webm', bytes: bytes.length }, { tries: 4 });
  return true;
}

/** Fetches a stored recording and returns a link the page can play or download. */
export async function loadRecording(sessionId, rec, onProgress) {
  const pieces = [];
  for (let n = 0; n < rec.parts; n++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await rpc('getRecordingPart', { session_id: sessionId, n });
    pieces.push(fromBase64(r.data));
    onProgress?.(n + 1, rec.parts);
  }
  return URL.createObjectURL(new Blob(pieces, { type: rec.mime || 'audio/webm' }));
}
