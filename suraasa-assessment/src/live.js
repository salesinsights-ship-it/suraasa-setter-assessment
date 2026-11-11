/**
 * Live voice for the call screen through the Gemini Live API: the candidate's microphone is streamed to
 * Google and the teacher's voice is streamed back, with no waiting for turns. The browser connects with a
 * short-lived token from our server, so it never holds the key or the teacher's hidden instructions.
 * Offers the same controls as src/voice.js (setMuted, stats, close), so the call screen can use either.
 */

export const liveSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.WebSocket && window.AudioWorkletNode && (window.AudioContext || window.webkitAudioContext));

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
const tidy = (t) => t.replace(/\s+/g, ' ').trim();

export function createLive(opts) {
  const stats = { interruptions: 0, reconnects: 0, stt_errors: 0, low_confidence: 0, muted_ms: 0 };
  const decoder = new TextDecoder();
  let ws = null; let ctx = null; let stream = null; let analyser = null; let meter = null; let watch = null;
  let ready = false; let closed = false; let muted = false; let mutedAt = 0; let ending = false;
  let nextTime = 0; const sources = new Set();
  let cand = ''; let teacher = ''; let lastState = ''; let modelIndex = 0; let reconnecting = false;

  const state = (s) => { if (s !== lastState) { lastState = s; opts.onState?.(s); } };
  const send = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const speaking = () => !!ctx && nextTime > ctx.currentTime + 0.05;

  function flushCandidate() {
    const x = tidy(cand); cand = '';
    opts.onInterim?.('');
    if (x) opts.onItem?.({ r: 'c', x, t: opts.clock() });
  }
  function flushTeacher() {
    const x = tidy(teacher); teacher = '';
    if (x) opts.onItem?.({ r: 't', x, t: opts.clock() });
  }

  function stopPlayback() {
    for (const s of sources) { try { s.stop(); } catch { /* already stopped */ } }
    sources.clear();
    nextTime = 0;
  }

  function play(bytes) {
    if (!ctx || bytes.length < 2) return;
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, nextTime);
    src.start(at); nextTime = at + buf.duration;
    sources.add(src); src.onended = () => sources.delete(src);
    state('teacher');
  }

  function onToolCall(call) {
    for (const fc of call.functionCalls || []) {
      if (fc.name === 'end_call' && opts.canEnd()) {
        send({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result: 'ok' } }] } });
        ending = true;
        const wait = setInterval(() => {
          if (closed) { clearInterval(wait); return; }
          if (!speaking()) { clearInterval(wait); flushCandidate(); flushTeacher(); opts.onEnd?.('teacher'); }
        }, 200);
      } else {
        // Too early to hang up, or an unknown tool: tell the teacher to stay on the line.
        send({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { error: 'The caller has hardly spoken yet. Stay on the line and keep talking.' } }] } });
      }
    }
  }

  function onMessage(msg) {
    if (msg.toolCall) { onToolCall(msg.toolCall); return; }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) { stats.interruptions++; stopPlayback(); flushTeacher(); }
    if (sc.inputTranscription?.text) {
      if (teacher && !speaking()) flushTeacher();
      cand += sc.inputTranscription.text;
      opts.onInterim?.(tidy(cand));
    }
    if (sc.outputTranscription?.text) {
      if (cand) flushCandidate();
      teacher += sc.outputTranscription.text;
    }
    for (const part of sc.modelTurn?.parts || []) {
      if (part.inlineData?.data) { if (cand) flushCandidate(); play(fromBase64(part.inlineData.data)); }
    }
    if (sc.turnComplete) flushTeacher();
  }

  /** Opens one connection. Resolves when Google confirms the session is set up. */
  async function connect(history) {
    const tk = await opts.getToken(modelIndex, history || []);
    modelIndex = tk.model_index ?? modelIndex;
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = new WebSocket(tk.url + '?access_token=' + encodeURIComponent(tk.token));
      sock.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { if (!settled) { settled = true; try { sock.close(); } catch { /* not open */ } reject(new Error('timeout')); } }, 12000);
      sock.onopen = () => sock.send(JSON.stringify({ setup: { model: 'models/' + tk.model } }));
      sock.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data)); } catch { return; }
        if (msg.setupComplete && !settled) { settled = true; clearTimeout(timer); ws = sock; ready = true; resolve(); return; }
        if (sock === ws) onMessage(msg);
      };
      sock.onclose = (ev) => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error(ev.reason || 'closed ' + ev.code)); return; }
        if (sock === ws && !closed && !ending) drop();
      };
      sock.onerror = () => { /* onclose follows with the detail */ };
    });
  }

  /** Tries the next model if the first will not start. */
  async function connectAny(history) {
    let lastError;
    for (let tries = 0; tries < 3; tries++) {
      try { await connect(history); return; } catch (e) {
        lastError = e;
        if (e.code && e.code !== 'live_failed') throw e; // key, limit or expiry problems will not improve with another model
        if (!e.code) modelIndex++;
      }
    }
    throw lastError;
  }

  async function drop() {
    if (reconnecting || closed) return;
    reconnecting = true; ready = false; stopPlayback(); flushCandidate(); flushTeacher();
    state('reconnecting');
    for (let i = 0; i < 3 && !closed; i++) {
      stats.reconnects++;
      try {
        // eslint-disable-next-line no-await-in-loop
        await connectAny(opts.items());
        send({ realtimeInput: { text: '[call reconnected]' } });
        reconnecting = false; state('listening');
        return;
      } catch {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    reconnecting = false;
    if (!closed) opts.onLost?.();
  }

  async function start(history) {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    await ctx.audioWorklet.addModule('/pcm-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    const silent = ctx.createGain(); silent.gain.value = 0;
    source.connect(node); node.connect(silent); silent.connect(ctx.destination);
    node.port.onmessage = (e) => {
      if (!ready || closed) return;
      const data = muted ? new ArrayBuffer(e.data.byteLength) : e.data; // silence while muted, so Google still hears a quiet line
      send({ realtimeInput: { audio: { data: toBase64(data), mimeType: 'audio/pcm;rate=16000' } } });
    };
    analyser = ctx.createAnalyser(); analyser.fftSize = 512; source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    meter = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2;
      opts.onLevel?.(muted ? 0 : Math.min(1, Math.sqrt(sum / buf.length) * 5));
    }, 100);
    watch = setInterval(() => { if (ready && !reconnecting && !speaking()) state(muted ? 'muted' : 'listening'); }, 150);

    await connectAny(history);
  }

  return {
    start,
    /** A note from the phone system to the teacher, such as a time warning. */
    note(text) { send({ realtimeInput: { text } }); },
    flush() { flushCandidate(); flushTeacher(); },
    setMuted(m) {
      muted = m;
      if (m) mutedAt = Date.now(); else if (mutedAt) { stats.muted_ms += Date.now() - mutedAt; mutedAt = 0; }
    },
    setLang() { /* the live model follows the speaker's language by itself */ },
    stats: () => ({ stt_errors: 0, low_confidence: 0, interruptions: stats.interruptions, avg_confidence: null, muted_sec: Math.round(stats.muted_ms / 1000), live_reconnects: stats.reconnects }),
    close() {
      closed = true; ready = false;
      clearInterval(meter); clearInterval(watch);
      stopPlayback();
      try { ws?.close(); } catch { /* already closed */ }
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    },
  };
}
