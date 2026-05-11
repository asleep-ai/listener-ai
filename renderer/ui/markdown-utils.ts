// Markdown rendering and structured-data helpers for the transcription UI.
// Extracted from legacy.ts (~lines 1284-1416). Behavior preserved verbatim.

import { type Tokens, marked } from 'marked';

// Strip raw HTML from markdown output to prevent XSS
marked.use({
  renderer: {
    html: (token: Tokens.HTML | Tokens.Tag) => escapeHtml(token.raw),
  },
});

// Convert camelCase key to display label
export function camelToLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

// Escape HTML to prevent XSS from untrusted content
export function escapeHtml(str: unknown): string {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// Shape of the structured transcription data the UI consumes. Kept loose
// (`any`) intentionally because the upstream Gemini schema can include
// arbitrary `customFields` and is treated as untyped JSON elsewhere.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TranscriptionData = any;

function formatLiveNoteTimestamp(offsetMs: unknown): string {
  const n = Number(offsetMs);
  const totalSeconds = Number.isFinite(n) ? Math.max(0, Math.floor(n / 1000)) : 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function liveNotesToLines(liveNotes: unknown): string[] {
  if (!Array.isArray(liveNotes) || liveNotes.length === 0) return [];
  const lines: string[] = [];
  for (const note of liveNotes) {
    if (!note || typeof note !== 'object') continue;
    const ts = formatLiveNoteTimestamp((note as { offsetMs?: unknown }).offsetMs);
    const raw = (note as { text?: unknown }).text;
    const text = typeof raw === 'string' ? raw.trim() : '';
    lines.push(text ? `- [${ts}] ${text}` : `- [${ts}] 🏴`);
  }
  return lines;
}

function highlightsToLines(highlights: unknown): string[] {
  if (!Array.isArray(highlights) || highlights.length === 0) return [];
  const lines: string[] = [];
  for (const h of highlights) {
    if (!h || typeof h !== 'object') continue;
    const ts = formatLiveNoteTimestamp((h as { offsetMs?: unknown }).offsetMs);
    const userText = (h as { userText?: unknown }).userText;
    const title = typeof userText === 'string' ? userText.trim() : '';
    lines.push(title ? `### [${ts}] ${title}` : `### [${ts}] 🏴`);
    const subtitle = (h as { subtitle?: unknown }).subtitle;
    if (typeof subtitle === 'string' && subtitle.trim()) {
      lines.push(`*${subtitle.trim()}*`);
    }
    const bullets = (h as { bullets?: unknown }).bullets;
    if (Array.isArray(bullets) && bullets.length > 0) {
      lines.push('');
      for (const b of bullets) {
        if (typeof b === 'string' && b.trim()) lines.push(`- ${b}`);
      }
    }
    lines.push('');
  }
  return lines;
}

function renderHighlightLines(data: TranscriptionData): string[] {
  const enriched = highlightsToLines(data.highlights);
  if (enriched.length > 0) return enriched;
  return liveNotesToLines(data.liveNotes);
}

// Convert structured transcription data to a markdown string
export function structuredToMarkdown(data: TranscriptionData, section: string): string {
  const lines: string[] = [];

  if (section === 'all' || section === 'summary') {
    if (data.summary) {
      if (section === 'all') lines.push('## Summary\n');
      lines.push(data.summary);
      lines.push('');
    }
  }

  if (section === 'all' || section === 'keypoints') {
    if (data.keyPoints?.length) {
      if (section === 'all') lines.push('## Key Points\n');
      for (const point of data.keyPoints) {
        lines.push(`- ${point}`);
      }
      lines.push('');
    }
  }

  if (section === 'all' || section === 'actions') {
    if (data.actionItems?.length) {
      if (section === 'all') lines.push('## Action Items\n');
      for (const item of data.actionItems) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }
  }

  if (section === 'all' || section === 'livenotes') {
    const noteLines = renderHighlightLines(data);
    if (noteLines.length > 0) {
      if (section === 'all') lines.push('## 🗒️ Highlights\n');
      lines.push(...noteLines);
      lines.push('');
    }
  }

  if (section === 'all' && data.customFields) {
    for (const [key, value] of Object.entries(data.customFields)) {
      if (value == null) continue;
      lines.push(`## ${camelToLabel(key)}\n`);
      if (Array.isArray(value)) {
        for (const v of value) lines.push(`- ${v}`);
      } else if (typeof value === 'string') {
        lines.push(value);
      } else {
        lines.push(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
      }
      lines.push('');
    }
  }

  if (section?.startsWith('cf-') && data.customFields) {
    const cfKey = section.slice(3);
    const value = data.customFields[cfKey];
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`- ${v}`);
    } else if (typeof value === 'string') {
      lines.push(value);
    } else if (value != null) {
      lines.push(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
    }
    lines.push('');
  }

  if (section === 'transcript') {
    lines.push(data.transcript || '');
  }

  return lines.join('\n').trim();
}

// Render markdown string to HTML
export function renderMarkdown(md: string): string {
  return marked.parse(md || '', { breaks: true }) as string;
}

// Render dynamic field tabs (keyPoints, actionItems, and any custom fields)
export function renderDynamicFields(data: TranscriptionData): void {
  const fields: Array<{ key: string; label: string; value: unknown }> = [];

  if (data.keyPoints?.length) {
    fields.push({ key: 'keypoints', label: 'Key Points', value: data.keyPoints });
  }
  if (data.actionItems?.length) {
    fields.push({ key: 'actions', label: 'Action Items', value: data.actionItems });
  }
  const hasHighlights = Array.isArray(data.highlights) && data.highlights.length > 0;
  const hasLiveNotes = Array.isArray(data.liveNotes) && data.liveNotes.length > 0;
  if (hasHighlights || hasLiveNotes) {
    fields.push({
      key: 'livenotes',
      label: '🗒️ Highlights',
      value: hasHighlights ? data.highlights : data.liveNotes,
    });
  }
  if (data.customFields) {
    for (const [key, value] of Object.entries(data.customFields)) {
      if (value != null && (typeof value !== 'string' || value.trim())) {
        fields.push({ key: `cf-${key}`, label: camelToLabel(key), value });
      }
    }
  }

  const tabsContainer = document.querySelector('.transcription-tabs') as HTMLElement | null;
  const contentContainer = document.querySelector('.tab-content') as HTMLElement | null;
  if (!tabsContainer || !contentContainer) return;

  // Remove old dynamic elements and restore first tab as active
  tabsContainer.querySelectorAll('.tab-button.dynamic').forEach((el) => el.remove());
  contentContainer.querySelectorAll('.tab-pane.dynamic').forEach((el) => el.remove());
  tabsContainer.querySelector('.tab-button')?.classList.add('active');
  contentContainer.querySelector('.tab-pane')?.classList.add('active');

  const transcriptBtn = tabsContainer.querySelector('[data-tab="transcript"]');
  const transcriptPane = document.getElementById('transcript');

  for (const field of fields) {
    // Tab button
    const btn = document.createElement('button');
    btn.className = 'tab-button dynamic';
    btn.dataset.tab = field.key;
    btn.textContent = field.label;
    tabsContainer.insertBefore(btn, transcriptBtn);

    // Tab pane
    const pane = document.createElement('div');
    pane.id = field.key;
    pane.className = 'tab-pane dynamic';

    const safeKey = escapeHtml(field.key);
    const copyBtn = `<button class="copy-button" data-copy-target="${safeKey}">📋 Copy</button>`;
    const md = structuredToMarkdown(data, field.key);
    pane.innerHTML = `${copyBtn}<div class="${safeKey}-content markdown-body">${renderMarkdown(md)}</div>`;
    contentContainer.insertBefore(pane, transcriptPane);
  }
}
