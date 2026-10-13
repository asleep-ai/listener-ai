// Which credentials the Settings window shows, and what each one is used for.
//
// Pure and renderer-shared (like configDiff.ts): the AI connection tab calls it
// with the three provider choices so a credential is never hidden while a
// different feature still depends on it -- e.g. a Gemini key that powers Gemini
// Live or file transcription while summaries run on the ChatGPT plan. Not
// shipped to npm.

import {
  type AiProvider,
  type LEGACY_CODEX_PROVIDER,
  type LiveSttProvider,
  type TranscriptionProvider,
  resolveBatchSttProvider,
} from './aiProvider';

export type CredentialUse = 'summaries' | 'transcription' | 'live captions' | 'live fallback';

export type ProviderChoices = {
  aiProvider: AiProvider;
  /** A stored retired `codex` value transcribes nothing until replaced. */
  transcriptionProvider: TranscriptionProvider | typeof LEGACY_CODEX_PROVIDER;
  liveSttProvider: LiveSttProvider;
};

export type CredentialUsage = {
  gemini: CredentialUse[];
  chatgpt: CredentialUse[];
  openai: CredentialUse[];
  soniox: CredentialUse[];
};

/**
 * Lists, per credential, the features the current choices route through it.
 * Mirrors the runtime: batch `auto` follows `aiProvider` only under Gemini and
 * transcribes nothing under ChatGPT (sign-in cannot carry audio), as does a
 * retired `codex` value; live `auto` prefers an OpenAI key and then Gemini
 * Live, and with neither falls back to 12s chunks; explicit OpenAI and Soniox
 * live providers fall back to Gemini Live only (the start-failure fallback
 * drops the OpenAI key); 12s chunks go through the resolved batch backend.
 */
export function credentialUsage(choices: ProviderChoices): CredentialUsage {
  const usage: CredentialUsage = { gemini: [], chatgpt: [], openai: [], soniox: [] };
  const resolved = resolveBatchSttProvider(choices.transcriptionProvider, choices.aiProvider);
  const batch = resolved.provider;
  usage[choices.aiProvider].push('summaries');
  if (batch) usage[batch].push('transcription');
  switch (choices.liveSttProvider) {
    case 'auto':
      usage.openai.push('live captions');
      usage.gemini.push('live captions');
      // Without a streaming key, captions run as 12s chunks on the batch
      // backend. A Gemini backend is already listed for live captions above.
      if (batch && batch !== 'gemini') usage[batch].push('live fallback');
      break;
    case 'gemini':
      usage.gemini.push('live captions');
      break;
    case 'openai':
      usage.openai.push('live captions');
      usage.gemini.push('live fallback');
      break;
    case 'soniox':
      usage.soniox.push('live captions');
      usage.gemini.push('live fallback');
      break;
    case 'chunked':
      // Each chunk goes through the batch backend (transcribeLiveSnippet);
      // translation then runs on aiProvider, already listed for summaries.
      if (batch) usage[batch].push('live captions');
      break;
  }
  return usage;
}

/** Gemini and ChatGPT sections are shown only while something uses them. */
export function visibleProviderSections(choices: ProviderChoices): {
  gemini: boolean;
  chatgpt: boolean;
} {
  const usage = credentialUsage(choices);
  return { gemini: usage.gemini.length > 0, chatgpt: usage.chatgpt.length > 0 };
}

/** One sentence for the section's "Used for" line. */
export function describeCredentialUse(uses: readonly CredentialUse[]): string {
  if (uses.length === 0) return 'Not used by your current choices.';
  const labels = [...new Set(uses.map(useLabel))];
  const joined =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `Used for ${joined}.`;
}

function useLabel(use: CredentialUse): string {
  switch (use) {
    case 'summaries':
      return 'summaries and Ask Listener';
    case 'transcription':
      return 'transcribing recordings';
    case 'live captions':
      return 'live captions';
    case 'live fallback':
      return 'live captions when the chosen live provider is unavailable';
  }
}
