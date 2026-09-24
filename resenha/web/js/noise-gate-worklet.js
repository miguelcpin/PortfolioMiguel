// Noise gate (AudioWorklet): corta o microfone quando o som fica abaixo do limite,
// para teclado, mouse e chiado não vazarem entre uma fala e outra.
// Abre rápido, segura um pouco depois da fala e fecha com fade (sem estalo).
// Manda o nível de entrada (dB) para a interface desenhar o medidor de sensibilidade.

const ATTACK_MS = 5;
const RELEASE_MS = 80;
const HOLD_MS = 250;
const HYSTERESIS_DB = 6; // fecha só quando cai 6 dB abaixo do limite
const REPORT_MS = 50;

class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.threshold = o.threshold ?? -50;
    this.enabled = o.enabled ?? true;
    this.gain = this.enabled ? 0 : 1;
    this.holdLeft = 0;
    this.blockMs = (128 / sampleRate) * 1000;
    this.sinceReport = 0;
    this.peakDb = -100;
    this.port.onmessage = (e) => {
      if (typeof e.data.threshold === 'number') this.threshold = e.data.threshold;
      if (typeof e.data.enabled === 'boolean') this.enabled = e.data.enabled;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) {
      for (const ch of output) ch.fill(0);
      return true;
    }

    let sum = 0;
    let n = 0;
    for (const ch of input) {
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      n += ch.length;
    }
    const db = n ? 10 * Math.log10(sum / n + 1e-12) : -100;

    let target = 1;
    if (this.enabled) {
      if (db >= this.threshold) this.holdLeft = HOLD_MS;
      else if (db < this.threshold - HYSTERESIS_DB) this.holdLeft -= this.blockMs;
      target = this.holdLeft > 0 ? 1 : 0;
    }

    // Rampa exponencial por amostra até o alvo
    const tau = (target > this.gain ? ATTACK_MS : RELEASE_MS) / 1000;
    const k = 1 - Math.exp(-1 / (tau * sampleRate));
    const len = input[0].length;
    let g = this.gain;
    for (let c = 0; c < output.length; c++) {
      const src = input[Math.min(c, input.length - 1)];
      const dst = output[c];
      g = this.gain;
      for (let i = 0; i < len; i++) {
        g += (target - g) * k;
        dst[i] = src[i] * g;
      }
    }
    this.gain = g;

    this.peakDb = Math.max(this.peakDb, db);
    this.sinceReport += this.blockMs;
    if (this.sinceReport >= REPORT_MS) {
      this.port.postMessage({ level: Math.max(-100, this.peakDb), open: target === 1 });
      this.sinceReport = 0;
      this.peakDb = -100;
    }
    return true;
  }
}

registerProcessor('resenha-noise-gate', NoiseGateProcessor);
