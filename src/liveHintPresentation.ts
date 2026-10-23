/** Pure session-only hint browsing rules; original text is never normalized for display. */
export interface HintPresentation {
  id: string;
  title?: string;
  text: string;
  detail?: string;
  topicId?: string;
  topicLabel?: string;
  anchorOffsetMs?: number;
  offsetMs?: number;
  updatedOffsetMs?: number;
  history?: readonly {
    revision: number;
    title?: string;
    text: string;
    detail?: string;
    anchorOffsetMs?: number;
    producedOffsetMs: number;
    sourceState?: 'final' | 'draft' | 'retracted';
    sources?: readonly { id: string; label: string; offsetMs?: number; draft?: boolean }[];
  }[];
  sources: readonly { offsetMs?: number }[];
}

export function hintTitle(hint: HintPresentation): string {
  return hint.title?.trim() || hint.text;
}

export function hintAnchor(hint: HintPresentation): number | undefined {
  if (Number.isFinite(hint.anchorOffsetMs) && hint.anchorOffsetMs! >= 0) return hint.anchorOffsetMs;
  const offsets = hint.sources
    .map((source) => source.offsetMs)
    .filter(
      (offset): offset is number =>
        typeof offset === 'number' && Number.isFinite(offset) && offset >= 0,
    );
  return offsets.length ? Math.max(...offsets) : undefined;
}

export function searchHints<T extends HintPresentation>(hints: readonly T[], query: string): T[] {
  const normalize = (value: string) => value.normalize('NFC').toLowerCase();
  const needle = normalize(query.trim());
  return hints.filter(
    (hint) =>
      !needle ||
      [
        hint.title,
        hint.text,
        hint.detail,
        hint.topicLabel,
        ...(hint.history || []).flatMap((entry) => [entry.title, entry.text, entry.detail]),
      ].some((value) => value && normalize(value).includes(needle)),
  );
}

export function orderHints<T extends HintPresentation>(hints: readonly T[]): T[] {
  return [...hints].sort(
    (a, b) =>
      (hintAnchor(a) ?? Infinity) - (hintAnchor(b) ?? Infinity) ||
      (a.offsetMs ?? Infinity) - (b.offsetMs ?? Infinity) ||
      a.id.localeCompare(b.id, 'en'),
  );
}

export function groupHints<T extends HintPresentation>(
  hints: readonly T[],
): { id: string; label: string; hints: T[] }[] {
  const groups = new Map<string, { id: string; label: string; hints: T[] }>();
  for (const hint of orderHints(hints)) {
    const id = hint.topicId || '';
    let group = groups.get(id);
    if (!group) {
      group = { id, label: hint.topicLabel || '미분류', hints: [] };
      groups.set(id, group);
    }
    group.hints.push(hint);
  }
  return [...groups.values()];
}

/** Match the engine's 200-cue session bound while retaining explicitly pinned older cues. */
export function retainHints<T extends { id: string }>(
  hints: readonly T[],
  pins: ReadonlySet<string>,
): T[] {
  return hints.filter((hint, index) => index < 200 || pins.has(hint.id));
}
