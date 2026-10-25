import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../src/core/files';
import {
  buildChecklistRpk,
  CHECKLIST_PATH,
  cleanChecklists,
  type Checklist,
  MAX_ITEM_LENGTH,
  MAX_ITEMS,
  MAX_LISTS,
  moveItem,
  newId,
  normalizeChecklists,
  serializeChecklists,
} from '../src/rpk/checklist';
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
const entry = catalog.apps.find((a) => a.id === 'uk.trinh.miband.checklist')!;
// Built by aiot-toolkit 2.0.5 (`npm run publish-demo` in demo-apps/checklist) with src/rpk/demo-key.
const template = new Uint8Array(readFileSync(resolve(root, 'public', entry.file)));

const fileOf = (rpk: Uint8Array, name: string) => readZip(rpk).entries.find((e) => e.name === name)!.data;
const counter = () => {
  let n = 0;
  return () => `g${++n}`;
};

/** The band's own model (demo-apps/checklist/src/common/model.js, plain JS without platform APIs). */
async function bandModel() {
  return import(pathToFileURL(resolve(root, 'demo-apps/checklist/src/common/model.js')).href);
}

describe('Checklist lists (webapp side)', () => {
  it('normalizes imports: ids fixed, strings as items, limits applied', () => {
    const lists = normalizeChecklists(
      {
        lists: [
          { id: 'a', title: 'Shop', items: ['Milk', { id: 'x1', text: 'Eggs' }, { id: 'x1', text: 'dup id' }, { id: 'BAD ID', text: 'bad id' }, { text: 'x'.repeat(500) }] },
          { title: 't'.repeat(100) },
        ],
      },
      counter(),
    )!;
    expect(lists[0]).toEqual({
      id: 'a',
      title: 'Shop',
      items: [
        { id: 'g1', text: 'Milk' },
        { id: 'x1', text: 'Eggs' },
        { id: 'g2', text: 'dup id' },
        { id: 'g3', text: 'bad id' },
        { id: 'g4', text: 'x'.repeat(MAX_ITEM_LENGTH) },
      ],
    });
    expect(lists[1]).toEqual({ id: 'g5', title: 't'.repeat(40), items: [] });
    // bare arrays and our export format
    expect(normalizeChecklists([{ id: 'b', title: 'B', items: [] }])).toEqual([{ id: 'b', title: 'B', items: [] }]);
    expect(normalizeChecklists({ app: 'miband-hack-checklist', version: 1, lists: [] })).toEqual([]);
    // too many lists / items are cut
    const many = normalizeChecklists({ lists: Array.from({ length: 50 }, () => ({ title: 'L', items: Array.from({ length: 150 }, () => 'i') })) })!;
    expect(many.length).toBe(MAX_LISTS);
    expect(many[0].items.length).toBe(MAX_ITEMS);
    // not a checklist file
    for (const bad of [null, 1, 'x', {}, { notes: [] }, { lists: [1] }, { lists: [{ items: 'no' }] }, { lists: [{ items: [3] }] }]) {
      expect(normalizeChecklists(bad)).toBeNull();
    }
  });

  it('cleans for the band and validates what it serializes', () => {
    const lists: Checklist[] = [
      { id: 'a', title: ' Shop ', items: [{ id: 'i1', text: ' Milk ' }, { id: 'i2', text: '   ' }] },
      { id: 'b', title: '', items: [{ id: 'i3', text: '' }] },
      { id: 'c', title: '', items: [{ id: 'i4', text: 'only item' }] },
    ];
    expect(cleanChecklists(lists)).toEqual([
      { id: 'a', title: 'Shop', items: [{ id: 'i1', text: 'Milk' }] },
      { id: 'c', title: '', items: [{ id: 'i4', text: 'only item' }] },
    ]);
    expect(JSON.parse(td.decode(serializeChecklists(cleanChecklists(lists))))).toEqual({ lists: cleanChecklists(lists) });
    expect(() => serializeChecklists([{ id: 'a', title: 'x', items: [{ id: 'a', text: 'same id as the list' }] }])).toThrow(/unique/);
    expect(() => serializeChecklists([{ id: 'A', title: 'x', items: [] }])).toThrow(/id/);
    expect(() => serializeChecklists([{ id: 'a', title: 'x', items: [{ id: 'b', text: 'y'.repeat(MAX_ITEM_LENGTH + 1) }] }])).toThrow(/longer/);
  });

  it('newId gives valid, distinct ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, newId));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it('moveItem swaps neighbours and refuses to leave the array', () => {
    const a = [1, 2, 3];
    expect(moveItem(a, 0, 1)).toBe(true);
    expect(a).toEqual([2, 1, 3]);
    expect(moveItem(a, 2, -1)).toBe(true);
    expect(a).toEqual([2, 3, 1]);
    expect(moveItem(a, 0, -1)).toBe(false);
    expect(moveItem(a, 2, 1)).toBe(false);
    expect(a).toEqual([2, 3, 1]);
  });

  it('what the webapp writes is what the band reads, and an edit keeps the ticks of surviving items', async () => {
    const M = await bandModel();
    const v1: Checklist[] = [{ id: 'shop', title: 'Đi chợ', items: [{ id: 'm', text: 'Sữa' }, { id: 'e', text: '鸡蛋' }, { id: 'b', text: 'Bread 🍞' }] }];
    const lists = M.normalize(JSON.parse(td.decode(serializeChecklists(cleanChecklists(v1)))));
    expect(lists).toEqual(cleanChecklists(v1));
    const ticks = M.parseTicks('');
    M.toggle(ticks, 'shop', 'm');
    M.toggle(ticks, 'shop', 'b');
    const stored = M.serializeTicks(ticks);
    // edited in the webapp: Bread removed, Eggs moved up and reworded, Coffee added
    const v2: Checklist[] = [{ id: 'shop', title: 'Đi chợ', items: [{ id: 'e', text: 'Trứng' }, { id: 'm', text: 'Sữa' }, { id: newId(), text: 'Coffee' }] }];
    const lists2 = M.normalize(JSON.parse(td.decode(serializeChecklists(v2))));
    const kept = M.pruneTicks(M.parseTicks(stored), lists2);
    expect(M.rows(lists2[0], kept).map((r: { text: string; done: boolean }) => `${r.text}:${r.done}`)).toEqual(['Trứng:false', 'Sữa:true', 'Coffee:false']);
  });
});

