import type { ElectronApplication } from 'playwright';

// TEST-ONLY synthetic microphone for the hidden recording capture host.
// Recording capture runs in the host window (src/captureHost.ts), so the fake
// getUserMedia must be installed there, between the host page load and its
// first start command. CaptureHostWindow.prototype.prepare is that seam; the
// reusable harness snapshots captureHost.js and restores the prototype after
// each case. Everything after getUserMedia (Web Audio graph, MediaRecorder,
// chunk IPC, file writes) is the production path. The remux after stop is
// skipped so no ffmpeg is downloaded or spawned.
export async function installSyntheticCapture(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app }) => {
    const load = (file: string) => process.mainModule!.require(`${app.getAppPath()}/dist/${file}`);
    load('services/ffmpegManager.js').FFmpegManager.prototype.ensureFFmpeg = async () => null;
    const proto = load('captureHost.js').CaptureHostWindow.prototype;
    const fx = { prepared: 0 };
    (globalThis as any).__syntheticCapture = fx;
    proto.prepare = async function (this: { current(): Electron.BrowserWindow | null }) {
      const window = this.current();
      if (!window) throw new Error('Synthetic capture: the capture host is not loaded');
      fx.prepared++;
      await window.webContents.executeJavaScript(`(() => {
        if (window.__syntheticCapture) return;
        const contexts = [];
        window.__syntheticCapture = { contexts };
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
          configurable: true,
          value: async () => {
            const context = new AudioContext();
            const oscillator = context.createOscillator();
            const destination = context.createMediaStreamDestination();
            const gain = context.createGain();
            gain.gain.value = 0.05;
            oscillator.connect(gain).connect(destination);
            oscillator.start();
            contexts.push(context);
            return destination.stream;
          },
        });
      })()`);
    };
  });
}

// Closes the synthetic sources left in a loaded host and drops the marker.
export async function releaseSyntheticCapture(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }) => {
    delete (globalThis as any).__syntheticCapture;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.getURL().endsWith('/renderer/capture.html')) continue;
      await window.webContents.executeJavaScript(`(async () => {
        for (const context of window.__syntheticCapture?.contexts.splice(0) ?? [])
          await context.close();
      })()`);
    }
  });
}

type InvokeResult = any;

// Calls a main-process IPC handler from main itself: the tray/shortcut path
// has no renderer, so neither does this.
export function invokeMain(app: ElectronApplication, channel: string, ...args: unknown[]): Promise<InvokeResult> {
  return app.evaluate(
    async ({ ipcMain }, { channel, args }) => {
      const handler = (ipcMain as any)._invokeHandlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return handler({ sender: null }, ...args);
    },
    { channel, args },
  );
}

export const recordingState = (app: ElectronApplication) => invokeMain(app, 'recording-get-state');

// TEST-ONLY synthetic streaming live provider for fresh cases. The first live
// start in the process swaps only the provider boundary (and the Ask agent);
// main's routing, the capture host's PCM forwarding and the live service run
// unchanged. `__syntheticLive` counts provider starts, closes and PCM frames.
export async function installSyntheticLiveProvider(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app }) => {
    const proto = process.mainModule!.require(`${app.getAppPath()}/dist/liveSessionService.js`)
      .LiveSessionService.prototype;
    const original = proto.start;
    const fx: any = { starts: 0, closes: 0, frames: 0, serviceStarts: 0 };
    (globalThis as any).__syntheticLive = fx;
    proto.start = function (input: unknown) {
      fx.serviceStarts++;
      if (!fx.patched) {
        fx.patched = true;
        this.opts = {
          ...this.opts,
          getLiveSttConfig: () => ({ provider: 'soniox', sonioxApiKey: 'unused' }),
          createLiveSttSession: async (_config: unknown, callbacks: unknown) => {
            fx.starts++;
            fx.callbacks = callbacks;
            return {
              provider: 'soniox',
              kind: 'translation',
              sendPcm: () => { fx.frames++; },
              // stallClose: the provider never finishes closing (a stuck tail).
              close: async () => {
                fx.closes++;
                if (fx.stallClose) await new Promise(() => {});
              },
            };
          },
          ensureGeminiService: () => ({ generateLiveHints: async () => [] }),
          getAgentService: () => ({
            run: async (input: any) => ({
              answer: 'Synthetic live answer.',
              appliedActions: [],
              history: [...input.history],
            }),
          }),
        };
      }
      return original.call(this, input);
    };
  });
}

