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
