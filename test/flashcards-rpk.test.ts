import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../src/core/files';
import { bandFiles, type Deck, deckPath, FLASHCARDS_PACKAGE_ID, INDEX_PATH, parseDelimited } from '../src/decks/model';
import { setLang, t } from '../src/i18n';
import { buildFlashcardsRpk } from '../src/rpk/flashcards';
import { CERT_PATH, verifyRpk } from '../src/rpk/repack';
import { parseSignature } from '../src/rpk/sign';
import { readZip } from '../src/rpk/zip';

const root = resolve(__dirname, '..');
const td = new TextDecoder();

interface CatalogEntry {
  id: string;
  name: string;
  description: Record<string, string>;
  file: string;
  icon: string;
  source: string;
  customize?: string;
}
const catalog = JSON.parse(readFileSync(resolve(root, 'public/apps/catalog.json'), 'utf8')) as { apps: CatalogEntry[] };
const entry = catalog.apps.find((a) => a.id === FLASHCARDS_PACKAGE_ID)!;
// Built by aiot-toolkit 2.0.5 (`npm run publish-demo` in demo-apps/flashcards) with src/rpk/demo-key.
const template = new Uint8Array(readFileSync(resolve(root, 'public', entry.file)));
const FIXED_DATE = new Date(2026, 9, 25, 12, 0, 0);

const fileOf = (rpk: Uint8Array, name: string) => readZip(rpk).entries.find((e) => e.name === name)?.data;
const jsonOf = (rpk: Uint8Array, name: string) => JSON.parse(td.decode(fileOf(rpk, name)!));

function sample(): Deck {
  setLang('en');
  return { id: 'capitals', name: t('decksSampleName'), cards: parseDelimited(t('decksSampleCards')).cards };
}

describe('Flashcards demo app', () => {
  it('has a customizable catalog entry with files, source and a description in en/zh/vi', () => {
    expect(entry).toBeDefined();
    expect(entry.customize).toBe('flashcards');
    expect(existsSync(resolve(root, 'public', entry.icon))).toBe(true);
    expect(existsSync(resolve(root, entry.source, 'src/manifest.json'))).toBe(true);
    for (const lang of ['en', 'zh', 'vi']) expect(entry.description[lang]?.length).toBeGreaterThan(10);
  });

  it('the template rpk is valid, signed with the public demo key and has all pages', async () => {
    expect((await verifyRpk(template)).errors).toEqual([]);
    const parsed = parseFile(template);
    expect(parsed.kind).toBe('rpk');
    if (parsed.kind !== 'rpk') return;
    expect(parsed.id).toBe(entry.id);
    expect(parsed.name).toBe(entry.name);
    expect(parsed.version).toBe('1.0.0');

    const certPem = readFileSync(resolve(root, 'src/rpk/demo-key/certificate.pem'), 'utf8');
    const der = Buffer.from(certPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    expect(Buffer.from(parseSignature(template)!.certificateDer).equals(der)).toBe(true);
    const names = readZip(template).entries.map((e) => e.name);
    expect(names).toContain(CERT_PATH);
    expect(names).toEqual(expect.arrayContaining(['pages/index/index.js', 'pages/study/index.js', 'pages/stats/index.js', 'common/logo.png', INDEX_PATH, deckPath(0)]));
    const manifest = jsonOf(template, 'manifest.json');
    expect(manifest.config.designWidth).toBe(192);
    expect(manifest.features.map((f: { name: string }) => f.name).sort()).toEqual(['system.file', 'system.router', 'system.storage']);
  });

  it('the template holds exactly what the web app writes for the English sample deck', () => {
    const files = bandFiles([sample()]);
    for (const [name, data] of Object.entries(files)) {
      expect(td.decode(fileOf(template, name)), name).toBe(td.decode(data));
      expect(td.decode(data)).toBe(readFileSync(resolve(root, entry.source, 'src', name), 'utf8'));
    }
  });

  it('re-packs several decks (CJK, Vietnamese) into a valid rpk with a newer version code', async () => {
    const decks: Deck[] = [
      sample(),
      { id: 'hsk1', name: 'HSK 1', cards: [{ front: '你好', back: 'nǐ hǎo · hello' }, { front: '谢谢', back: 'xièxie · thank you', note: '谢谢你！' }] },
      { id: 'vi', name: 'Tiếng Việt', cards: [{ front: 'xin chào', back: 'hello' }, { front: 'cảm ơn', back: 'thank you' }] },
    ];
    const out = await buildFlashcardsRpk(template, decks, undefined, { versionCode: 424242, date: FIXED_DATE });
    expect((await verifyRpk(out)).errors).toEqual([]);
    expect(jsonOf(out, INDEX_PATH).decks.map((d: { id: string; n: number; file: string }) => [d.id, d.n, d.file])).toEqual([
      ['capitals', 8, '/common/deck0.json'],
      ['hsk1', 2, '/common/deck1.json'],
      ['vi', 2, '/common/deck2.json'],
    ]);
    expect(jsonOf(out, deckPath(1)).cards[1].split('\t').slice(1)).toEqual(['谢谢', 'xièxie · thank you', '谢谢你！']);
    expect(jsonOf(out, deckPath(2)).name).toBe('Tiếng Việt');
    expect(jsonOf(out, 'manifest.json').versionCode).toBe(424242);
    const parsed = parseFile(out);
    expect(parsed.kind === 'rpk' && parsed.id).toBe(FLASHCARDS_PACKAGE_ID);
  });

  it('an unchanged card keeps its id when the deck is edited, so its progress carries over', async () => {
    const a = sample();
    const b: Deck = { ...a, cards: [{ front: 'Germany', back: 'Berlin' }, ...a.cards.slice(1).reverse(), { ...a.cards[0], note: 'changed note' }] };
    const idsA = jsonOf(await buildFlashcardsRpk(template, [a]), deckPath(0)).cards.map((c: string) => c.split('\t')[0]);
    const idsB = jsonOf(await buildFlashcardsRpk(template, [b]), deckPath(0)).cards.map((c: string) => c.split('\t')[0]);
    expect(idsB.slice(1).sort()).toEqual(idsA.sort());
    expect(idsA).not.toContain(idsB[0]);
  });

  it('no decks is allowed (the band shows "No decks yet"); invalid decks are refused', async () => {
    const out = await buildFlashcardsRpk(template, []);
    expect(jsonOf(out, INDEX_PATH)).toEqual({ v: 1, decks: [] });
    await expect(buildFlashcardsRpk(template, [{ id: 'x', name: '', cards: [] }])).rejects.toThrow('decksErrNameEmpty');
  });
});
