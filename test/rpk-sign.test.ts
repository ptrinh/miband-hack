import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../src/core/files';
import { buildNotesRpk, getDemoSigner, NOTES_PATH } from '../src/rpk/notes';
import { CERT_PATH, repackRpk, verifyRpk } from '../src/rpk/repack';
import { fileDigest, parseSignature, signZip, type FileDigest } from '../src/rpk/sign';
import { readZip } from '../src/rpk/zip';

const root = resolve(__dirname, '..');
// Built by aiot-toolkit 2.0.5 (`npm run release` in demo-apps/notes) with src/rpk/demo-key.
const template = new Uint8Array(readFileSync(resolve(root, 'public/apps/notes.rpk')));
const keyPem = readFileSync(resolve(root, 'src/rpk/demo-key/private.pem'), 'utf8');
const certPem = readFileSync(resolve(root, 'src/rpk/demo-key/certificate.pem'), 'utf8');
const FIXED_DATE = new Date('2026-10-25T07:27:11Z');
const td = new TextDecoder();

/** The file list the toolkit signs: META-INF/CERT first, then every other non-directory entry. */
function outerFileList(rpk: Uint8Array): FileDigest[] {
  const files = readZip(rpk).entries.filter((e) => !e.name.endsWith('/'));
  const cert = files.find((e) => e.name === CERT_PATH)!;
  return [fileDigest(CERT_PATH, cert.data), ...files.filter((e) => e !== cert).map((e) => fileDigest(e.name, e.data))];
}

function certOf(rpk: Uint8Array): Uint8Array {
  return readZip(rpk).entries.find((e) => e.name === CERT_PATH)!.data;
}

function notesOf(rpk: Uint8Array): unknown {
  return JSON.parse(td.decode(readZip(rpk).entries.find((e) => e.name === NOTES_PATH)!.data));
}

