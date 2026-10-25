import { sha256 } from '@noble/hashes/sha2.js';
import { concat, zipLayout } from './zip';

/**
 * "RPK Sig Block 42": the signature format of Xiaomi Vela quick apps, ported from
 * aiot-toolkit 2.0.5 (`@aiot-toolkit/aiotpack/lib/compiler/javascript/vela/utils/signature/SignUtil.js`).
 * It is a variant of the Android APK Signature Scheme v2:
 *
 * 1. The unsigned zip is split into 3 sections: local headers + data [0, cdOffset),
 *    central directory, EOCD (EOCD hashed with the ORIGINAL, pre-insertion cdOffset).
 *    Each section digest = SHA-256(0xA5 || u32le(len) || bytes).
 *    Top digest = SHA-256(0x5A || u32le(3) || d_header || d_central || d_eocd).
 * 2. signedData = u32 digestsLen || [u32 40, u32 0x0103, u32 32, topDigest]
 *               || u32 certsLen || [u32 certLen, certDER] || u32 0.
 *    Signature = RSASSA-PKCS1-v1_5 / SHA-256 over signedData (id 0x0103).
 * 3. A second, per-file block (id 0x01000201): u32 0x0103 || for each file
 *    [i32 crc32(name), i16 32, SHA-256(content)], RSA-SHA256 signed as well.
 * 4. The block (both key/value pairs + size + magic "RPK Sig Block 42") is inserted right before
 *    the central directory and the EOCD's cdOffset is shifted by its length.
 *
 * All integers are little-endian. The signature block and RSA PKCS#1 v1.5 are deterministic, so
 * the same zip bytes + key give byte-identical output to the toolkit.
 */

export const SIG_MAGIC = 'RPK Sig Block 42';
export const SIG_ALGO_RSA_SHA256 = 0x0103;
export const KV_SIGNATURE = 0x01000101;
export const KV_FILE_DIGESTS = 0x01000201;

export interface RpkSigner {
  /** X.509 certificate, DER. Embedded in the signature block. */
  certificateDer: Uint8Array;
  /** SubjectPublicKeyInfo DER of the certificate's key. Embedded in the signature block. */
  publicKeyDer: Uint8Array;
  /** RSASSA-PKCS1-v1_5 with SHA-256 over `data`. */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export interface FileDigest {
  name: string;
  hash: Uint8Array;
}

// ---------- helpers ----------

class Writer {
  private parts: Uint8Array[] = [];
  u32(n: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    this.parts.push(b);
    return this;
  }
  u16(n: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n & 0xffff, true);
    this.parts.push(b);
    return this;
  }
  u8(n: number): this {
    this.parts.push(Uint8Array.of(n));
    return this;
  }
  bytes(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }
  done(): Uint8Array {
    return concat(this.parts);
  }
}

