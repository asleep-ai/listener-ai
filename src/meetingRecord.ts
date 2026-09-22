// Meeting-record shapes, validators, and the shared markdown emitter for the
// Summary / Key Points / Action Items blocks. Lives in src/ (not
// src/services/) because both the CJS main build and the Vite renderer import
// it -- keep this file dependency-free (no node, no electron, no marked).

export interface SummarySection {
  heading: string;
  bullets: string[];
}

export interface ActionItemGroup {
  owner: string;
  items: string[];
}

/** Owner labels the summary model emits when it couldn't attribute a name. */
const TRANSCRIPT_PLACEHOLDER_OWNER = /^(?:speaker|participant|참가자)\s*#?\s*\d+$/iu;

export interface ParseActionItemGroupsOptions {
  /**
   * Drop groups owned by an unattributed `Speaker 1` placeholder instead of
   * keeping them. Only the summary-parsing path in geminiService wants this;
   * stored records and the renderer render whatever was persisted.
   */
  dropPlaceholderOwners?: boolean;
}

/**
 * Validate the structured `summarySections` field. All-or-nothing: a single
 * malformed entry (non-object, blank heading, missing/empty bullets, or a
 * bullet that isn't a non-blank string) discards the whole array. Returns `[]`
 * when the input is unusable; callers that persist `undefined` for "absent"
 * coalesce on `.length`.
 */
export function parseSummarySections(value: unknown): SummarySection[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const sections: SummarySection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return [];
    const heading = (entry as { heading?: unknown }).heading;
    const bullets = (entry as { bullets?: unknown }).bullets;
    if (
      typeof heading !== 'string' ||
      !heading.trim() ||
      !Array.isArray(bullets) ||
      bullets.length === 0 ||
      !bullets.every((bullet) => typeof bullet === 'string' && bullet.trim())
    ) {
      return [];
    }
    sections.push({ heading: heading.trim(), bullets: bullets.map((bullet) => bullet.trim()) });
  }
  return sections;
}

/**
 * Validate the structured `actionItemGroups` field. Same all-or-nothing rule as
 * `parseSummarySections`. With `dropPlaceholderOwners`, groups whose owner is a
 * `Speaker 1` / `참가자 2` placeholder are skipped -- that can empty an
 * otherwise-valid array, which callers treat the same as invalid.
 */
export function parseActionItemGroups(
  value: unknown,
  options: ParseActionItemGroupsOptions = {},
): ActionItemGroup[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const groups: ActionItemGroup[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return [];
    const owner = (entry as { owner?: unknown }).owner;
    const items = (entry as { items?: unknown }).items;
    if (
      typeof owner !== 'string' ||
      !owner.trim() ||
      !Array.isArray(items) ||
      items.length === 0 ||
      !items.every((item) => typeof item === 'string' && item.trim())
    ) {
      return [];
    }
    const trimmedOwner = owner.trim();
    if (options.dropPlaceholderOwners && TRANSCRIPT_PLACEHOLDER_OWNER.test(trimmedOwner)) continue;
    groups.push({ owner: trimmedOwner, items: items.map((item) => item.trim()) });
  }
  return groups;
}

/** Convert camelCase key to a display label: "keyDecisions" -> "Key Decisions" */
export function camelToLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s: string) => s.toUpperCase())
    .trim();
}

/** Subset of a meeting record the shared emitter consumes. Values are assumed
 * already validated -- callers reading untrusted JSON run them through
 * `parseSummarySections` / `parseActionItemGroups` first. Intentionally loose
 * so the writer-side and reader-side shapes both satisfy it. */
export interface MeetingSectionsInput {
  summary?: string;
  summarySections?: SummarySection[];
  keyPoints?: string[];
  actionItems?: string[];
  actionItemGroups?: ActionItemGroup[];
}

/**
 * Emit the Summary / Key Points / Action Items markdown blocks as lines the
 * caller joins with `\n`. `section` selects a single block and suppresses its
 * `## ` heading (the per-field tabs in the UI render their own header); the
 * default `'all'` emits every block with headings. Any other value emits
 * nothing, so callers can pass their own section key straight through.
 */
export function renderMeetingSections(
  input: MeetingSectionsInput,
  section: string = 'all',
): string[] {
  const lines: string[] = [];

  if (section === 'all' || section === 'summary') {
    if (input.summarySections?.length) {
      if (section === 'all') lines.push('## Summary\n');
      for (const summarySection of input.summarySections) {
        lines.push(`### ${summarySection.heading}`);
        for (const bullet of summarySection.bullets) lines.push(`- ${bullet}`);
        lines.push('');
      }
    } else if (input.summary) {
      if (section === 'all') lines.push('## Summary\n');
      lines.push(input.summary);
      lines.push('');
    }
  }

  if (section === 'all' || section === 'keypoints') {
    if (input.keyPoints?.length) {
      if (section === 'all') lines.push('## Key Points\n');
      for (const point of input.keyPoints) {
        lines.push(`- ${point}`);
      }
      lines.push('');
    }
  }

  if (section === 'all' || section === 'actions') {
    if (input.actionItemGroups?.length) {
      if (section === 'all') lines.push('## Action Items\n');
      for (const group of input.actionItemGroups) {
        lines.push(`### ${group.owner}`);
        for (const item of group.items) lines.push(`- ${item}`);
        lines.push('');
      }
    } else if (input.actionItems?.length) {
      if (section === 'all') lines.push('## Action Items\n');
      for (const item of input.actionItems) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }
  }

  return lines;
}
