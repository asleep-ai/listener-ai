import { listTranscriptions, readTranscription } from './outputService';
import type { ReadTranscriptionResult, TranscriptionEntry } from './outputService';

export type SearchField = 'title' | 'summary' | 'keyPoints' | 'actionItems' | 'transcript';

export const FIELD_WEIGHTS: Record<SearchField, number> = {
  title: 10,
  summary: 5,
  keyPoints: 3,
  actionItems: 3,
  transcript: 1,
};

export const DEFAULT_FIELDS: SearchField[] = ['title', 'summary', 'keyPoints', 'actionItems'];
export const ALL_FIELDS: SearchField[] = ['title', 'summary', 'keyPoints', 'actionItems', 'transcript'];

export interface SearchHit {
  entry: TranscriptionEntry;
  data: ReadTranscriptionResult;
  score: number;
  matchedFields: SearchField[];
  snippet: string;
  snippetField?: SearchField;
}

export interface SearchOptions {
  query: string;
  fields?: SearchField[];
  limit?: number;
}

/** Extract a ~width-char snippet centered on the first occurrence of needle. */
export function makeSnippet(text: string, needle: string, width = 80, matchIndex?: number): string {
  if (!text || !needle) return '';
  const idx = matchIndex ?? text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return '';
  const half = Math.floor(width / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(text.length, idx + needle.length + half);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

/** Returns the match index in haystack (lowercased) for a pre-lowercased needle, or -1. */
function findIndex(haystack: string | undefined, needleLower: string): number {
  if (!haystack) return -1;
  return haystack.toLowerCase().indexOf(needleLower);
}

function firstArrayHit(haystack: string[] | undefined, needleLower: string): { text: string; index: number } | undefined {
  if (!haystack) return undefined;
  for (const s of haystack) {
    const idx = s.toLowerCase().indexOf(needleLower);
    if (idx !== -1) return { text: s, index: idx };
  }
  return undefined;
}

/** Score a single transcription record. Returns null if no field in scope matches. */
export function scoreRecord(
  entry: TranscriptionEntry,
  data: ReadTranscriptionResult,
  query: string,
  fields: SearchField[],
): SearchHit | null {
  const needle = query.toLowerCase();
  if (!needle) return null;

  const scope = new Set(fields);
  let score = 0;
  const matched: SearchField[] = [];
  let snippetSource = '';
  let snippetIndex = -1;
  let snippetField: SearchField | undefined;

  const setSnippet = (field: SearchField, source: string, index: number) => {
    if (!snippetField) { snippetField = field; snippetSource = source; snippetIndex = index; }
  };

  if (scope.has('title') && findIndex(data.title, needle) !== -1) {
    score += FIELD_WEIGHTS.title;
    matched.push('title');
  }
  {
    const idx = scope.has('summary') ? findIndex(data.summary, needle) : -1;
    if (idx !== -1) {
      score += FIELD_WEIGHTS.summary;
      matched.push('summary');
      setSnippet('summary', data.summary, idx);
    }
  }
  if (scope.has('keyPoints')) {
    const hit = firstArrayHit(data.keyPoints, needle);
    if (hit) {
      score += FIELD_WEIGHTS.keyPoints;
      matched.push('keyPoints');
      setSnippet('keyPoints', hit.text, hit.index);
    }
  }
  if (scope.has('actionItems')) {
    const hit = firstArrayHit(data.actionItems, needle);
    if (hit) {
      score += FIELD_WEIGHTS.actionItems;
      matched.push('actionItems');
      setSnippet('actionItems', hit.text, hit.index);
    }
  }
  {
    const idx = scope.has('transcript') ? findIndex(data.transcript, needle) : -1;
    if (idx !== -1) {
      score += FIELD_WEIGHTS.transcript;
      matched.push('transcript');
      setSnippet('transcript', data.transcript, idx);
    }
  }

  if (score === 0) return null;

  const snippet = snippetSource ? makeSnippet(snippetSource, needle, 80, snippetIndex) : '';
  return { entry, data, score, matchedFields: matched, snippet, snippetField };
}

/** Resolve which fields to search based on CLI flags. */
export function resolveFields(opts: { field?: SearchField | 'all'; includeTranscript?: boolean }): SearchField[] {
  if (opts.field === 'all') return [...ALL_FIELDS];
  if (opts.field) return [opts.field];
  return opts.includeTranscript ? [...ALL_FIELDS] : [...DEFAULT_FIELDS];
}

/** Run a search against the local transcriptions archive. */
export function searchTranscriptions(dataPath: string, opts: SearchOptions): SearchHit[] {
  const entries = listTranscriptions(dataPath, 0);
  const fields = opts.fields ?? DEFAULT_FIELDS;
  const hits: SearchHit[] = [];

  for (const entry of entries) {
    const data = readTranscription(entry.folderPath);
    if (!data) continue;
    const hit = scoreRecord(entry, data, opts.query, fields);
    if (hit) hits.push(hit);
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.entry.transcribedAt || '').localeCompare(a.entry.transcribedAt || '');
  });

  const limit = opts.limit;
  if (limit && limit > 0) return hits.slice(0, limit);
  return hits; // limit=0 or undefined → return all
}
