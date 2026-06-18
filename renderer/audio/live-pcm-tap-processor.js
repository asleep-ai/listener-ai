const FRAME_MS = 100;

class LivePcmTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
    this.pending = new Float32Array(this.frameSize);
    this.pendingLength = 0;
    this.sequence = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input) return true;

    let offset = 0;
    while (offset < input.length) {
      const n = Math.min(this.frameSize - this.pendingLength, input.length - offset);
      this.pending.set(input.subarray(offset, offset + n), this.pendingLength);
      this.pendingLength += n;
      offset += n;
      if (this.pendingLength === this.frameSize) {
        const pcm = new Int16Array(this.frameSize);
        for (let i = 0; i < this.frameSize; i++) {
          const sample = Math.max(-1, Math.min(1, this.pending[i]));
          pcm[i] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
        }
        this.port.postMessage(
          {
            type: 'pcm',
            audioData: pcm.buffer,
            sampleRate,
            channelCount: 1,
            frames: this.frameSize,
            sequence: this.sequence++,
          },
          [pcm.buffer],
        );
        this.pendingLength = 0;
      }
    }
    return true;
  }
}

registerProcessor('live-pcm-tap', LivePcmTapProcessor);
