/**
 * Live voice for the call screen, using what the browser provides:
 * speech recognition for the candidate and speech synthesis for the teacher.
 * Nothing is prerecorded. Swap this file to plug in a different voice provider:
 * the call screen only needs listen(), pause(), speak(), setMuted(), setLang(), stats() and close().
 */

const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = () => !!SR() && 'speechSynthesis' in window;
export const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const wordCount = (t) => t.trim().split(/\s+/).filter(Boolean).length;
const isHindi = (t) => { const d = (t.match(/[ऀ-ॿ]/g) || []).length; return d > 0 && d / Math.max(1, t.replace(/\s/g, '').length) > 0.25; };

const FEMALE = /heera|swara|neerja|kalpana|lekha|veena|female|zira|susan|samantha|aditi|raveena|google हिन्दी|google uk english female/i;
const MALE = /ravi|hemant|madhur|prabhat|rishi|male|david|george|daniel|google uk english male/i;

function pickVoice(text, gender) {
  const all = window.speechSynthesis.getVoices();
  const want = isHindi(text) ? ['hi-IN', 'hi'] : ['en-IN', 'en-GB', 'en-AU', 'en'];
  for (const lang of want) {
    const pool = all.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(lang.toLowerCase()));
    if (!pool.length) continue;
    const match = pool.find((v) => (gender === 'male' ? MALE.test(v.name) && !/female/i.test(v.name) : FEMALE.test(v.name)));
    return { voice: match || pool[0], matched: !!match };
  }
  return { voice: null, matched: false };
}

