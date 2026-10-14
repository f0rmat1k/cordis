// Microphone capture + noise suppression pipeline.
//
//   mic -> [noise suppressor] -> gain -> MediaStreamDestination -> WebRTC
//                                     \-> analyser (level meter)
//
// Modes:
//   gtcrn   – neural model GTCRN (best quality, default)
//   rnnoise – neural model RNNoise (lighter, older)
//   browser – built-in WebRTC noise suppression (what Chrome/Firefox do by default)
//   off     – no suppression

import { GtcrnWorkletNode, loadGtcrn, RnnoiseWorkletNode, loadRnnoise } from '/ns/index.js';

export const MODES = {
  gtcrn: 'GTCRN (нейросеть, макс. качество)',
  rnnoise: 'RNNoise (нейросеть, легче)',
  browser: 'Встроенное в браузер',
  off: 'Выключено',
};

const wasmCache = {};
const loadWasm = {
  gtcrn: () => (wasmCache.gtcrn ??= loadGtcrn({ url: '/ns/gtcrn.wasm' })),
  rnnoise: () => (wasmCache.rnnoise ??= loadRnnoise({ url: '/ns/rnnoise.wasm', simdUrl: '/ns/rnnoise_simd.wasm' })),
};
const workletUrl = { gtcrn: '/ns/gtcrn/workletProcessor.js', rnnoise: '/ns/rnnoise/workletProcessor.js' };

export class MicPipeline {
  constructor() {
    this.mode = 'gtcrn';
    this.ctx = null;
    this.stream = null;
    this.nsNode = null;
    this.loadedWorklets = new Set();
  }

  async start(mode = this.mode, deviceId) {
    // Both models are trained for 48 kHz input.
    this.ctx ??= new AudioContext({ sampleRate: 48000 });
    await this.ctx.resume();

    if (!this.out) {
      this.out = this.ctx.createMediaStreamDestination();
      this.gain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.gain.connect(this.out);
      this.gain.connect(this.analyser);
    }

    this.deviceId = deviceId ?? this.deviceId;
    this.mode = mode;
    await this.openMic();
    await this.setMode(mode);
    return this.out.stream.getAudioTracks()[0];
  }

  async openMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        // Browser NS is only on in "browser" mode; neural models want the raw signal.
        noiseSuppression: this.mode === 'browser',
      },
    });
    this.source?.disconnect();
    this.source = this.ctx.createMediaStreamSource(this.stream);
  }

  async setMode(mode) {
    const browserNsChanged = (mode === 'browser') !== (this.mode === 'browser');
    this.mode = mode;
    if (!this.ctx) return;

    if (browserNsChanged) {
      const track = this.stream.getAudioTracks()[0];
      try {
        await track.applyConstraints({ ...track.getConstraints(), noiseSuppression: mode === 'browser' });
      } catch {
        await this.openMic();
      }
    }

    let node = null;
    if (mode === 'gtcrn' || mode === 'rnnoise') {
      const wasmBinary = await loadWasm[mode]();
      if (!this.loadedWorklets.has(mode)) {
        await this.ctx.audioWorklet.addModule(workletUrl[mode]);
        this.loadedWorklets.add(mode);
      }
      node = mode === 'gtcrn'
        ? new GtcrnWorkletNode(this.ctx, { wasmBinary, maxChannels: 1 })
        : new RnnoiseWorkletNode(this.ctx, { wasmBinary, maxChannels: 1 });
    }

    // Rewire the graph.
    this.source.disconnect();
    if (this.nsNode) {
      this.nsNode.disconnect();
      this.nsNode.destroy?.();
    }
    this.nsNode = node;
    if (node) {
      this.source.connect(node);
      node.connect(this.gain);
    } else {
      this.source.connect(this.gain);
    }
  }

  set muted(v) {
    if (this.gain) this.gain.gain.value = v ? 0 : 1;
  }

  // Hear yourself (use headphones) to judge the suppression quality.
  set monitor(on) {
    if (!this.gain) return;
    if (on) this.gain.connect(this.ctx.destination);
    else try { this.gain.disconnect(this.ctx.destination); } catch {}
  }

  // 0..1 RMS level of the processed signal.
  level() {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  }

  stop() {
    this.monitor = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    if (this.nsNode) { this.nsNode.disconnect(); this.nsNode.destroy?.(); this.nsNode = null; }
  }
}
