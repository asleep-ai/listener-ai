// AudioWorklet that plays back PCM chunks streamed from the main process via IPC.
// Main sends Int16 PCM at the context's sample rate; the renderer converts each
// chunk to Float32 and posts it to this processor, which drains the queue into
// the Web Audio output every render quantum (128 frames).

// Cap buffered audio at ~2 seconds (at 48kHz mono = 96000 samples). If the
// AudioContext is suspended while audiotee keeps streaming, we drop the oldest
// chunks instead of growing unbounded and OOM-ing the renderer.
const MAX_QUEUED_SAMPLES = 96000;

class PcmStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.queuedSamples = 0;
    this.port.onmessage = (event) => {
      const { type, samples } = event.data || {};
      if (type === 'pcm' && samples) {
        this.queue.push({ samples, offset: 0 });
        this.queuedSamples += samples.length;
        while (this.queuedSamples > MAX_QUEUED_SAMPLES && this.queue.length > 0) {
          const dropped = this.queue.shift();
          this.queuedSamples -= dropped.samples.length - dropped.offset;
        }
      } else if (type === 'flush') {
        this.queue.length = 0;
        this.queuedSamples = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    let i = 0;
    while (i < out.length && this.queue.length > 0) {
      const head = this.queue[0];
      const available = head.samples.length - head.offset;
      const need = out.length - i;
      const n = available < need ? available : need;
      for (let j = 0; j < n; j++) {
        out[i + j] = head.samples[head.offset + j];
      }
      i += n;
      head.offset += n;
      this.queuedSamples -= n;
      if (head.offset >= head.samples.length) this.queue.shift();
    }
    // If we ran out of PCM mid-quantum, zero-fill the rest so downstream nodes
    // get a clean silent buffer rather than leftover memory.
    for (; i < out.length; i++) out[i] = 0;
    return true;
  }
}

registerProcessor('pcm-stream', PcmStreamProcessor);
