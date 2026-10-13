import * as fs from 'fs';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as path from 'path';
import type { TranscriptCutoffApiResult } from '../electronApiTypes';
import type { TranscriptionResult } from '../geminiService';
import {
  META_JSON,
  getTranscriptionsDir,
  readTranscription,
  saveTranscription,
} from '../outputService';
import { makeTempDir, rmDir } from '../test-helpers';
import { createTranscriptCutoff, reportCustomFields } from '../transcriptCutoff';
import type { IpcContext } from './types';

// Drives the real `upload-to-notion`, `send-to-slack` and
// `apply-transcript-cutoff` handlers together outside Electron, with remote
// services and the summarizer replaced by gated fakes, to pin how an export
// and a cutoff change of the same note are ordered.

type ModuleWithLoad = typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
type Handler = (...args: unknown[]) => Promise<any>;

interface Gate {
  promise: Promise<void>;
  open: () => void;
}
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Long enough for a handler that was NOT held back to reach its remote call.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const transcript = 'Speaker 1: agenda and decision.\nSpeaker 2: EXCLUDED_TAIL small talk.';
const cutAt = transcript.indexOf('Speaker 2');

describe('note export and transcript cutoff coordination', () => {
  let originalLoad: ModuleWithLoad['_load'];
  let dataPath: string;
  const handlers = new Map<string, Handler>();

  let notionCalls: Array<{ title: string; data: any }>;
  let notionGate: Gate | null;
  let slackCalls: Array<{ title: string; result: any }>;
  let slackGate: Gate | null;
  let summarized: string[];
  let summaryGate: Gate | null;
  let summaryResult: Partial<TranscriptionResult>;
  let metadataService: {
    saveMetadata: (audio: string, data: Record<string, unknown>) => Promise<void>;
    getMetadata: (audio: string) => Promise<{ customFields?: Record<string, unknown> } | null>;
  };

  before(() => {
    // One data path for the whole file: metadataService caches its sidecar
    // directory on first use.
    dataPath = makeTempDir('ipc-note-exports');
    const fakeElectron = {
      ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
      app: { getPath: () => dataPath },
    };
    const moduleAny = Module as ModuleWithLoad;
    originalLoad = moduleAny._load;
    moduleAny._load = function (request: string, parent: NodeModule | null, isMain: boolean) {
      if (request === 'electron') return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };

    let url = 0;
    const ctx = {
      configService: { getSummaryPrompt: () => 'PROMPT' },
      notificationService: { notifyUploadComplete: () => {}, notifyUploadFailed: () => {} },
      getNotionService: () => ({
        createMeetingNote: async (title: string, _date: Date, data: any) => {
          notionCalls.push({ title, data });
          await notionGate?.promise;
          return { success: true, url: `https://notion.so/page-${++url}` };
        },
      }),
      getSlackService: () => ({
        sendMeetingSummary: async (options: { title: string; result: any }) => {
          slackCalls.push({ title: options.title, result: options.result });
          await slackGate?.promise;
          return { success: true, sentAt: `2026-10-01T00:00:0${slackCalls.length}.000Z` };
        },
      }),
      ensureGeminiService: () => ({
        summarizeTranscript: async (text: string) => {
          summarized.push(text);
          await summaryGate?.promise;
          return {
            transcript: text,
            summary: 'Included-only summary.',
            keyPoints: ['decision'],
            actionItems: [],
            emoji: '✂️',
            ...summaryResult,
          } as TranscriptionResult;
        },
      }),
      maybeAutoSync: () => {},
      sanitizeLiveNotes: (raw: unknown) => (Array.isArray(raw) ? raw : undefined),
      formatAiCredentialsError: () => 'no credentials',
      isContainedTranscriptionPath: (p: string | undefined): p is string =>
        !!p && path.dirname(path.resolve(p)) === path.resolve(getTranscriptionsDir(dataPath)),
    } as unknown as IpcContext;
    (require('./noteExports') as { register: (c: IpcContext) => void }).register(ctx);
    (require('./transcriptCutoff') as { register: (c: IpcContext) => void }).register(ctx);
    metadataService = require('../services/metadataService').metadataService;
  });

  after(() => {
    (Module as ModuleWithLoad)._load = originalLoad;
    for (const mod of ['./noteExports', './transcriptCutoff', '../services/metadataService']) {
      delete require.cache[require.resolve(mod)];
    }
    rmDir(dataPath);
  });

  beforeEach(() => {
    notionCalls = [];
    notionGate = null;
    slackCalls = [];
    slackGate = null;
    summarized = [];
    summaryGate = null;
    summaryResult = {};
  });

  function invoke(channel: string, payload: unknown): Promise<any> {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} must be registered`);
    return handler({}, payload);
  }
  const apply = (payload: unknown) =>
    invoke('apply-transcript-cutoff', payload) as Promise<TranscriptCutoffApiResult>;

  function makeNote(
    opts: { title?: string; customFields?: Record<string, unknown>; audioFilePath?: string } = {},
  ): { folder: string; generationId: string } {
    const folder = saveTranscription({
      title: opts.title ?? 'Sync',
      result: {
        transcript,
        summary: 'Full summary.',
        keyPoints: [],
        actionItems: [],
        emoji: '📝',
        suggestedTitle: opts.title ?? 'Sync',
        customFields: opts.customFields,
      } as TranscriptionResult,
      audioFilePath: opts.audioFilePath,
      dataPath,
    });
    return { folder, generationId: readMeta(folder).generationId };
  }

  function readMeta(folder: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(path.join(folder, META_JSON), 'utf-8'));
  }

  it('holds a cutoff until an in-flight Notion upload records its page, then marks it superseded', async () => {
    const { folder, generationId } = makeNote();
    notionGate = gate();
    const upload = invoke('upload-to-notion', {
      title: 'Sync',
      transcriptionData: {},
      transcriptionPath: folder,
      expectedGenerationId: generationId,
    });
    await waitFor(() => notionCalls.length === 1, 'the Notion request');

    const cut = apply({
      transcriptionPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
    });
    await settle();
    assert.deepEqual(summarized, [], 'the cutoff does not start while the upload is outstanding');

    notionGate.open();
    assert.deepEqual(await upload, { success: true, url: 'https://notion.so/page-1' });
    const res = await cut;
    assert.equal(res.success, true);
    if (!res.success) return;

    // The page shows the pre-cutoff report, and the note says so.
    assert.match(notionCalls[0].data.transcript, /EXCLUDED_TAIL/);
    assert.equal(res.data.supersededNotionPageUrl, 'https://notion.so/page-1');
    const meta = readMeta(folder);
    assert.equal(meta.exports.notion, undefined);
    assert.equal(meta.exports.notionSuperseded.pageUrl, 'https://notion.so/page-1');
  });

  it('holds Notion and Slack exports requested during a cutoff and never publishes the excluded tail', async () => {
    const { folder, generationId } = makeNote();
    summaryGate = gate();
    summaryResult = { suggestedTitle: 'Cut Title' };
    const cut = apply({
      transcriptionPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
    });
    await waitFor(() => summarized.length === 1, 'the summary call');

    // The open modal still holds the old generation; auto mode sends none.
    const staleUpload = invoke('upload-to-notion', {
      title: 'Sync',
      transcriptionData: { transcript },
      transcriptionPath: folder,
      expectedGenerationId: generationId,
    });
    const autoUpload = invoke('upload-to-notion', {
      title: 'Sync',
      transcriptionData: { transcript },
      transcriptionPath: folder,
    });
    const autoSend = invoke('send-to-slack', {
      title: 'Sync',
      transcriptionData: { transcript },
      transcriptionPath: folder,
    });
    await settle();
    assert.equal(notionCalls.length, 0, 'no upload starts while the report is regenerating');
    assert.equal(slackCalls.length, 0, 'no send starts while the report is regenerating');

    summaryGate.open();
    assert.equal((await cut).success, true);
    assert.deepEqual(await staleUpload, {
      success: false,
      error: 'This note changed. Reopen it before uploading.',
    });
    assert.equal((await autoUpload).success, true);
    assert.equal((await autoSend).success, true);

    assert.equal(notionCalls.length, 1);
    assert.equal(slackCalls.length, 1);
    for (const sent of [notionCalls[0].data, slackCalls[0].result]) {
      assert.doesNotMatch(sent.transcript, /EXCLUDED_TAIL/);
      assert.equal(sent.summary, 'Included-only summary.');
    }
    // Slack and Notion both publish under the saved report's title.
    assert.equal(notionCalls[0].title, 'Cut Title by L.AI');
    assert.equal(slackCalls[0].title, 'Cut Title');
    const meta = readMeta(folder);
    assert.equal(meta.exports.notion.pageUrl, 'https://notion.so/page-2');
    assert.ok(meta.exports.slack.sentAt);
  });

  it('holds a cutoff until an in-flight Slack send records its status', async () => {
    const { folder, generationId } = makeNote();
    slackGate = gate();
    const send = invoke('send-to-slack', {
      title: 'Sync',
      transcriptionData: {},
      transcriptionPath: folder,
      expectedGenerationId: generationId,
    });
    await waitFor(() => slackCalls.length === 1, 'the Slack request');
    const cut = apply({
      transcriptionPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
    });
    await settle();
    assert.deepEqual(summarized, []);

    slackGate.open();
    const sent = await send;
    assert.equal(sent.success, true);
    assert.equal((await cut).success, true);
    assert.match(slackCalls[0].result.transcript, /EXCLUDED_TAIL/);
    assert.equal(readMeta(folder).exports.slack.sentAt, sent.sentAt, 'the send is not forgotten');
  });

  it('exports a note with a malformed cutoff, refuses a mismatched one until it is restored', async () => {
    const malformed = makeNote();
    const malformedMeta = readMeta(malformed.folder);
    malformedMeta.transcriptCutoff = { offset: 'invalid' };
    fs.writeFileSync(path.join(malformed.folder, META_JSON), JSON.stringify(malformedMeta));
    const ok = await invoke('upload-to-notion', {
      title: 'Sync',
      transcriptionData: {},
      transcriptionPath: malformed.folder,
      expectedGenerationId: malformed.generationId,
    });
    assert.equal(ok.success, true, 'a structurally invalid cutoff is ignored');
    assert.match(notionCalls[0].data.transcript, /EXCLUDED_TAIL/);

    const mismatched = makeNote();
    const meta = readMeta(mismatched.folder);
    meta.transcriptCutoff = createTranscriptCutoff(`${transcript} (older text)`, cutAt);
    fs.writeFileSync(path.join(mismatched.folder, META_JSON), JSON.stringify(meta));
    const request = {
      title: 'Sync',
      transcriptionData: {},
      transcriptionPath: mismatched.folder,
      expectedGenerationId: mismatched.generationId,
    };
    const refused = await invoke('upload-to-notion', request);
    assert.equal(refused.success, false);
    assert.match(refused.error, /no longer matches/);
    assert.match((await invoke('send-to-slack', request)).error, /no longer matches/);

    const restored = await apply({
      transcriptionPath: mismatched.folder,
      expectedGenerationId: mismatched.generationId,
      cutoffOffset: null,
    });
    assert.equal(restored.success, true);
    if (!restored.success) return;
    assert.equal('transcriptCutoff' in readMeta(mismatched.folder), false);
    const after = await invoke('upload-to-notion', {
      ...request,
      expectedGenerationId: restored.data.generationId,
    });
    assert.equal(after.success, true);
  });

  it('keeps an empty regenerated custom-field set over the recording sidecar after a restore', async () => {
    const audioFilePath = path.join(dataPath, 'recordings', 'fields.webm');
    const original = { decisions: ['ORIGINAL_FIELD'] };
    const { folder, generationId } = makeNote({ customFields: original, audioFilePath });
    await metadataService.saveMetadata(audioFilePath, {
      title: 'Sync',
      suggestedTitle: 'Sync',
      transcriptionPath: folder,
      customFields: original,
    });

    summaryResult = { customFields: { decisions: ['CUT_FIELD'] } };
    const cut = await apply({
      transcriptionPath: folder,
      expectedGenerationId: generationId,
      cutoffOffset: cutAt,
    });
    assert.equal(cut.success, true);
    if (!cut.success) return;
    // The restored report comes back without any custom fields.
    summaryResult = {};
    const restored = await apply({
      transcriptionPath: folder,
      expectedGenerationId: cut.data.generationId,
      cutoffOffset: null,
    });
    assert.equal(restored.success, true);
    if (!restored.success) return;
    assert.deepEqual(readMeta(folder).customFields, {});

    // Reopening (get-metadata) merges the note with its sidecar like this.
    const sidecar = await metadataService.getMetadata(audioFilePath);
    assert.deepEqual(sidecar?.customFields, original, 'the sidecar still holds the old fields');
    const reopened = reportCustomFields((await readTranscription(folder))!, sidecar?.customFields);
    assert.deepEqual(reopened, {});

    // The renderer's payload carries what reopening showed it, or the stale
    // sidecar copy; either way only the saved report's fields leave the app.
    for (const customFields of [reopened, sidecar?.customFields]) {
      const request: Record<string, unknown> = {
        title: 'Sync',
        transcriptionData: { customFields },
        transcriptionPath: folder,
        audioFilePath,
        expectedGenerationId: restored.data.generationId,
      };
      assert.equal((await invoke('upload-to-notion', request)).success, true);
      assert.equal((await invoke('send-to-slack', request)).success, true);
    }
    for (const sent of [...notionCalls.map((c) => c.data), ...slackCalls.map((c) => c.result)]) {
      assert.deepEqual(sent.customFields, {});
    }
  });

  it('still falls back to sidecar custom fields for a note that never stored its own', async () => {
    const audioFilePath = path.join(dataPath, 'recordings', 'legacy-fields.webm');
    const legacy = { decisions: ['LEGACY_FIELD'] };
    const { folder, generationId } = makeNote({ audioFilePath });
    assert.equal('customFields' in readMeta(folder), false);
    await metadataService.saveMetadata(audioFilePath, {
      transcriptionPath: folder,
      customFields: legacy,
    });

    const sidecar = await metadataService.getMetadata(audioFilePath);
    const reopened = reportCustomFields((await readTranscription(folder))!, sidecar?.customFields);
    assert.deepEqual(reopened, legacy);
    const res = await invoke('upload-to-notion', {
      title: 'Sync',
      transcriptionData: { customFields: reopened },
      transcriptionPath: folder,
      audioFilePath,
      expectedGenerationId: generationId,
    });
    assert.equal(res.success, true);
    assert.deepEqual(notionCalls[0].data.customFields, legacy);
  });
});
