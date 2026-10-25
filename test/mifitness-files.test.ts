import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keysFromFiles, keysFromManifest, keysFromZip, parseBplist, SqliteReader } from '../src/core/mifitness-files';

// Synthetic fixtures from test/fixtures/make-mifitness-fixture.py (no real account data).
const zip = new Uint8Array(readFileSync(new URL('./fixtures/mifitness-folder.zip', import.meta.url)));
const plain = new Uint8Array(readFileSync(new URL('./fixtures/mifitness-manifest.sqlite', import.meta.url)));

const BAND9 = { name: 'Xiaomi Smart Band 9', model: 'miwear.watch.n67cn', mac: 'AA:BB:CC:DD:EE:01', did: '1001', key: '00112233445566778899aabbccddeeff', entry: 'registerList_sg' };
const BAND8 = { name: 'Xiaomi Smart Band 8', model: 'hlth.band.m8', mac: 'AA:BB:CC:DD:EE:02', did: '1002', key: 'ffeeddccbbaa99887766554433221100', entry: 'registerList_de' };

describe('Mi Fitness folder (iPhone / iPad Files app)', () => {
  it('reads every table row, incl. overflow pages and interior pages', () => {
    const rows = new SqliteReader(plain).table('manifest');
    expect(rows.length).toBe(63);
    const sg = rows.find((r) => r.key === 'registerList_sg')!;
    expect((sg.inline_data as Uint8Array).length).toBe(3652);
    expect(new TextDecoder().decode((sg.inline_data as Uint8Array).subarray(0, 8))).toBe('bplist00');
  });

  it('finds the keys in a zip of the folder (WAL applied, data/ file, __MACOSX ignored)', () => {
    expect(keysFromZip(zip)).toEqual([BAND9, BAND8]);
  });

  it('finds the inline key in a lone manifest.sqlite', () => {
    expect(keysFromManifest(plain)).toEqual([BAND9]);
    expect(keysFromFiles({ 'manifest.sqlite': plain })).toEqual([BAND9]);
  });

  it('finds the key in manifest.sqlite-wal alone (Mi Fitness keeps the whole database in the WAL)', () => {
    // A WAL holding every page of the plain fixture, the last frame marked as a commit.
    const ps = new SqliteReader(plain).pageSize;
    const n = plain.length / ps;
    const wal = new Uint8Array(32 + n * (24 + ps));
    const v = new DataView(wal.buffer);
    v.setUint32(0, 0x377f0682);
    v.setUint32(4, 3007000);
    v.setUint32(8, ps);
    v.setUint32(16, 0x1234);
    v.setUint32(20, 0x5678);
    for (let i = 0; i < n; i++) {
      const at = 32 + i * (24 + ps);
      v.setUint32(at, i + 1);
      v.setUint32(at + 4, i === n - 1 ? n : 0);
      v.setUint32(at + 8, 0x1234);
      v.setUint32(at + 12, 0x5678);
      wal.set(plain.subarray(i * ps, (i + 1) * ps), at + 24);
    }
    expect(keysFromFiles({ 'manifest.sqlite-wal': wal })).toEqual([BAND9]);
    // With its (empty here) manifest.sqlite picked too, the pair is read as usual.
    expect(keysFromFiles({ 'manifest.sqlite': plain.subarray(0, ps), 'manifest.sqlite-wal': wal })).toEqual([BAND9]);
  });

  it('rejects files that are not what we expect', () => {
    expect(() => new SqliteReader(new Uint8Array(200))).toThrow(/not an SQLite/);
    expect(() => parseBplist(new TextEncoder().encode('<?xml version="1.0"?>'))).toThrow(/binary plist/);
    expect(keysFromFiles({ 'x/other.sqlite': plain })).toEqual([]);
  });
});
