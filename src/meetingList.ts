import * as fs from 'node:fs';
import type { TranscriptionEntry } from './outputService';
import { pathKeys } from './transcriptionJobs';

export type NoteListEntry = TranscriptionEntry & { audioAvailable: boolean };

/** Metadata-only list projection: local recordings retain ownership of linked notes. */
export async function unlinkedNotes(options: {
  notes: TranscriptionEntry[];
  recordings: { path: string }[];
  sidecarFor: (filePath: string) => Promise<{ transcriptionPath?: unknown } | null>;
}): Promise<NoteListEntry[]> {
  const linkedKeys = new Set<string>();
  for (const recording of options.recordings) {
    const sidecar = await options.sidecarFor(recording.path);
    if (typeof sidecar?.transcriptionPath === 'string') {
      for (const key of pathKeys(sidecar.transcriptionPath)) linkedKeys.add(key);
    }
  }
  return (
    options.notes
      // Only the sidecar-linked report is reachable through the recording row.
      // Independent reports stay visible even when they share the same audio.
      .filter((note) => !pathKeys(note.folderPath).some((key) => linkedKeys.has(key)))
      .map((note) => ({
        ...note,
        audioAvailable: !!note.audioFile && fs.existsSync(note.audioFile),
      }))
  );
}

export function syncChangedLocalNotes(result: {
  downloaded: readonly string[];
  deleted: readonly string[];
  conflicts: readonly string[];
}): boolean {
  return result.downloaded.length > 0 || result.deleted.length > 0 || result.conflicts.length > 0;
}
