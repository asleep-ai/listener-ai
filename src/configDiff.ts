// Settings-save diff. The settings form is prefilled from `getAllConfig()`,
// which reports RESOLVED values (stored, else env fallback, else default), so
// sending the whole form back would persist env-only secrets and freeze
// defaults into config.json (#210). The renderer snapshots what the form reads
// right after prefill and sends only the fields that differ from it.
//
// This module must stay importable from the renderer: no node builtins, no
// Electron.

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return a === b;
}

/** The entries of `next` whose value differs from `baseline`. */
export function diffConfigPayload<T extends object>(baseline: T, next: T): Partial<T> {
  const changed: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (!sameValue(baseline[key], next[key])) changed[key] = next[key];
  }
  return changed;
}
