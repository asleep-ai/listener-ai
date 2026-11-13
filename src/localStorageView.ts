// Pure model and wording for the "Storage on this device" settings and list
// toasts. Shared by the renderer and tests: no node or Electron imports.

import type { LocalStorageReportPayload } from './electronApiTypes';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Plain-language reason a recording kept its local audio. */
export function describeSkip(reason: string | undefined, detail?: string): string {
  switch (reason) {
    case 'in-use':
      return 'it is being recorded, transcribed, merged or exported right now.';
    case 'not-backed-up':
    case 'changed':
      return 'it has not been fully uploaded to Google Drive yet. Sync, then try again.';
    case 'drive-mismatch':
      return 'the Google Drive copy does not match it.';
    case 'drive-unavailable':
      return detail ?? 'Google Drive could not be reached.';
    case 'not-linked':
      return 'no saved meeting uses it, so it has no Drive copy.';
    case 'not-managed':
      return 'it is not a Listener.AI recording.';
    case 'too-recent':
      return 'it was used recently.';
    case 'cancelled':
      return 'the Google sign-in changed while removing.';
    default:
      return detail ?? 'something went wrong.';
  }
}

/**
 * Categories of space on this device, in bar order. The key doubles as the
 * CSS modifier that gives each category its color and pattern.
 */
export type StorageCategory = 'freeable' | 'pending' | 'kept' | 'notes' | 'other';

export interface StorageSegment {
  category: StorageCategory;
  label: string;
  bytes: number;
  size: string;
  /** Longer explanation with counts, for the disclosure; undefined when none. */
  detail?: string;
}

export interface StorageSummary {
  /** Visible headline, e.g. "300 MB in total". */
  total: string;
  /** Right-hand headline: what can be done right now. */
  reclaim: { text: string; tone: 'action' | 'muted' };
  /** Non-empty categories that live on this device, in bar order. */
  segments: StorageSegment[];
  /** Denominator for the bar widths (never 0). */
  barBytes: number;
  /** Audio kept only in Google Drive; not part of the bar. */
  cloudOnly?: string;
  /** Meetings whose audio lives elsewhere on the computer. */
  external?: string;
  /** Whether the primary action may run. */
  canFree: boolean;
  /** Primary action label. */
  freeLabel: string;
}

/** Space report as a renderable model, most important first. */
export function storageSummary(
  report: LocalStorageReportPayload,
  state: { signedIn: boolean },
): StorageSummary {
  const freeable = Math.max(0, report.eligibleBytes);
  const pending = Math.max(0, report.notBackedUpBytes);
  const kept = Math.max(0, report.audioBytes - freeable - pending);
  const canFree = state.signedIn && report.eligibleFiles > 0;

  const all: StorageSegment[] = [
    {
      category: 'freeable',
      label: state.signedIn ? 'Can be freed' : 'Audio in Drive',
      bytes: freeable,
      size: formatBytes(freeable),
      detail:
        report.eligibleFiles > 0
          ? `${plural(report.eligibleFiles, 'recording')} already in Google Drive`
          : undefined,
    },
    {
      category: 'pending',
      label: 'Waiting to upload',
      bytes: pending,
      size: formatBytes(pending),
      detail:
        report.notBackedUpFiles > 0
          ? `${plural(report.notBackedUpFiles, 'recording')}, kept until a sync uploads ${
              report.notBackedUpFiles === 1 ? 'it' : 'them'
            }`
          : undefined,
    },
    {
      category: 'kept',
      label: 'Audio kept here',
      bytes: kept,
      size: formatBytes(kept),
      detail:
        report.unlinkedFiles > 0
          ? `Includes ${plural(report.unlinkedFiles, 'recording')} without a saved meeting, which always ${
              report.unlinkedFiles === 1 ? 'stays' : 'stay'
            } here`
          : undefined,
    },
    {
      category: 'notes',
      label: 'Transcripts',
      bytes: report.notesBytes,
      size: formatBytes(report.notesBytes),
    },
    {
      category: 'other',
      label: 'Other',
      bytes: report.otherBytes,
      size: formatBytes(report.otherBytes),
    },
  ];
  const segments = all.filter((s) => s.bytes > 0);
  const segmentBytes = segments.reduce((sum, s) => sum + s.bytes, 0);

  let reclaim: StorageSummary['reclaim'];
  if (!state.signedIn) {
    reclaim = { text: 'Sign in to Google Drive to free space', tone: 'muted' };
  } else if (canFree) {
    reclaim = { text: `${formatBytes(freeable)} can be freed`, tone: 'action' };
  } else {
    reclaim = { text: 'Nothing to free right now', tone: 'muted' };
  }

  return {
    total: `${formatBytes(report.totalBytes)} in total`,
    reclaim,
    segments,
    barBytes: Math.max(1, report.totalBytes, segmentBytes),
    cloudOnly:
      report.cloudOnlyFiles > 0
        ? `${plural(report.cloudOnlyFiles, 'recording')} in Google Drive only (${formatBytes(
            report.cloudOnlyBytes,
          )}), not using space here`
        : undefined,
    external:
      report.externalFiles > 0
        ? `${plural(report.externalFiles, 'meeting')} ${
            report.externalFiles === 1 ? 'uses' : 'use'
          } audio stored elsewhere on your computer. Listener.AI never uploads or removes it.`
        : undefined,
    canFree,
    freeLabel: canFree ? `Free up ${formatBytes(freeable)}` : 'Free up space',
  };
}
