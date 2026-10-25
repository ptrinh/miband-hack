import { buildCustomRpk, customVersionCode, type CustomRpkOptions } from './custom';
import type { RpkSigner } from './sign';

export { getDemoSigner } from './custom';

export interface Note {
  title: string;
  body: string;
}

/** Path of the notes file inside the Notes rpk (read on the band with @system.file). */
export const NOTES_PATH = 'common/notes.json';
export const NOTES_PACKAGE_ID = 'uk.trinh.miband.notes';
/** Upper bound for the serialized notes.json (the band reads it into memory in one go). */
export const MAX_NOTES_BYTES = 100 * 1024;

export function serializeNotes(notes: Note[]): Uint8Array {
  const clean = notes.map((n, i) => {
    if (!n || typeof n.title !== 'string' || typeof n.body !== 'string') throw new Error(`notes[${i}]: title and body must be strings`);
    return { title: n.title, body: n.body };
  });
  const bytes = new TextEncoder().encode(JSON.stringify({ notes: clean }));
  if (bytes.length > MAX_NOTES_BYTES) throw new Error(`notes too large: ${bytes.length} bytes (max ${MAX_NOTES_BYTES})`);
  return bytes;
}

/**
 * Returns a signed Notes rpk whose common/notes.json holds `notes`.
 * `template` is public/apps/notes.rpk (fetch it as an ArrayBuffer). Signs with the public demo key
 * unless another signer is given.
 */
export async function buildNotesRpk(template: Uint8Array, notes: Note[], signer?: RpkSigner, options?: CustomRpkOptions): Promise<Uint8Array> {
  return buildCustomRpk(template, NOTES_PATH, serializeNotes(notes), signer, options);
}

/** Monotonic version code for re-packed Notes builds: minutes since 2026-01-01 (fits in uint32). */
export const notesVersionCode = customVersionCode;
