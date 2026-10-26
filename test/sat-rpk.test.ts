import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../src/core/files';
import { CERT_PATH, verifyRpk } from '../src/rpk/repack';
import { parseSignature } from '../src/rpk/sign';
import { readZip } from '../src/rpk/zip';

const root = resolve(__dirname, '..');
const td = new TextDecoder();

interface CatalogEntry {
  id: string;
  name: string;
  description: string | { en: string; zh: string; vi: string };
  file: string;
  icon: string;
  source: string;
}
const catalog = JSON.parse(readFileSync(resolve(root, 'public/apps/catalog.json'), 'utf8')) as { apps: CatalogEntry[] };

describe('SAT Flashcards demo app', () => {
  const entry = catalog.apps.find((a) => a.id === 'uk.trinh.miband.sat')!;
  // Built by aiot-toolkit 2.0.5 (`npm run publish-demo` in demo-apps/sat-flashcards) with src/rpk/demo-key.
  const rpk = new Uint8Array(readFileSync(resolve(root, 'public', entry.file)));

  it('has a catalog entry with files, source and a description in en/zh/vi', () => {
    expect(entry).toBeDefined();
    expect(existsSync(resolve(root, 'public', entry.icon))).toBe(true);
    expect(existsSync(resolve(root, entry.source, 'src/manifest.json'))).toBe(true);
    expect(typeof entry.description).toBe('object');
    const d = entry.description as Record<string, string>;
    for (const lang of ['en', 'zh', 'vi']) expect(d[lang]?.length).toBeGreaterThan(10);
  });

  it('the rpk is a valid, signed quick app matching the catalog', async () => {
    expect((await verifyRpk(rpk)).errors).toEqual([]);
    const parsed = parseFile(rpk);
    expect(parsed.kind).toBe('rpk');
    if (parsed.kind !== 'rpk') return;
    expect(parsed.id).toBe(entry.id);
    expect(parsed.name).toBe(entry.name);
    expect(parsed.version).toBe('1.1.0');
  });

  it('is signed with the public demo key and contains both pages', () => {
    const certPem = readFileSync(resolve(root, 'src/rpk/demo-key/certificate.pem'), 'utf8');
    const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    expect(Buffer.from(parseSignature(rpk)!.certificateDer).equals(der)).toBe(true);

    const names = readZip(rpk).entries.map((e) => e.name);
    expect(names).toContain(CERT_PATH);
    expect(names).toEqual(expect.arrayContaining(['pages/index/index.jsc', 'pages/stats/index.jsc', 'common/logo.png']));
    const manifest = JSON.parse(td.decode(readZip(rpk).entries.find((e) => e.name === 'manifest.json')!.data));
    expect(manifest.config.designWidth).toBe(192);
    expect(manifest.versionCode).toBe(2);
    expect(manifest.features.map((f: { name: string }) => f.name).sort()).toEqual(['system.router', 'system.storage']);
  });
});
