// "Storage on this device" settings: space composition, the automatic removal
// setting's non-standard values, and "Free up space". Removing local audio
// never deletes anything from Google Drive or the note itself.

import {
  describeSkip,
  formatBytes,
  plural,
  storageSummary,
  type StorageSummary,
} from '../../src/localStorageView';

export { describeSkip };

let reportToken = 0;

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cloudIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('storage-cloud-icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M6 15.5h8.5a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 5.2 8.1 3.7 3.7 0 0 0 6 15.5Z',
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function renderReport(summary: StorageSummary): HTMLElement[] {
  const head = el('div', 'storage-head');
  head.append(
    el('p', 'storage-total', summary.total),
    el('p', `storage-reclaim is-${summary.reclaim.tone}`, summary.reclaim.text),
  );

  // Decorative: the legend below carries every value as text.
  const bar = el('div', 'storage-bar');
  bar.setAttribute('aria-hidden', 'true');
  for (const seg of summary.segments) {
    const part = el('span', `storage-seg is-${seg.category}`);
    part.style.flexGrow = String(seg.bytes / summary.barBytes);
    bar.append(part);
  }

  const legend = el('ul', 'storage-legend');
  legend.setAttribute('aria-label', 'Breakdown');
  for (const seg of summary.segments) {
    const item = el('li', 'storage-legend-item');
    const swatch = el('span', `storage-swatch is-${seg.category}`);
    swatch.setAttribute('aria-hidden', 'true');
    item.append(
      swatch,
      el('span', 'storage-legend-label', seg.label),
      el('span', 'storage-legend-value', seg.size),
    );
    legend.append(item);
  }

  const nodes: HTMLElement[] = [head, bar];
  if (summary.segments.length > 0) nodes.push(legend);
  if (summary.cloudOnly) {
    const cloud = el('p', 'storage-cloud');
    cloud.append(cloudIcon(), el('span', undefined, summary.cloudOnly));
    nodes.push(cloud);
  }
  return nodes;
}

function renderCounts(summary: StorageSummary): void {
  const list = document.getElementById('localStorageCounts');
  if (!list) return;
  const lines = summary.segments.flatMap((seg) =>
    seg.detail ? [`${seg.label}: ${seg.detail}.`] : [],
  );
  if (summary.external) lines.push(summary.external);
  list.replaceChildren(...lines.map((line) => el('li', undefined, line)));
  list.hidden = lines.length === 0;
}

function setFreeButton(summary: StorageSummary | null): void {
  const freeBtn = document.getElementById('freeLocalAudioNow') as HTMLButtonElement | null;
  if (!freeBtn) return;
  freeBtn.disabled = !summary?.canFree;
  freeBtn.textContent = summary?.freeLabel ?? 'Free up space';
}

function showReportError(target: HTMLElement, message: string): void {
  target.replaceChildren(el('p', 'storage-error', `Couldn't measure storage: ${message}`));
  setFreeButton(null);
}

export async function refreshLocalStorageReport(): Promise<void> {
  const target = document.getElementById('localStorageReport');
  if (!target) return;
  const token = ++reportToken;
  try {
    const res = await window.electronAPI.getLocalStorageReport();
    if (token !== reportToken) return;
    if (!res.success) {
      showReportError(target, res.error);
      return;
    }
    const summary = storageSummary(res.report, res);
    target.replaceChildren(...renderReport(summary));
    renderCounts(summary);
    setFreeButton(summary);
  } catch (error) {
    if (token !== reportToken) return;
    showReportError(target, error instanceof Error ? error.message : String(error));
  }
}

/**
 * A value set from the CLI (e.g. 10 days) has no preset option; add one so
 * the select shows it instead of going blank, and saving keeps it.
 */
export function ensureOffloadOption(days: number | undefined): void {
  const select = document.getElementById('audioOffloadAfterDays') as HTMLSelectElement | null;
  if (!select || !days || days <= 0) return;
  const value = String(days);
  if (![...select.options].some((o) => o.value === value)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `When not used for ${plural(days, 'day')}`;
    select.append(option);
  }
  select.value = value;
}

export function setupLocalStorageSettings(): void {
  const freeBtn = document.getElementById('freeLocalAudioNow') as HTMLButtonElement | null;
  const statusEl = document.getElementById('freeLocalAudioStatus');
  const setStatus = (text: string, state: 'idle' | 'success' | 'error' = 'idle') => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `slack-webhook-status${state === 'idle' ? '' : ` is-${state}`}`;
  };
  freeBtn?.addEventListener('click', async () => {
    const ok = confirm(
      'Remove the local audio of every meeting backed up to Google Drive?\n\n' +
        'Transcripts and notes stay on this device, and the audio stays in Google Drive. ' +
        'Each file is checked against its Drive copy first, and you can download any of them again.',
    );
    if (!ok) return;
    freeBtn.disabled = true;
    setStatus('Checking Drive copies...');
    try {
      const res = await window.electronAPI.freeLocalAudio({});
      if (!res.success) {
        setStatus(res.error, 'error');
        return;
      }
      const { removed, skipped, freedBytes } = res.result;
      const kept = skipped.filter((s) => s.reason !== 'not-linked' && s.reason !== 'not-managed');
      let text = removed.length
        ? `Freed ${formatBytes(freedBytes)} from ${plural(removed.length, 'recording')}.`
        : 'Nothing was removed.';
      if (kept.length > 0) {
        text += ` Kept ${plural(kept.length, 'recording')}: ${describeSkip(kept[0].reason, kept[0].detail)}`;
      }
      setStatus(text, kept.length > 0 && removed.length === 0 ? 'error' : 'success');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      await refreshLocalStorageReport();
    }
  });
  window.electronAPI.onLocalStorageChanged(() => {
    const modal = document.getElementById('configModal') as HTMLDialogElement | null;
    if (modal?.open) void refreshLocalStorageReport();
  });
}
