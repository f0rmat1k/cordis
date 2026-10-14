// Microphone capture + noise suppression pipeline.
//
//   mic -> [noise suppressor] -> gain -> MediaStreamDestination -> WebRTC
//                                     \-> analyser (level meter)
//
// Modes:
//   dfn3    – neural model DeepFilterNet3 (best quality, adjustable strength, default)
//   gtcrn   – neural model GTCRN (tiny, aggressive)
//   rnnoise – neural model RNNoise (lighter, older)
//   browser – built-in WebRTC noise suppression (what Chrome/Firefox do by default)
//   off     – no suppression

import { GtcrnWorkletNode, loadGtcrn, RnnoiseWorkletNode, loadRnnoise } from '/ns/index.js';

export const MODES = {
  dfn3: 'DeepFilterNet3 (нейросеть, лучшее)',
  gtcrn: 'GTCRN (нейросеть, лёгкая)',
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

// DeepFilterNet3: ~24 MB of wasm + model. Chrome's HTTP cache often refuses entries
// this big, so keep them in Cache Storage ourselves. File URLs are versioned (v3/...),
// so a model update just lands under a new key.
const MODEL_CACHE = 'cordis-models';

async function cachedArrayBuffer(url) {
  let cache;
  try { cache = await caches.open(MODEL_CACHE); } catch { /* no Cache Storage (e.g. private mode) */ }
  let res = await cache?.match(url);
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    await cache?.put(url, res.clone()).catch(() => {});
  }
  return res.arrayBuffer();
}

let dfn3Core;
const loadDfn3 = async () => {
  if (!dfn3Core) {
    dfn3Core = (async () => {
      const { DeepFilterNet3Core } = await import('/dfn3/index.esm.js');
      const core = new DeepFilterNet3Core({
        sampleRate: 48000,
        assetConfig: { cdnUrl: `${location.origin}/models/dfn3` },
      });
      core.assetLoader.fetchAsset = cachedArrayBuffer;
      await core.initialize();
      return core;
    })();
    dfn3Core.catch(() => (dfn3Core = null));
  }
  return dfn3Core;
};

// Strength of DeepFilterNet3 = max noise attenuation in dB. Lower keeps the voice
// more natural, higher removes more (100 = no limit).
export const DEFAULT_STRENGTH = 100;
export class MicPipeline {
  constructor() {
    this.mode = 'dfn3';
    this.strength = DEFAULT_STRENGTH;
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
      // Everything after this point is mono; the destination upmixes it to both ears.
      this.gain = new GainNode(this.ctx, { channelCount: 1, channelCountMode: 'explicit' });
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

    // Chrome silently ignores applyConstraints() for audio processing flags,
    // so toggling the built-in suppressor needs a fresh capture.
    if (browserNsChanged) await this.openMic();

    let node = null;
    if (mode === 'dfn3') {
      const core = await loadDfn3();
      if (this.dfn3Registered) {
        // The processor is already registered in this context; registering again throws.
        const { wasmModule, modelBytes } = core.assets;
        node = new AudioWorkletNode(this.ctx, 'deepfilter-audio-processor', {
          processorOptions: { wasmModule, modelBytes, suppressionLevel: this.strength },
        });
      } else {
        core.config.noiseReductionLevel = this.strength;
        node = await core.createAudioWorkletNode(this.ctx);
        this.dfn3Registered = true;
      }
      node.isDfn3 = true;
    } else if (mode === 'gtcrn' || mode === 'rnnoise') {
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
    this.dropNsNode();
    this.nsNode = node;
    if (node) {
      // The worklet outputs stereo but processes only channel 0 (maxChannels: 1),
      // leaving the right channel silent. Take just the processed channel.
      this.splitter ??= this.ctx.createChannelSplitter(2);
      this.source.connect(node);
      node.connect(this.splitter);
      this.splitter.connect(this.gain, 0);
    } else {
      this.source.connect(this.gain);
    }
  }

  setStrength(db) {
    this.strength = db;
    if (this.nsNode?.isDfn3) this.nsNode.port.postMessage({ type: 'SET_SUPPRESSION_LEVEL', value: Math.round(db) });
  }

  dropNsNode() {
    const n = this.nsNode;
    if (!n) return;
    n.disconnect();
    if (n.isDfn3) n.port.postMessage({ type: 'SET_BYPASS', value: true });
    n.destroy?.();
    this.nsNode = null;
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
    this.dropNsNode();
  }
}