export function createVoice(opts) {
  const stats = { stt_errors: 0, low_confidence: 0, conf_sum: 0, conf_n: 0, interruptions: 0, muted_ms: 0 };
  let rec = null; let want = false; let muted = false; let mutedAt = 0; let speaking = false; let closed = false;
  let lang = opts.lang || 'en-IN'; let finals = []; let interim = ''; let timer = null; let startedAt = 0;
  let stream = null; let ctx = null; let meter = null;

  function reset() { finals = []; interim = ''; startedAt = 0; clearTimeout(timer); timer = null; }

  function flush(interrupt = false) {
    const text = (finals.join(' ') + ' ' + interim).replace(/\s+/g, ' ').trim();
    reset();
    opts.onInterim?.('');
    if (text) opts.onUtterance?.(text, { interrupt });
  }

  function startRec() {
    if (closed || rec || !want || muted || (speaking && !opts.headset)) return;
    const R = SR();
    if (!R) return;
    const r = new R();
    r.lang = lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e) => {
      if (r !== rec) return;
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        if (res.isFinal) {
          finals.push(text);
          const c = res[0].confidence;
          if (c > 0) { stats.conf_sum += c; stats.conf_n++; if (c < 0.55) stats.low_confidence++; }
        } else interim += ' ' + text;
      }
      const heard = (finals.join(' ') + ' ' + interim).trim();
      if (!heard) return;
      // With a headset the candidate may talk over the teacher, like on a real call.
      if (speaking && opts.headset && wordCount(heard) >= 2) { stats.interruptions++; window.speechSynthesis.cancel(); }
      if (!startedAt) startedAt = Date.now();
      opts.onInterim?.(heard);
      clearTimeout(timer);
      // A teacher with little patience cuts in on a long monologue.
      if (opts.interruptAfterSec && Date.now() - startedAt > opts.interruptAfterSec * 1000 && wordCount(heard) > 35) { flush(true); return; }
      timer = setTimeout(() => flush(false), finals.length && !interim.trim() ? 1300 : 2400);
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { want = false; opts.onError?.('mic_blocked'); return; }
      if (e.error === 'audio-capture') { opts.onError?.('no_mic'); return; }
      stats.stt_errors++;
      opts.onError?.(e.error === 'network' ? 'stt_network' : 'stt_other');
    };
    r.onend = () => { if (r === rec) rec = null; if (want && !closed) setTimeout(startRec, 200); };
    rec = r;
    try { r.start(); } catch { rec = null; }
  }

  function stopRec() { const r = rec; rec = null; if (r) { try { r.abort(); } catch { /* already stopped */ } } }

  async function speak(text, gender) {
    if (closed) return;
    speaking = true;
    if (!opts.headset) { stopRec(); reset(); }
    opts.onSpeaking?.(true);
    const { voice, matched } = pickVoice(text, gender);
    const chunks = text.match(/[^.!?।]+[.!?।]*/g)?.map((x) => x.trim()).filter(Boolean) || [text];
    for (const chunk of chunks) {
      if (closed || !speaking) break;
      // eslint-disable-next-line no-await-in-loop
      const finished = await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(chunk);
        if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = isHindi(chunk) ? 'hi-IN' : 'en-IN';
        u.rate = 1; u.pitch = matched ? 1 : gender === 'male' ? 0.75 : 1.15;
        const guard = setTimeout(() => resolve(true), 4000 + chunk.length * 110); // some browsers never fire "end"
        u.onend = () => { clearTimeout(guard); resolve(true); };
        u.onerror = (e) => { clearTimeout(guard); resolve(e.error !== 'interrupted' && e.error !== 'canceled'); };
        window.speechSynthesis.speak(u);
      });
      if (!finished) break; // the candidate cut in
    }
    speaking = false;
    opts.onSpeaking?.(false);
    if (want) startRec();
  }

  async function openMic() {
    // Asks for the microphone once, and drives the level meter. Phones cannot share the mic with recognition, so no meter there.
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (isPhone()) { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser(); an.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      meter = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2;
        opts.onLevel?.(muted ? 0 : Math.min(1, Math.sqrt(sum / buf.length) * 5));
      }, 100);
    } catch { /* the meter is optional */ }
  }

  return {
    openMic,
    listen() { want = true; startRec(); },
    pause() { want = false; stopRec(); reset(); },
    speak,
    stopSpeaking() { speaking = false; window.speechSynthesis.cancel(); },
    setMuted(m) {
      muted = m;
      if (m) { mutedAt = Date.now(); stopRec(); reset(); opts.onInterim?.(''); } else { if (mutedAt) stats.muted_ms += Date.now() - mutedAt; mutedAt = 0; startRec(); }
      stream?.getAudioTracks().forEach((t) => { t.enabled = !m; });
    },
    setLang(l) { lang = l; if (rec) stopRec(); if (want) setTimeout(startRec, 150); },
    stats: () => ({
      stt_errors: stats.stt_errors, low_confidence: stats.low_confidence, interruptions: stats.interruptions,
      avg_confidence: stats.conf_n ? stats.conf_sum / stats.conf_n : null, muted_sec: Math.round(stats.muted_ms / 1000),
    }),
    close() {
      closed = true; want = false; speaking = false; stopRec(); clearInterval(meter); clearTimeout(timer);
      try { window.speechSynthesis.cancel(); } catch { /* nothing to cancel */ }
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    },
  };
}

/** A ringback tone made with an oscillator while the call connects. */
export function ring(seconds = 2.6) {
  return new Promise((resolve) => {
    let ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { setTimeout(resolve, seconds * 1000); return; }
    const gain = ctx.createGain(); gain.gain.value = 0; gain.connect(ctx.destination);
    const a = ctx.createOscillator(); a.frequency.value = 400; a.connect(gain); a.start();
    const b = ctx.createOscillator(); b.frequency.value = 450; b.connect(gain); b.start();
    const t = ctx.currentTime;
    for (const at of [0, 0.6, 1.6, 2.2]) { gain.gain.setValueAtTime(0.06, t + at); gain.gain.setValueAtTime(0, t + at + 0.4); }
    setTimeout(() => { a.stop(); b.stop(); ctx.close().catch(() => {}); resolve(); }, seconds * 1000);
  });
}
