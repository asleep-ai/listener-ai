// Curated model lists for the Settings -> AI Provider tab. Each field
// renders one of these arrays as a <select>, followed by a "Custom..."
// option that reveals a free-form input for advanced users who want to type
// a model id we haven't curated yet.

export type ModelField =
  | 'geminiModel'
  | 'geminiFlashModel'
  | 'codexModel'
  | 'codexTranscriptionModel';

export const CUSTOM_MODEL_SENTINEL = '__custom__';

export const CURATED_MODELS: Record<ModelField, readonly string[]> = {
  geminiModel: ['gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  geminiFlashModel: ['gemini-2.5-flash', 'gemini-3.5-flash'],
  codexModel: ['gpt-5.5', 'gpt-5'],
  codexTranscriptionModel: ['gpt-4o-transcribe-diarize', 'gpt-4o-transcribe'],
} as const;

// Mirrors DEFAULT_*_MODEL in src/aiProvider.ts. Surfaced as the "Default (X)"
// dropdown entry so the user can see what gets used when no override is set,
// and so Reset to Default has a stable visible target.
export const BACKEND_DEFAULTS: Record<ModelField, string> = {
  geminiModel: 'gemini-3.5-flash',
  geminiFlashModel: 'gemini-2.5-flash',
  codexModel: 'gpt-5.5',
  codexTranscriptionModel: 'gpt-4o-transcribe-diarize',
} as const;

export type SelectChoice = { kind: 'curated'; value: string } | { kind: 'custom'; value: string };

// Given a saved value, decide whether to pre-select a curated option or fall
// into Custom mode. Empty string means "no override" -- the renderer maps
// that to the "Default (X)" sentinel option at the top of the dropdown.
//
// `getAllConfig()` resolves empty -> backend default before sending to the
// renderer, so a freshly-installed user whose `geminiModel` is unset arrives
// here with `saved === 'gemini-3.5-flash'`. Treating that as "no override"
// keeps the Default entry visible instead of snapping to the curated entry
// of the same name. The two are functionally identical anyway -- if the
// user picks the curated entry explicitly, the backend resolves to the same
// model.
export function chooseInitial(field: ModelField, saved: string | undefined): SelectChoice {
  const trimmed = (saved ?? '').trim();
  if (trimmed.length === 0 || trimmed === BACKEND_DEFAULTS[field]) {
    return { kind: 'curated', value: '' };
  }
  const curated = CURATED_MODELS[field];
  if (curated.includes(trimmed)) return { kind: 'curated', value: trimmed };
  return { kind: 'custom', value: trimmed };
}