describe('Checklist demo app', () => {
  it('has a customizable catalog entry with files, source and a description in en/zh/vi', () => {
    expect(entry).toBeDefined();
    expect(entry.customize).toBe('checklist');
    expect(existsSync(resolve(root, 'public', entry.icon))).toBe(true);
    expect(existsSync(resolve(root, entry.source, 'src/manifest.json'))).toBe(true);
    for (const lang of ['en', 'zh', 'vi']) expect(entry.description[lang]?.length).toBeGreaterThan(10);
  });

  it('the rpk is a valid quick app signed with the public demo key, lists.json kept as a file', async () => {
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
    expect(names).toEqual(expect.arrayContaining(['pages/index/index.js', 'pages/list/index.js', 'common/logo.png', CHECKLIST_PATH]));
    const manifest = JSON.parse(td.decode(fileOf(template, 'manifest.json')));
    expect(manifest.config.designWidth).toBe(192);
    expect(manifest.features.map((f: { name: string }) => f.name).sort()).toEqual(['system.file', 'system.router', 'system.storage']);
    // the bundled sample is the one in the app source
    const src = JSON.parse(readFileSync(resolve(root, entry.source, 'src/common/lists.json'), 'utf8'));
    expect(JSON.parse(td.decode(fileOf(template, CHECKLIST_PATH)))).toEqual(src);
  });

  it('re-packs with the user lists and a newer versionCode', async () => {
    const lists: Checklist[] = [
      { id: 'p1', title: 'Packing 🧳', items: [{ id: 'a1', text: 'Hộ chiếu' }, { id: 'a2', text: '充电器' }, { id: 'a3', text: ' ' }] },
      { id: 'p2', title: '', items: [] },
    ];
    const out = await buildChecklistRpk(template, lists, undefined, { versionCode: 515151 });
    expect((await verifyRpk(out)).errors).toEqual([]);
    const parsed = parseFile(out);
    expect(parsed.kind === 'rpk' && parsed.versionCode).toBe(515151);
    expect(JSON.parse(td.decode(fileOf(out, CHECKLIST_PATH)))).toEqual({
      lists: [{ id: 'p1', title: 'Packing 🧳', items: [{ id: 'a1', text: 'Hộ chiếu' }, { id: 'a2', text: '充电器' }] }],
    });
    // empty is allowed (the band shows "No lists")
    const empty = await buildChecklistRpk(template, []);
    expect((await verifyRpk(empty)).ok).toBe(true);
  });
});