export const syntheticLive = (app: ElectronApplication) =>
  app.evaluate(() => {
    const fx = (globalThis as any).__syntheticLive;
    return { starts: fx.starts, closes: fx.closes, frames: fx.frames, serviceStarts: fx.serviceStarts };
  });

export const syntheticLiveFinal = (app: ElectronApplication, text: string, translation: string) =>
  app.evaluate((_e, value) => {
    (globalThis as any).__syntheticLive.callbacks.onFinal({ ...value, offsetMs: 1000, durationMs: 1000 });
  }, { text, translation });

// TEST-ONLY OpenAI Realtime stand-in for the WebRTC transport. Main is given a
// synthetic client secret instead of calling OpenAI, and the hidden capture
// host's `fetch` to the Realtime calls endpoint is answered by a second, native
// RTCPeerConnection in the same host page: the production peer's real offer
// (with its gathered ICE candidates) is answered over loopback, its audio
// track arrives as RTP on the answerer, and the production data channel
// carries scripted transcription events. Everything on the production side
// (peer, track, data channel, commits, finals, routing) runs unchanged; only
// the signaling server and the provider are fake. Install after
// installSyntheticCapture, which it chains onto.
export async function installSyntheticRealtime(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app }) => {
    const load = (file: string) => process.mainModule!.require(`${app.getAppPath()}/dist/${file}`);
    const service = load('liveSessionService.js').LiveSessionService.prototype;
    const originalStart = service.start;
    const fx: any = { serviceStarts: 0, secrets: 0, streamingStarts: 0 };
    (globalThis as any).__syntheticRealtime = fx;
    service.start = function (input: unknown) {
      fx.serviceStarts++;
      if (!fx.patched) {
        fx.patched = true;
        this.opts = {
          ...this.opts,
          getLiveSttConfig: () => ({ provider: 'openai', openaiApiKey: 'synthetic-unused-key' }),
          createRealtimeClientConfig: async () => {
            fx.secrets++;
            return { transport: 'webrtc', endpoint: 'realtime', clientSecret: 'synthetic-client-secret' };
          },
          // A realtime failure would fall back to a streaming provider: count
          // it instead of reaching the network.
          createLiveSttSession: async () => {
            fx.streamingStarts++;
            return { provider: 'openai', kind: 'transcription', sendPcm: () => {}, close: async () => {} };
          },
          ensureGeminiService: () => ({ generateLiveHints: async () => [] }),
          getAgentService: () => ({
            run: async (input: any) => ({
              answer: 'Synthetic live answer.',
              appliedActions: [],
              history: [...input.history],
            }),
          }),
        };
      }
      return originalStart.call(this, input);
    };

    const host = load('captureHost.js').CaptureHostWindow.prototype;
    const prepare = host.prepare;
    host.prepare = async function (this: { current(): Electron.BrowserWindow | null }) {
      await prepare.call(this);
      await this.current()!.webContents.executeJavaScript(`(() => {
        if (window.__realtimeLoopback) return;
        const Native = window.RTCPeerConnection;
        const fx = { offerers: [], answerers: [], channels: [], calls: [], commits: 0, open: [], tail: null, tailDelayMs: 300 };
        window.__realtimeLoopback = fx;
        // Same constructor and prototype; only remembers the production peer.
        window.RTCPeerConnection = class extends Native {
          constructor(...args) { super(...args); fx.offerers.push(this); }
        };
        const gathered = (peer) => new Promise((resolve, reject) => {
          if (peer.iceGatheringState === 'complete') return resolve();
          const timer = setTimeout(() => reject(new Error('ICE gathering timed out')), 10000);
          peer.addEventListener('icegatheringstatechange', () => {
            if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
          });
        });
        const realFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = String(input);
          if (!url.startsWith('https://api.openai.com/v1/realtime/')) return realFetch(input, init);
          fx.calls.push({ url, authorization: init && init.headers && init.headers.Authorization });
          const offerer = fx.offerers[fx.offerers.length - 1];
          await gathered(offerer);
          const answerer = new Native();
          fx.answerers.push(answerer);
          answerer.ondatachannel = ({ channel }) => {
            fx.channels.push(channel);
            // OpenAI's commit protocol: every commit is acknowledged with
            // input_audio_buffer.committed (item_id); the item's transcription
            // completes later. Interval items stay open here; when the tail is
            // armed, the next commit first completes the earlier open items and
            // completes its own item only afterwards, so a flush that stops at
            // the first completion would lose the tail.
            channel.onmessage = ({ data }) => {
              const event = JSON.parse(String(data));
              if (event.type !== 'input_audio_buffer.commit') return;
              fx.commits++;
              const itemId = 'item_' + fx.commits;
              channel.send(JSON.stringify({
                type: 'input_audio_buffer.committed', item_id: itemId,
                previous_item_id: fx.open[fx.open.length - 1] || null,
              }));
              if (!fx.tail) { fx.open.push(itemId); return; }
              for (const earlier of fx.open.splice(0)) {
                channel.send(JSON.stringify({
                  type: 'conversation.item.input_audio_transcription.completed',
                  item_id: earlier, transcript: '',
                }));
              }
              const tail = fx.tail;
              fx.tail = null;
              setTimeout(() => channel.send(JSON.stringify({
                type: 'conversation.item.input_audio_transcription.completed',
                item_id: itemId, transcript: tail,
              })), fx.tailDelayMs);
            };
          };
          await answerer.setRemoteDescription(offerer.localDescription);
          await answerer.setLocalDescription(await answerer.createAnswer());
          await gathered(answerer);
          return new Response(answerer.localDescription.sdp, {
            status: 200, headers: { 'Content-Type': 'application/sdp' },
          });
        };
        fx.evidence = async () => {
          const answerer = fx.answerers[fx.answerers.length - 1];
          let bytes = 0, packets = 0;
          if (answerer) (await answerer.getStats()).forEach((r) => {
            if (r.type === 'inbound-rtp' && r.kind === 'audio') { bytes += r.bytesReceived; packets += r.packetsReceived; }
          });
          const channel = fx.channels[fx.channels.length - 1];
          return {
            bytes, packets, calls: fx.calls.length, peers: fx.answerers.length,
            authorization: fx.calls.map((c) => c.authorization),
            connection: answerer ? answerer.connectionState : 'none',
            channel: channel ? channel.readyState : 'none',
            commits: fx.commits,
            openItems: fx.open.length,
          };
        };
        fx.say = (itemId, text) => {
          const channel = fx.channels[fx.channels.length - 1];
          channel.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, delta: text }));
          channel.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: text }));
        };
      })()`);
    };
  });
}

