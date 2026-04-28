// Search box wiring and results rendering, extracted from legacy.ts
// (~lines 2094-2204).
//
// Search uses a monotonic token to drop stale responses (e.g. typing fast
// would otherwise let an older query overwrite a newer one). When the input
// is cleared, the default Recent Recordings list is shown again.

import { getDom } from '../state';
import { loadRecordings } from './recordings-list';
import { showSavedTranscript } from './transcription-modal';

type SearchHit = {
  folderName: string;
  title: string;
  audioFilePath?: string;
  transcribedAt?: string;
  matchedFields?: string[];
  snippet?: string;
  data: Record<string, unknown>;
};

type SearchResult = { success: boolean; hits: SearchHit[] };

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastSearchToken = 0;

export function setupSearch(): void {
  const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
  if (!searchInput) return;

  searchInput.addEventListener('input', () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    const q = searchInput.value.trim();
    if (!q) {
      lastSearchToken++; // drop any in-flight result so it can't overwrite the default list
      setHeadingDefault();
      void loadRecordings();
      return;
    }
    searchDebounceTimer = setTimeout(() => void runSearch(q), 200);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      lastSearchToken++;
      setHeadingDefault();
      void loadRecordings();
    }
  });
}

function setHeadingDefault(): void {
  const h = document.getElementById('recordingsHeading');
  if (h) h.textContent = 'Recent Recordings';
}

function setHeadingSearch(count: number, query: string): void {
  const h = document.getElementById('recordingsHeading');
  if (!h) return;
  h.textContent =
    count > 0 ? `Search Results (${count}) — "${query}"` : `No matches for "${query}"`;
}

export async function runSearch(query: string): Promise<void> {
  const { recordingsList } = getDom();
  const token = ++lastSearchToken;
  try {
    const result = (await window.electronAPI.searchTranscriptions({
      query,
      limit: 20,
    })) as unknown as SearchResult;
    if (token !== lastSearchToken) return; // stale response
    if (!result || !result.success) {
      recordingsList.innerHTML = '<p class="no-recordings">Search failed</p>';
      return;
    }
    renderSearchResults(result.hits, query);
  } catch (err) {
    if (token !== lastSearchToken) return;
    console.error('Search error:', err);
    recordingsList.innerHTML = '<p class="no-recordings">Search failed</p>';
  }
}

function renderSearchResults(hits: SearchHit[], query: string): void {
  const { recordingsList } = getDom();
  setHeadingSearch(hits.length, query);
  recordingsList.innerHTML = '';
  if (hits.length === 0) {
    recordingsList.innerHTML = '<p class="no-recordings">No matches</p>';
    return;
  }
  for (const hit of hits) {
    recordingsList.appendChild(createSearchResultItem(hit));
  }
}

function createSearchResultItem(hit: SearchHit): HTMLElement {
  const item = document.createElement('div');
  item.className = 'recording-item search-result-item';
  // Search hits always have a transcript by definition; mirror the
  // recordings-list affordance so the whole row opens the transcript.
  item.dataset.hasTranscript = 'true';
  item.setAttribute('role', 'button');
  item.setAttribute('tabindex', '0');
  item.setAttribute('aria-label', `Open transcript for ${hit.title || hit.folderName}`);

  const status = document.createElement('span');
  status.className = 'recording-status';
  status.setAttribute('aria-hidden', 'true');
  item.appendChild(status);

  const date = hit.transcribedAt ? new Date(hit.transcribedAt).toLocaleDateString() : '';
  const matches = (hit.matchedFields || []).join(', ');

  const info = document.createElement('div');
  info.className = 'recording-info';

  const h3 = document.createElement('h3');
  h3.textContent = hit.title || hit.folderName;
  info.appendChild(h3);

  const meta = document.createElement('p');
  meta.className = 'recording-meta';
  meta.textContent = date ? `${date} · matches: ${matches}` : `matches: ${matches}`;
  info.appendChild(meta);

  if (hit.snippet) {
    const snippet = document.createElement('p');
    snippet.className = 'search-snippet';
    snippet.textContent = hit.snippet;
    info.appendChild(snippet);
  }

  item.appendChild(info);

  const chevron = document.createElement('span');
  chevron.className = 'recording-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '›';
  item.appendChild(chevron);

  const open = () =>
    showSavedTranscript(hit.audioFilePath || '', hit.title, hit.data, hit.folderName);
  item.addEventListener('click', open);
  item.addEventListener('keydown', (e) => {
    if (e.target !== item) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  return item;
}
