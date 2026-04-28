// Release-notes modal + history viewer.
// Extracted from legacy.ts (~lines 320-402). Behavior preserved verbatim.

import { escapeHtml, renderMarkdown } from './markdown-utils';

type ReleaseNotes = { version: string; body: string; url: string };

async function openReleaseHistory(): Promise<void> {
  const modal = document.getElementById('releaseHistoryModal') as HTMLElement | null;
  const list = document.getElementById('releaseHistoryList') as HTMLElement | null;
  const closeBtn = document.getElementById('releaseHistoryClose') as HTMLElement | null;
  const dismissBtn = document.getElementById('releaseHistoryDismiss') as HTMLElement | null;
  const githubBtn = document.getElementById('releaseHistoryOpenGithub') as HTMLElement | null;
  if (!modal || !list) return;

  const hide = () => {
    modal.style.display = 'none';
  };
  if (closeBtn) (closeBtn as HTMLElement).onclick = hide;
  if (dismissBtn) (dismissBtn as HTMLElement).onclick = hide;
  if (githubBtn) {
    (githubBtn as HTMLElement).onclick = () => {
      window.electronAPI.openExternal('https://github.com/asleep-ai/listener-ai/releases');
    };
  }

  list.innerHTML = '<p class="loading">Loading releases...</p>';
  modal.style.display = 'block';

  try {
    const releases = await window.electronAPI.getAllReleases();
    if (!releases || releases.length === 0) {
      list.innerHTML = '<p class="loading">No releases found.</p>';
      return;
    }
    list.innerHTML = releases
      .map((r) => {
        const date = r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : '';
        const prereleaseLabel = r.prerelease
          ? ' <span class="release-prerelease">pre-release</span>'
          : '';
        const body = (r.body || '').trim() || '_No notes._';
        return `
        <details class="release-history-item">
          <summary>
            <span class="release-tag">${escapeHtml(r.name || r.tag)}</span>
            <span class="release-date">${escapeHtml(date)}</span>${prereleaseLabel}
          </summary>
          <div class="release-notes-body">${renderMarkdown(body)}</div>
        </details>
      `;
      })
      .join('');
  } catch (error) {
    console.error('Failed to load release history:', error);
    list.innerHTML = '<p class="loading">Failed to load releases.</p>';
  }
}

function showReleaseNotes(notes: ReleaseNotes): void {
  const modal = document.getElementById('releaseNotesModal') as HTMLElement | null;
  const title = document.getElementById('releaseNotesTitle') as HTMLElement | null;
  const body = document.getElementById('releaseNotesBody') as HTMLElement | null;
  const closeBtn = document.getElementById('releaseNotesClose') as HTMLElement | null;
  const dismissBtn = document.getElementById('releaseNotesDismiss') as HTMLElement | null;
  const githubBtn = document.getElementById('releaseNotesOpenGithub') as HTMLElement | null;
  if (!modal || !title || !body) return;

  title.textContent = `What's New in v${notes.version}`;
  const md = (notes.body || '').trim() || '_No release notes available for this version._';
  body.innerHTML = renderMarkdown(md);

  const hide = () => {
    modal.style.display = 'none';
  };
  if (closeBtn) (closeBtn as HTMLElement).onclick = hide;
  if (dismissBtn) (dismissBtn as HTMLElement).onclick = hide;
  if (githubBtn) {
    (githubBtn as HTMLElement).onclick = () => {
      if (notes.url) window.electronAPI.openExternal(notes.url);
      hide();
    };
  }

  modal.style.display = 'block';
}

export function setupReleaseNotes(): void {
  // Listen for release notes after an update
  if (window.electronAPI.onShowReleaseNotes) {
    window.electronAPI.onShowReleaseNotes((notes) => {
      showReleaseNotes(notes);
    });
  }

  // Listen for Help → Release Notes menu click
  if (window.electronAPI.onOpenReleaseHistory) {
    window.electronAPI.onOpenReleaseHistory(() => {
      openReleaseHistory();
    });
  }
}
