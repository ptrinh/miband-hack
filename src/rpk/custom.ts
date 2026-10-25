import { unzipSync } from 'fflate';
import { repackRpk, type RepackOptions } from './repack';
import { createWebCryptoSigner, type RpkSigner } from './sign';
// INTENTIONALLY PUBLIC demo signing key: it ships in the web bundle so the browser can re-sign
// the customizable demo apps (Notes, Checklist). It proves nothing about authorship. Never reuse
// it for anything that needs a private key (see demo-key/README.md).
import demoPrivateKeyPem from './demo-key/private.pem?raw';
import demoCertificatePem from './demo-key/certificate.pem?raw';

// Shared by the demo apps whose content is written in the webapp: the app reads one JSON file
// from its own package at runtime, and the browser swaps that file and re-signs the rpk.

export type CustomRpkOptions = RepackOptions & { versionCode?: number };

let demoSigner: Promise<RpkSigner> | undefined;

/** Signer using the public demo key, the same key that signs the demo apps in public/apps/. */
export function getDemoSigner(): Promise<RpkSigner> {
  demoSigner ??= createWebCryptoSigner(demoPrivateKeyPem, demoCertificatePem);
  return demoSigner;
}

/**
 * Returns `template` (an rpk built by aiot-toolkit) with the file at `path` replaced by `data`,
 * signed with the public demo key unless another signer is given. With `versionCode`, the
 * manifests get that version code too.
 */
export async function buildCustomRpk(
  template: Uint8Array,
  path: string,
  data: Uint8Array,
  signer?: RpkSigner,
  options?: CustomRpkOptions,
): Promise<Uint8Array> {
  return buildCustomRpkFiles(template, { [path]: data }, signer, options);
}

/** Like buildCustomRpk, for apps whose content is several files (Flashcards: an index + one file per deck). */
export async function buildCustomRpkFiles(
  template: Uint8Array,
  files: Record<string, Uint8Array>,
  signer?: RpkSigner,
  options?: CustomRpkOptions,
): Promise<Uint8Array> {
  const replace: Record<string, Uint8Array> = { ...files };
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

/** Monotonic version code for re-packed builds: minutes since 2026-01-01 (fits in uint32). */
export function customVersionCode(now = Date.now()): number {
  return Math.max(2, Math.floor((now - Date.UTC(2026, 0, 1)) / 60000));
}