const captureHostEval = (app: ElectronApplication, script: string) =>
  app.evaluate(async ({ BrowserWindow }, source) => {
    const host = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith('/renderer/capture.html'),
    );
    if (!host) throw new Error('No capture host');
    return host.webContents.executeJavaScript(source);
  }, script);

export const realtimeEvidence = (app: ElectronApplication) =>
  captureHostEval(app, 'window.__realtimeLoopback.evidence()');

// The fake provider speaks on the production data channel.
export const realtimeSay = (app: ElectronApplication, itemId: string, text: string) =>
  captureHostEval(app, `window.__realtimeLoopback.say(${JSON.stringify(itemId)}, ${JSON.stringify(text)})`);

// Answers the stop flush's final commit with this tail transcript, after the
// earlier open items and `delayMs` (the provider's reply time).
export const realtimeTail = (app: ElectronApplication, text: string, delayMs = 300) =>
  captureHostEval(
    app,
    `window.__realtimeLoopback.tailDelayMs = ${delayMs}; window.__realtimeLoopback.tail = ${JSON.stringify(text)}`,
  );

export const syntheticRealtime = (app: ElectronApplication) =>
  app.evaluate(() => {
    const fx = (globalThis as any).__syntheticRealtime;
    return { serviceStarts: fx.serviceStarts, secrets: fx.secrets, streamingStarts: fx.streamingStarts };
  });

// Makes the synthetic live provider's close never settle, like a provider
// whose final reply never arrives.
export const stallSyntheticLiveClose = (app: ElectronApplication) =>
  app.evaluate(() => {
    (globalThis as any).__syntheticLive.stallClose = true;
  });