describe('rpk signature (RPK Sig Block 42)', () => {
  it('the toolkit-built notes.rpk passes our verifier', async () => {
    const v = await verifyRpk(template);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('re-signing the toolkit unsigned zip reproduces the toolkit output byte-for-byte', async () => {
    const signer = await getDemoSigner();
    // outer package
    const outer = parseSignature(template)!;
    expect(outer).not.toBeNull();
    const resigned = await signZip(outer.unsignedZip, outerFileList(template), signer);
    expect(Buffer.from(resigned).equals(Buffer.from(template))).toBe(true);
    // META-INF/CERT (itself a signed zip)
    const cert = certOf(template);
    const inner = parseSignature(cert)!;
    const resignedCert = await signZip(inner.unsignedZip, [fileDigest('hash.json', inner.unsignedZip)], signer);
    expect(Buffer.from(resignedCert).equals(Buffer.from(cert))).toBe(true);
  });

  it('repacking with unchanged content gives a structurally identical, valid rpk', async () => {
    const signer = await getDemoSigner();
    const out = await repackRpk(template, {}, signer, { date: FIXED_DATE });
    expect((await verifyRpk(out)).errors).toEqual([]);

    const a = readZip(template);
    const b = readZip(out);
    expect(b.entries.map((e) => e.name)).toEqual(a.entries.map((e) => e.name));
    expect(td.decode(b.comment)).toBe(td.decode(a.comment));
    for (const e of a.entries) {
      if (e.name === CERT_PATH) continue;
      expect(Buffer.from(b.entries.find((x) => x.name === e.name)!.data).equals(Buffer.from(e.data))).toBe(true);
    }
    // hash.json inside CERT is identical, CERT zip comment preserved
    const hashA = readZip(certOf(template));
    const hashB = readZip(certOf(out));
    expect(td.decode(hashB.entries[0].data)).toBe(td.decode(hashA.entries[0].data));
    expect(td.decode(hashB.comment)).toBe(td.decode(hashA.comment));
    // same signing certificate and same signature block layout
    const sa = parseSignature(template)!;
    const sb = parseSignature(out)!;
    expect(Buffer.from(sb.certificateDer).equals(Buffer.from(sa.certificateDer))).toBe(true);
    expect(Buffer.from(sb.publicKeyDer).equals(Buffer.from(sa.publicKeyDer))).toBe(true);
    expect(sb.block.length).toBe(sa.block.length);
    expect(sb.files.map((f) => f.nameCrc)).toEqual(sa.files.map((f) => f.nameCrc));
  });

  it('replacing common/notes.json gives a valid rpk that round-trips (UTF-8)', async () => {
    const notes = [
      { title: 'Đi chợ', body: 'Mua rau, thịt, cá\nNấu canh chua' },
      { title: '购物清单', body: '牛奶、鸡蛋、面包' },
      { title: 'Emoji 📝', body: 'line 1\n\nline 3' },
    ];
    const out = await buildNotesRpk(template, notes, undefined, { date: FIXED_DATE });
    const v = await verifyRpk(out);
    expect(v.errors).toEqual([]);

    const parsed = parseFile(out);
    expect(parsed.kind).toBe('rpk');
    if (parsed.kind !== 'rpk') return;
    expect(parsed.id).toBe('uk.trinh.miband.notes');
    expect(parsed.name).toBe('Notes');
    expect(parsed.version).toBe('1.0.0');
    expect(notesOf(out)).toEqual({ notes });

    const hashJson = JSON.parse(td.decode(readZip(certOf(out)).entries[0].data));
    expect(Object.keys(hashJson.digests)).toContain(NOTES_PATH);
  });

  it('bumps versionCode in both manifests and still verifies', async () => {
    const out = await buildNotesRpk(template, [{ title: 'a', body: 'b' }], undefined, { versionCode: 424242 });
    expect((await verifyRpk(out)).errors).toEqual([]);
    const parsed = parseFile(out);
    expect(parsed.kind === 'rpk' && parsed.versionCode).toBe(424242);
    const watch = JSON.parse(td.decode(readZip(out).entries.find((e) => e.name === 'manifest-watch.json')!.data));
    if ('versionCode' in watch) expect(watch.versionCode).toBe(424242);
  });

  it('empty notes list is allowed', async () => {
    const out = await buildNotesRpk(template, []);
    expect((await verifyRpk(out)).ok).toBe(true);
    expect(notesOf(out)).toEqual({ notes: [] });
  });

  it('detects tampering', async () => {
    const out = await buildNotesRpk(template, [{ title: 'a', body: 'b' }]);
    const bad = out.slice();
    bad[100] ^= 0xff; // inside the first local file data
    expect((await verifyRpk(bad)).ok).toBe(false);
  });

  it('refuses to replace META-INF files', async () => {
    await expect(repackRpk(template, { 'META-INF/CERT': new Uint8Array(1) }, await getDemoSigner())).rejects.toThrow();
  });

  // Cross-check against the toolkit's own signer when demo-apps node_modules are installed.
  const toolkitSignUtil = ['notes', 'calculator']
    .map((d) => resolve(root, `demo-apps/${d}/node_modules/@aiot-toolkit/aiotpack/lib/compiler/javascript/vela/utils/signature/SignUtil.js`))
    .find((p) => existsSync(p));
  it.skipIf(!toolkitSignUtil)('our repacked zip, signed by aiot-toolkit SignUtil.doSign, equals our signature', async () => {
    const SignUtil = createRequire(import.meta.url)(toolkitSignUtil!).default;
    const out = await buildNotesRpk(template, [{ title: 'x', body: 'y' }]);
    const unsigned = parseSignature(out)!.unsignedZip;
    const files = outerFileList(out).map((f) => ({ name: f.name, hash: Buffer.from(f.hash) }));
    const toolkitSigned: Buffer = SignUtil.doSign(Buffer.from(unsigned), files, Buffer.from(keyPem), Buffer.from(certPem));
    expect(Buffer.from(out).equals(toolkitSigned)).toBe(true);
  });
});
