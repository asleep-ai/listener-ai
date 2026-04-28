// Mic acquisition + hot-swap. Constraints disable Chromium's AUVoiceIO path so
// macOS Voice Isolation can't touch the signal.

import { state } from '../state';
import { showToast } from '../ui/notifications';
// stopRecording is called when a track ends (mic disconnect). recorder.ts owns it.
import { stopRecording } from './recorder';

// Falls back to the default device when a preferred deviceId is gone (unplugged).
export async function acquireMediaStream(
  deviceId: string | null | undefined,
): Promise<MediaStream> {
  const baseConstraints: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: 48000,
    channelCount: 1,
  };
  const constraints: MediaTrackConstraints = deviceId
    ? { ...baseConstraints, deviceId: { exact: deviceId } }
    : baseConstraints;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      console.warn('Preferred audio device unavailable, falling back to default:', error);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: baseConstraints });
      if (typeof showToast === 'function') {
        showToast('Preferred mic unavailable — using system default');
      }
      return stream;
    }
    throw error;
  }
}

// If the capture device disappears (USB unplugged, Bluetooth drop, OS default
// swapped out from under us), MediaRecorder stops receiving samples. Auto-stop
// so the partial recording is saved instead of silently going mute.
export function attachTrackEndedHandlers(stream: MediaStream | null): void {
  if (!stream) return;
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (!state.isRecording) return;
      console.warn('Audio track ended mid-recording');
      showToast('Mic disconnected — stopping recording', 'error');
      stopRecording();
    });
  });
}

// Hot-swap the capture device mid-recording by replacing the source node in
// the Web Audio graph. The processed-stream destination that MediaRecorder is
// consuming stays the same, so the output file is continuous. There may be
// a small pop at the transition; Opus absorbs it.
export async function switchMicDevice(newDeviceId: string): Promise<boolean> {
  if (!state.isRecording || !state.audioContext || !state.graphHead) return false;
  let newStream: MediaStream;
  try {
    newStream = await acquireMediaStream(newDeviceId);
  } catch (error) {
    console.warn('Mic switch failed, keeping current:', error);
    showToast('Failed to switch mic — keeping current', 'error');
    return false;
  }
  try {
    if (state.sourceNode) state.sourceNode.disconnect();
  } catch (_) {}
  const oldStream = state.mediaStream;
  state.mediaStream = newStream;
  state.sourceNode = state.audioContext.createMediaStreamSource(newStream);
  state.sourceNode.connect(state.graphHead);
  attachTrackEndedHandlers(newStream);
  if (oldStream) oldStream.getTracks().forEach((t) => t.stop());
  return true;
}
