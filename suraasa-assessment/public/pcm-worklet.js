// Turns microphone audio into 16 kHz, 16-bit mono chunks of about a tenth of a second.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0; this.sum = 0; this.n = 0;
    this.out = new Int16Array(1600); this.i = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.sum += ch[k]; this.n++; this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.n));
        this.out[this.i++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.sum = 0; this.n = 0;
        if (this.i === this.out.length) { this.port.postMessage(this.out.buffer.slice(0)); this.i = 0; }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
