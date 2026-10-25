import { unzipSync } from 'fflate';
import { repackRpk, type RepackOptions } from './repack';
import { createWebCryptoSigner, type RpkSigner } from './sign';
// INTENTIONALLY PUBLIC demo signing key: it ships in the web bundle so the browser can re-sign
// the Notes app. It proves nothing about authorship. Never reuse it for anything that needs a
// private key (see demo-key/README.md).
import demoPrivateKeyPem from './demo-key/private.pem?raw';
import demoCertificatePem from './demo-key/certificate.pem?raw';

export interface Note {
  title: string;
  body: string;
}

/** Path of the notes file inside the Notes rpk (read on the band with @system.file). */
export const NOTES_PATH = 'common/notes.json';
export const NOTES_PACKAGE_ID = 'uk.trinh.miband.notes';
/** Upper bound for the serialized notes.json (the band reads it into memory in one go). */
export const MAX_NOTES_BYTES = 100 * 1024;

let demoSigner: Promise<RpkSigner> | undefined;

/** Signer using the public demo key, the same key that signs public/apps/notes.rpk. */
export function getDemoSigner(): Promise<RpkSigner> {
  demoSigner ??= createWebCryptoSigner(demoPrivateKeyPem, demoCertificatePem);
  return demoSigner;
}

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
export async function buildNotesRpk(
  template: Uint8Array,
  notes: Note[],
  signer?: RpkSigner,
  options?: RepackOptions & { versionCode?: number },
): Promise<Uint8Array> {
  const replace: Record<string, Uint8Array> = { [NOTES_PATH]: serializeNotes(notes) };
  if (options?.versionCode !== undefined) Object.assign(replace, bumpVersionCode(template, options.versionCode));
  return repackRpk(template, replace, signer ?? (await getDemoSigner()), options);
}

/**
 * Rewrites versionCode in manifest.json / manifest-watch.json, so every re-pack is a newer
 * version and the band treats it as an update rather than a reinstall of version 1.
 */
export function bumpVersionCode(template: Uint8Array, versionCode: number): Record<string, Uint8Array> {
  const names = ['manifest.json', 'manifest-watch.json'];
  const files = unzipSync(template, { filter: (f) => names.includes(f.name) });
  const out: Record<string, Uint8Array> = {};
  for (const name of names) {
    if (!files[name]) continue;
    const json = JSON.parse(new TextDecoder().decode(files[name]));
    if (typeof json.versionCode === 'number') json.versionCode = versionCode;
    out[name] = new TextEncoder().encode(JSON.stringify(json, null, 2));
  }
  return out;
}

/** Monotonic version code for re-packed Notes builds: minutes since 2026-01-01 (fits in uint32). */
export function notesVersionCode(now = Date.now()): number {
  return Math.max(2, Math.floor((now - Date.UTC(2026, 0, 1)) / 60000));
}
