// Type companion for `pcm-stream-processor.js`. The processor itself runs in
// AudioWorkletGlobalScope (no DOM, no module imports) and is loaded via Vite's
// `?url` import suffix as a separate JS asset. This `.d.ts` documents the
// wire-format the renderer must use when posting messages to the worklet
// node, so consumers (audio/system-audio.ts) get type safety on postMessage.

/** Push a chunk of float32 PCM samples (mono, AudioContext sample rate). */
export type PcmStreamPushMessage = {
  type: 'pcm';
  samples: Float32Array;
};

/** Drop everything queued in the worklet without playing it back. */
export type PcmStreamFlushMessage = {
  type: 'flush';
};

/** Discriminated union for `node.port.postMessage(...)` to the worklet. */
export type PcmStreamMessage = PcmStreamPushMessage | PcmStreamFlushMessage;

/** Name registered via `registerProcessor('pcm-stream', ...)` in the .js. */
export type PcmStreamProcessorName = 'pcm-stream';