/** First PEM block (any label) to DER, like the toolkit's Base64.unarmor. */
export function pemToDer(pem: string): Uint8Array {
  const m = /-----BEGIN [^-]+-----([A-Za-z0-9+/=\s]+)-----END [^-]+-----/.exec(pem);
  if (!m) throw new Error('rpk: no PEM block found');
  const bin = atob(m[1].replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Reads one DER TLV at `off`; returns header length and content length. */
function tlv(der: Uint8Array, off: number): { tag: number; hdr: number; len: number } {
  const tag = der[off];
  let len = der[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[off + 2 + i];
    hdr += n;
  }
  if (off + hdr + len > der.length) throw new Error('rpk: truncated DER');
  return { tag, hdr, len };
}

/** Extracts SubjectPublicKeyInfo (DER) from an X.509 certificate (DER). */
export function spkiFromCertificate(cert: Uint8Array): Uint8Array {
  const c = tlv(cert, 0); // Certificate SEQUENCE
  const tbsOff = c.hdr;
  const tbs = tlv(cert, tbsOff); // tbsCertificate SEQUENCE
  let p = tbsOff + tbs.hdr;
  if (cert[p] === 0xa0) p += tlv(cert, p).hdr + tlv(cert, p).len; // [0] version
  for (let i = 0; i < 5; i++) {
    const t = tlv(cert, p); // serial, signature alg, issuer, validity, subject
    p += t.hdr + t.len;
  }
  const s = tlv(cert, p);
  if (s.tag !== 0x30) throw new Error('rpk: certificate has no SubjectPublicKeyInfo');
  return cert.slice(p, p + s.hdr + s.len);
}

/**
 * CRC-32 of a file name exactly like the toolkit's CRC32.digest: it first runs a hand-written
 * "UTF-8" encoder that turns \r\n into \n and encodes each UTF-16 code unit separately
 * (surrogate pairs become 2x3 bytes, i.e. CESU-8). Identical to standard UTF-8 CRC for BMP names.
 */
export function toolkitNameCrc(name: string): number {
  const s = name.replace(/\r\n/g, '\n');
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push((c >> 6) | 192, (c & 63) | 128);
    else bytes.push((c >> 12) | 224, ((c >> 6) & 63) | 128, (c & 63) | 128);
  }
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sectionDigest(b: Uint8Array): Uint8Array {
  return sha256(new Writer().u8(0xa5).u32(b.length).bytes(b).done());
}

/** Top-level digest of an UNSIGNED zip (the 3-section scheme above). */
export function zipDigest(unsignedZip: Uint8Array): Uint8Array {
  const { eocdOffset, cdOffset, firstLocalOffset } = zipLayout(unsignedZip);
  const header = unsignedZip.subarray(firstLocalOffset, cdOffset);
  const central = unsignedZip.subarray(cdOffset, eocdOffset);
  const footer = unsignedZip.subarray(eocdOffset);
  return sha256(
    new Writer().u8(0x5a).u32(3).bytes(sectionDigest(header)).bytes(sectionDigest(central)).bytes(sectionDigest(footer)).done(),
  );
}

export function buildSignedData(digest: Uint8Array, certificateDer: Uint8Array): Uint8Array {
  const digestBlock = new Writer().u32(digest.length + 8).u32(SIG_ALGO_RSA_SHA256).u32(digest.length).bytes(digest).done();
  const certBlock = new Writer().u32(certificateDer.length).bytes(certificateDer).done();
  return new Writer().u32(digestBlock.length).bytes(digestBlock).u32(certBlock.length).bytes(certBlock).u32(0).done();
}

export function buildFileDigestData(files: FileDigest[]): Uint8Array {
  const w = new Writer().u32(SIG_ALGO_RSA_SHA256);
  for (const f of files) w.u32(toolkitNameCrc(f.name)).u16(f.hash.length).bytes(f.hash);
  return w.done();
}

/** Builds the complete "RPK Sig Block 42" for an unsigned zip. */
export async function buildSignatureBlock(unsignedZip: Uint8Array, files: FileDigest[], signer: RpkSigner): Promise<Uint8Array> {
  // kv 0x01000101: signer block
  const signedData = buildSignedData(zipDigest(unsignedZip), signer.certificateDer);
  const sig = await signer.sign(signedData);
  const signatures = new Writer().u32(sig.length + 8).u32(SIG_ALGO_RSA_SHA256).u32(sig.length).bytes(sig).done();
  const pub = signer.publicKeyDer;
  const signerBody = new Writer().u32(signedData.length).bytes(signedData).u32(signatures.length).bytes(signatures).u32(pub.length).bytes(pub).done();
  const signerBlock = new Writer().u32(signerBody.length).bytes(signerBody).done();
  const kvSig = kv(KV_SIGNATURE, signerBlock);

  // kv 0x01000201: per-file digests
  const fileData = buildFileDigestData(files);
  const fileSig = await signer.sign(fileData);
  const fileBlock = new Writer()
    .u32(fileData.length)
    .bytes(fileData)
    .u32(fileSig.length + 8)
    .u32(SIG_ALGO_RSA_SHA256)
    .u32(fileSig.length)
    .bytes(fileSig)
    .done();
  const kvFiles = kv(KV_FILE_DIGESTS, fileBlock);

  const size = 24 + kvSig.length + kvFiles.length;
  return new Writer().u32(size).u32(0).bytes(kvSig).bytes(kvFiles).u32(size).u32(0).bytes(new TextEncoder().encode(SIG_MAGIC)).done();
}

function kv(id: number, block: Uint8Array): Uint8Array {
  // u64 pairLen (= 4 id + 4 valueLen + block), u32 id, u32 valueLen, value
  return new Writer().u32(block.length + 8).u32(0).u32(id).u32(block.length).bytes(block).done();
}

/** Signs an unsigned zip: inserts the signature block before the central directory. */
export async function signZip(unsignedZip: Uint8Array, files: FileDigest[], signer: RpkSigner): Promise<Uint8Array> {
  const { eocdOffset, cdOffset, firstLocalOffset } = zipLayout(unsignedZip);
  if (firstLocalOffset !== 0) throw new Error('rpk: zip with leading data is not supported');
  const block = await buildSignatureBlock(unsignedZip, files, signer);
  const out = concat([unsignedZip.subarray(0, cdOffset), block, unsignedZip.subarray(cdOffset)]);
  new DataView(out.buffer).setUint32(eocdOffset + block.length + 16, cdOffset + block.length, true);
  return out;
}

export function fileDigest(name: string, content: Uint8Array): FileDigest {
  return { name, hash: sha256(content) };
}

// ---------- parsing / verification ----------

export interface ParsedSignature {
  /** The zip without the signature block, EOCD restored: exactly what was signed. */
  unsignedZip: Uint8Array;
  block: Uint8Array;
  signedData: Uint8Array;
  signature: Uint8Array;
  signedDigest: Uint8Array;
  certificateDer: Uint8Array;
  publicKeyDer: Uint8Array;
  fileData?: Uint8Array;
  fileSignature?: Uint8Array;
  /** Per-file entries from the file-digest block: crc32(name) (uint32) and SHA-256. */
  files: { nameCrc: number; hash: Uint8Array }[];
}

class Reader {
  constructor(
    private b: Uint8Array,
    public p = 0,
  ) {}
  private v = () => new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
  u32(): number {
    if (this.p + 4 > this.b.length) throw new Error('rpk: truncated signature block');
    const n = this.v().getUint32(this.p, true);
    this.p += 4;
    return n;
  }
  u16(): number {
    if (this.p + 2 > this.b.length) throw new Error('rpk: truncated signature block');
    const n = this.v().getUint16(this.p, true);
    this.p += 2;
    return n;
  }
  bytes(n: number): Uint8Array {
    if (this.p + n > this.b.length) throw new Error('rpk: truncated signature block');
    const r = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return r;
  }
}

/** Parses the signature block of a signed rpk (or a signed META-INF/CERT). Returns null if unsigned. */
export function parseSignature(signed: Uint8Array): ParsedSignature | null {
  const { eocdOffset, cdOffset } = zipLayout(signed);
  const magic = new TextEncoder().encode(SIG_MAGIC);
  const magicOff = cdOffset - 16;
  if (magicOff < 8) return null;
  for (let i = 0; i < 16; i++) if (signed[magicOff + i] !== magic[i]) return null;
  const v = new DataView(signed.buffer, signed.byteOffset, signed.byteLength);
  const size = v.getUint32(magicOff - 8, true);
  const blockLen = size + 8;
  const start = cdOffset - blockLen;
  if (start < 0 || v.getUint32(start, true) !== size) throw new Error('rpk: inconsistent signature block size');
  const block = signed.subarray(start, cdOffset);

  const unsignedZip = concat([signed.subarray(0, start), signed.subarray(cdOffset)]);
  new DataView(unsignedZip.buffer).setUint32(eocdOffset - blockLen + 16, start, true);

  const r = new Reader(block, 8);
  const end = blockLen - 24;
  let result: Partial<ParsedSignature> = { unsignedZip, block, files: [] };
  while (r.p < end) {
    const pairLen = r.u32();
    r.u32(); // high 32 bits of u64
    const pairEnd = r.p + pairLen;
    const id = r.u32();
    const valueLen = r.u32();
    const value = new Reader(r.bytes(valueLen));
    if (id === KV_SIGNATURE) {
      value.u32(); // signer block length
      const signedData = value.bytes(value.u32());
      const sigs = new Reader(value.bytes(value.u32()));
      sigs.u32();
      const algo = sigs.u32();
      if (algo !== SIG_ALGO_RSA_SHA256) throw new Error(`rpk: unsupported signature algorithm 0x${algo.toString(16)}`);
      const signature = sigs.bytes(sigs.u32());
      const publicKeyDer = value.bytes(value.u32());
      const sd = new Reader(signedData);
      const digests = new Reader(sd.bytes(sd.u32()));
      digests.u32();
      if (digests.u32() !== SIG_ALGO_RSA_SHA256) throw new Error('rpk: unsupported digest algorithm');
      const signedDigest = digests.bytes(digests.u32());
      const certs = new Reader(sd.bytes(sd.u32()));
      const certificateDer = certs.bytes(certs.u32());
      result = { ...result, signedData, signature, signedDigest, certificateDer, publicKeyDer };
    } else if (id === KV_FILE_DIGESTS) {
      const fileData = value.bytes(value.u32());
      value.u32();
      if (value.u32() !== SIG_ALGO_RSA_SHA256) throw new Error('rpk: unsupported file signature algorithm');
      const fileSignature = value.bytes(value.u32());
      const fd = new Reader(fileData);
      fd.u32();
      const files: { nameCrc: number; hash: Uint8Array }[] = [];
      while (fd.p < fileData.length) {
        const nameCrc = fd.u32();
        files.push({ nameCrc, hash: fd.bytes(fd.u16()) });
      }
      result = { ...result, fileData, fileSignature, files };
    }
    r.p = pairEnd;
  }
  if (!result.signedData) throw new Error('rpk: signature block has no signer');
  return result as ParsedSignature;
}

export async function rsaVerify(spki: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('spki', spki as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature as BufferSource, data as BufferSource);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- WebCrypto signer ----------

/**
 * Creates a signer from a PKCS#8 private key PEM ("BEGIN PRIVATE KEY") and an X.509
 * certificate PEM. Works in browsers and in Node (globalThis.crypto.subtle).
 */
export async function createWebCryptoSigner(privateKeyPem: string, certificatePem: string): Promise<RpkSigner> {
  if (/BEGIN RSA PRIVATE KEY/.test(privateKeyPem)) {
    throw new Error('rpk: PKCS#1 key; convert with `openssl pkcs8 -topk8 -nocrypt` to PKCS#8');
  }
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const certificateDer = pemToDer(certificatePem);
  return {
    certificateDer,
    publicKeyDer: spkiFromCertificate(certificateDer),
    async sign(data) {
      return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data as BufferSource));
    },
  };
}
