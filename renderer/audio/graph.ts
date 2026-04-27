// Audio graph builders. Mirrors the legacy `renderer.js` audio chain:
//   highpass 80Hz (rumble/plosive cut)
//   -> DynamicsCompressor (fast attack tames keyboard taps & close transients)
//   -> makeup gain (+12dB) lifts distant speakers back up
// Brick-wall limiter at the tail prevents Opus encoder clipping.

import { state } from '../state';

export function pickRecordingMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/webm',
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

// Mic processing chain (also used as the mic branch when mixing with system audio):
//   highpass 80Hz (rumble/plosive cut)
//   -> DynamicsCompressor (fast attack tames keyboard taps & close transients)
//   -> makeup gain (+12dB) lifts distant speakers back up
// Net effect: distant voices become audible without amplifying key clicks equally.
export function buildMicChain(
  ctx: AudioContext,
  micStream: MediaStream,
): { source: MediaStreamAudioSourceNode; head: AudioNode; tail: AudioNode } {
  const source = ctx.createMediaStreamSource(micStream);

  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 80;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -30;
  compressor.knee.value = 20;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;

  const gain = ctx.createGain();
  gain.gain.value = 4.0;

  source.connect(highpass).connect(compressor).connect(gain);
  // source/head are exposed so the caller can hot-swap the mic source mid-recording.
  return { source, head: highpass, tail: gain };
}

export function buildLimiter(ctx: AudioContext): DynamicsCompressorNode {
  // Brick-wall limiter after the +12dB makeup gain so close-range speech can't
  // clip into the Opus encoder when the compressor's attack/release lets a peak through.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0;
  limiter.release.value = 0.1;
  return limiter;
}

export type ProcessedGraph = {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  head: AudioNode;
};

// Mic keeps the voice-lift chain; system audio (Zoom/Meet, browser tabs) is digital-clean
// so it only gets a gentle -2dB attenuation before the shared brick-wall limiter catches
// any combined peaks before the Opus encoder.
// The caller can supply a factory that returns an AudioNode (in the given ctx)
// for the system-audio source. This lets the macOS path feed an AudioWorklet
// fed from audiotee PCM chunks, while the cross-platform path wraps a
// MediaStream from getDisplayMedia.
export async function buildProcessedStream(
  micStream: MediaStream,
  addSystemAudio: ((ctx: AudioContext) => Promise<AudioNode | null>) | null = null,
): Promise<ProcessedGraph> {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const mic = buildMicChain(ctx, micStream);

  let preLimit: AudioNode = mic.tail;
  const systemAudioNode = addSystemAudio ? await addSystemAudio(ctx) : null;
  if (systemAudioNode) {
    const sysGain = ctx.createGain();
    sysGain.gain.value = 0.8;
    systemAudioNode.connect(sysGain);

    const mixer = ctx.createGain();
    mic.tail.connect(mixer);
    sysGain.connect(mixer);
    preLimit = mixer;
  }

  const destination = ctx.createMediaStreamDestination();
  preLimit.connect(buildLimiter(ctx)).connect(destination);
  // source/head support hot-swapping the mic mid-recording (mic selector).
  return { ctx, stream: destination.stream, source: mic.source, head: mic.head };
}

export function teardownAudioGraph(): void {
  if (state.audioContext) {
    state.audioContext.close().catch((e) => console.warn('AudioContext close:', e));
    state.audioContext = null;
  }
  state.processedStream = null;
  state.sourceNode = null;
  state.graphHead = null;
}

export function cleanupAudioState(): void {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;
  }
  if (state.systemAudioCleanup) {
    const fn = state.systemAudioCleanup;
    state.systemAudioCleanup = null;
    Promise.resolve(fn()).catch((err) => console.warn('System audio cleanup:', err));
  }
  teardownAudioGraph();
  state.mediaRecorder = null;
}
