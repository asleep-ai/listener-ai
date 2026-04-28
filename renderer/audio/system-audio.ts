// System audio capture (loopback). On macOS we route through a Core Audio Tap
// (audiotee) running in main; on Win/Linux we use getDisplayMedia({audio:'loopback'}).

// AudioWorklet must be served as a separate JS file (browsers refuse to load
// worklets via data URLs of the wrong MIME type). Keep the worklet authored as
// `.js` and use Vite's `?url` import which transparently emits to the assets dir.
import pcmWorkletUrl from './pcm-stream-processor.js?url';

// Request a loopback-audio stream via getDisplayMedia. Shape must match what
// the main-process handler returns (video source + audio: 'loopback') on
// Windows/Linux. macOS uses the audiotee IPC path instead.
export async function acquireDisplayMediaStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
}

// Probe whether system audio capture is currently authorized. On macOS we start
// audiotee (Core Audio Tap) just long enough to confirm the "System Audio
// Recording" permission was granted, then stop. On other platforms we fall back
// to getDisplayMedia with audio: 'loopback'.
// Returns { ok: true } on success, { ok: false, denied: boolean } on failure.
export async function probeSystemAudio(): Promise<{ ok: true } | { ok: false; denied: boolean }> {
  if (window.electronAPI.platform === 'darwin') {
    const result = await window.electronAPI.startSystemAudio();
    if (result.success) {
      await window.electronAPI.stopSystemAudio();
      return { ok: true };
    }
    const denied = result.reason === 'permission-denied';
    console.warn('System audio probe failed:', result);
    return { ok: false, denied };
  }
  try {
    const display = await acquireDisplayMediaStream();
    display.getTracks().forEach((t) => t.stop());
    return { ok: true };
  } catch (error) {
    console.warn('System audio probe failed (getDisplayMedia):', error);
    const name = error instanceof Error && error.name ? error.name : '';
    return { ok: false, denied: name === 'NotAllowedError' || name === 'SecurityError' };
  }
}

export type SystemAudioSource = {
  node: AudioNode | null;
  cleanup: () => Promise<void>;
};

// Build an AudioNode that feeds mic+system audio into the shared Web Audio graph.
// macOS: AudioWorklet fed by PCM chunks over IPC from audiotee in main process.
// Other: MediaStreamAudioSourceNode wrapping a fresh getDisplayMedia stream.
// Returns an object with:
//   node: AudioNode (connected into ctx) OR null on failure,
//   cleanup: () => Promise<void> to call when the recording stops.
export async function createSystemAudioSource(ctx: AudioContext): Promise<SystemAudioSource> {
  if (window.electronAPI.platform === 'darwin') {
    const result = await window.electronAPI.startSystemAudio();
    if (!result.success) {
      console.warn('System audio start failed:', result);
      return { node: null, cleanup: async () => {} };
    }
    try {
      await ctx.audioWorklet.addModule(pcmWorkletUrl);
    } catch (err) {
      console.error('Failed to load PCM worklet:', err);
      await window.electronAPI.stopSystemAudio();
      return { node: null, cleanup: async () => {} };
    }
    const node = new AudioWorkletNode(ctx, 'pcm-stream', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    // Convert Int16 PCM (from audiotee) to Float32 and post to the worklet port.
    // Transferring the buffer avoids a copy at the postMessage boundary.
    window.electronAPI.onSystemAudioChunk((chunk) => {
      const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
      node.port.postMessage({ type: 'pcm', samples: float32 }, [float32.buffer]);
    });
    return {
      node,
      cleanup: async () => {
        window.electronAPI.offSystemAudioChunk();
        try {
          node.port.postMessage({ type: 'flush' });
        } catch {
          /* ignore */
        }
        await window.electronAPI.stopSystemAudio();
      },
    };
  }
  try {
    const display = await acquireDisplayMediaStream();
    display.getVideoTracks().forEach((t) => t.stop());
    const audioTracks = display.getAudioTracks();
    if (audioTracks.length === 0) {
      return { node: null, cleanup: async () => {} };
    }
    const stream = new MediaStream(audioTracks);
    const node = ctx.createMediaStreamSource(stream);
    return {
      node,
      cleanup: async () => {
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  } catch (err) {
    console.warn('System audio getDisplayMedia failed:', err);
    return { node: null, cleanup: async () => {} };
  }
}
