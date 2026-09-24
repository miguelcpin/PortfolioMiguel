// Processamento do microfone antes de ir para a chamada:
//   microfone -> RNNoise (supressão de ruído por IA) -> volume de entrada -> noise gate
// RNNoise e o gate rodam em AudioWorklet (thread de áudio), sem travar a interface.
// O RNNoise espera 48 kHz, por isso o AudioContext deve ser criado com sampleRate 48000.

import { RnnoiseWorkletNode, loadRnnoise } from '../vendor/noise-suppressor/index.js';

const VENDOR = new URL('../vendor/noise-suppressor/', import.meta.url);
const GATE_WORKLET = new URL('./noise-gate-worklet.js', import.meta.url).href;

let rnnoiseWasm = null; // Promise<ArrayBuffer>, baixado uma vez por página
const loadedCtx = new WeakMap(); // AudioContext -> Promise dos worklets

// Aceita o formato antigo (true/false) salvo antes de existir o modo IA
export function noiseMode(settings) {
  const v = settings.noiseSuppression;
  if (v === true) return 'ai';
  if (v === false) return 'off';
  return v === 'browser' || v === 'off' ? v : 'ai';
}

function loadWorklets(ctx) {
  if (!loadedCtx.has(ctx)) {
    loadedCtx.set(ctx, Promise.all([
      ctx.audioWorklet.addModule(new URL('rnnoiseWorklet.js', VENDOR).href),
      ctx.audioWorklet.addModule(GATE_WORKLET),
    ]));
  }
  return loadedCtx.get(ctx);
}

function getRnnoiseWasm() {
  if (!rnnoiseWasm) {
    rnnoiseWasm = loadRnnoise({
      url: new URL('rnnoise.wasm', VENDOR).href,
      simdUrl: new URL('rnnoise_simd.wasm', VENDOR).href,
    }).catch((e) => {
      rnnoiseWasm = null; // tenta de novo na próxima vez
      throw e;
    });
  }
  return rnnoiseWasm;
}

// Monta a cadeia para um stream de microfone. Se o navegador não suportar AudioWorklet
// (ou algo falhar ao carregar), segue só com o volume de entrada, sem cortar a voz.
export async function buildMicChain(ctx, stream, settings, { onLevel } = {}) {
  const src = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = settings.inputGain;
  let rnnoise = null;
  let gate = null;

  if (ctx.audioWorklet) {
    try {
      await loadWorklets(ctx);
      if (noiseMode(settings) === 'ai') {
        rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: await getRnnoiseWasm() });
      }
      gate = new AudioWorkletNode(ctx, 'resenha-noise-gate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { threshold: settings.gateThreshold, enabled: settings.noiseGate },
      });
      if (onLevel) gate.port.onmessage = (e) => onLevel(e.data);
    } catch (e) {
      console.warn('[voz] processamento do microfone indisponível', e);
      rnnoise?.destroy();
      rnnoise = null;
      gate = null;
    }
  }

  let node = src;
  if (rnnoise) node = node.connect(rnnoise);
  node = node.connect(gain);
  if (gate) node = node.connect(gate);

  return {
    output: node,
    gain,
    gate,
    rnnoise: !!rnnoise,
    setGate(enabled, threshold) {
      gate?.port.postMessage({ enabled, threshold });
    },
    dispose() {
      src.disconnect();
      rnnoise?.disconnect();
      rnnoise?.destroy();
      gain.disconnect();
      gate?.disconnect();
      if (gate) gate.port.onmessage = null;
    },
  };
}
