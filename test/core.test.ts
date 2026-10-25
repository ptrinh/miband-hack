import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { AuthSession, computeAuthStep3Hmac } from '../src/core/auth';
import { fromHex, hex } from '../src/core/bytes';
import { crc16arc, crc32 } from '../src/core/checksum';
import { aesCtr, ccmDecrypt, ccmEncrypt } from '../src/core/crypto';
import { parseFile } from '../src/core/files';
import { encodeV1, encodeV2Frame, parseV1, parseV2, v1VersionRequest, V2_ACK } from '../src/core/packets';
import { decodeCommand, encodeCommand } from '../src/core/proto';

const u8 = (b: Buffer | Uint8Array) => new Uint8Array(b);

/** Literal port of Gadgetbridge XiaomiSppPacketV2.calculatePayloadChecksum. */
function javaCrc16(payload: Uint8Array): number {
  let crc = 0;
  for (const raw of payload) {
    const b = (raw << 24) >> 24; // Java signed byte
    for (let j = 0; j < 8; j++) {
      crc = (crc << 1) | 0;
      if ((((crc >> 16) & 1) ^ ((b >> j) & 1)) === 1) crc ^= 0x8005;
    }
  }
  // Integer.reverse(crc) >>> 16
  let r = 0;
  for (let i = 0; i < 32; i++) r = (r << 1) | ((crc >>> i) & 1);
  return (r >>> 16) & 0xffff;
}

describe('checksums', () => {
  it('crc16arc matches the Gadgetbridge algorithm', () => {
    for (let n = 0; n < 50; n++) {
      const data = u8(randomBytes(n * 7));
      expect(crc16arc(data)).toBe(javaCrc16(data));
    }
    expect(crc16arc(new TextEncoder().encode('123456789'))).toBe(0xbb3d); // CRC-16/ARC check value
  });

  it('crc32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('crypto', () => {
  it('AES-CCM (tag 4, nonce 12) matches node:crypto', () => {
    for (const len of [0, 1, 15, 16, 17, 100, 1000]) {
      const key = u8(randomBytes(16));
      const nonce = u8(randomBytes(12));
      const plain = u8(randomBytes(len));
      const c = createCipheriv('aes-128-ccm', key, nonce, { authTagLength: 4 });
      c.setAAD(Buffer.alloc(0), { plaintextLength: len });
      const expected = u8(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]));
      const ours = ccmEncrypt(key, nonce, plain, 4);
      expect(hex(ours, 9999)).toBe(hex(expected, 9999));
      expect(hex(ccmDecrypt(key, nonce, ours, 4), 9999)).toBe(hex(plain, 9999));
    }
  });

  it('AES-CCM NIST SP 800-38C example 1 (with AAD)', () => {
    const ct = ccmEncrypt(fromHex('404142434445464748494a4b4c4d4e4f'), fromHex('10111213141516'), fromHex('20212223'), 4, fromHex('0001020304050607'));
    expect(hex(ct)).toBe('7162015b4dac255d');
  });

  it('AES-CCM rejects a tampered tag', () => {
    const key = u8(randomBytes(16));
    const nonce = u8(randomBytes(12));
    const ct = ccmEncrypt(key, nonce, new Uint8Array([1, 2, 3]), 4);
    ct[ct.length - 1] ^= 1;
    expect(() => ccmDecrypt(key, nonce, ct, 4)).toThrow();
    expect(ccmDecrypt(key, nonce, ct, 4, false)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('AES-CTR with IV = key matches node:crypto (counter crosses blocks)', () => {
    const key = u8(randomBytes(16));
    key[15] = 0xff; // force a carry when the counter increments
    const data = u8(randomBytes(100));
    const c = createCipheriv('aes-128-ctr', key, key);
    const expected = u8(Buffer.concat([c.update(data), c.final()]));
    expect(hex(aesCtr(key, key, data), 999)).toBe(hex(expected, 999));
  });

  it('auth key derivation matches an independent HMAC implementation', () => {
    const secret = u8(randomBytes(16));
    const pn = u8(randomBytes(16));
    const wn = u8(randomBytes(16));
    const hk = createHmac('sha256', Buffer.concat([pn, wn])).update(secret).digest();
    let t = Buffer.alloc(0);
    const out: Buffer[] = [];
    for (let i = 1; i <= 2; i++) {
      t = createHmac('sha256', hk).update(Buffer.concat([t, Buffer.from('miwear-auth'), Buffer.from([i])])).digest();
      out.push(t);
    }
    expect(hex(computeAuthStep3Hmac(secret, pn, wn), 999)).toBe(hex(u8(Buffer.concat(out)), 999));
  });
});

describe('protobuf', () => {
  it('encodes the nonce command byte-exactly', () => {
    const nonce = fromHex('00112233445566778899aabbccddeeff');
    const bytes = encodeCommand({ type: 1, subtype: 26, auth: { appVerify: { nonce } } });
    // type=1, subtype=26, auth(3){ appVerify(30){ nonce(1) } }
    expect(hex(bytes, 999)).toBe('0801101a1a15f201120a10' + '00112233445566778899aabbccddeeff');
  });

  it('round-trips an upload ack', () => {
    const cmd = decodeCommand(encodeCommand({ type: 22, subtype: 0, dataUpload: { dataUploadAck: { errno: 0, chunkSize: 4096, resumePosition: 0 } } }));
    expect(cmd.dataUpload?.dataUploadAck?.chunkSize).toBe(4096);
    expect(cmd.dataUpload?.dataUploadAck?.errno).toBe(0);
  });
});

describe('auth step 1', () => {
  it('reads the refusal a Mi Band 10 paired on an iPad sent when no deviceId was given', () => {
    // Real reply: type 1, subtype 26, Account { 3: 4 } and no DeviceVerify.
    const cmd = decodeCommand(fromHex('0801101a1a021804'));
    expect(cmd.type).toBe(1);
    expect(cmd.subtype).toBe(26);
    expect(cmd.auth?.deviceVerify).toBeUndefined();
    expect(cmd.auth?.refusal).toBe(4);
  });

  it('sends the deviceId (field 2 of AppVerify) only when one is set', () => {
    const id = 'ABCDEF01-2345-6789-ABCD-EF0123456789_1234567890_A1B2C3D4E5F6';
    const withId = decodeCommand(encodeCommand(new AuthSession(new Uint8Array(16), true, id).buildNonceCommand()));
    expect(withId.auth?.appVerify?.deviceId).toBe(id);
    const without = encodeCommand(new AuthSession(new Uint8Array(16)).buildNonceCommand());
    expect(decodeCommand(without).auth?.appVerify?.deviceId ?? '').toBe('');
    // Without one, AppVerify carries the nonce only: 2 bytes of tag + length, 16 bytes of nonce.
    expect(decodeCommand(without).auth?.appVerify?.nonce?.length).toBe(16);
    expect(without.length).toBe(encodeCommand({ type: 1, subtype: 26, auth: { appVerify: { nonce: new Uint8Array(16) } } }).length);
  });
});

describe('packets', () => {
  it('SPP V2 empty ack frame (Gadgetbridge test vector)', () => {
    expect(hex(encodeV2Frame(V2_ACK, 0xf2, new Uint8Array(0)))).toBe('a5a501f200000000');
    const p = parseV2(fromHex('a5a501f200000000'));
    expect(p.status).toBe('complete');
    expect(p.status === 'complete' && p.packet?.seq).toBe(0xf2);
  });

  it('SPP V2 detects bad checksum and incomplete frames', () => {
    expect(parseV2(fromHex('a5a5030106000000')).status).toBe('incomplete');
    const bad = parseV2(fromHex('a5a5030102000000' + '0102'));
    expect(bad.status === 'complete' && bad.packet).toBe(null);
  });

  it('SPP V1 version request and round trip', () => {
    expect(hex(v1VersionRequest())).toBe('badcfe00c00300000000ef');
    const enc = encodeV1({ channel: 'proto', flag: true, needsResponse: false, opCode: 2, frameSerial: 7, dataType: 1, payload: new Uint8Array([9, 8, 7]) });
    const p = parseV1(enc);
    expect(p.status === 'complete' && p.packet?.payload).toEqual(new Uint8Array([9, 8, 7]));
    expect(p.status === 'complete' && p.packet?.frameSerial).toBe(7);
  });
});

describe('file parsing', () => {
  it('parses an rpk manifest and icon', () => {
    const zip = zipSync({
      'manifest.json': new TextEncoder().encode(JSON.stringify({ package: 'com.example.hello', name: 'Hello', versionName: '1.2.0', versionCode: 3, icon: '/common/logo.png' })),
      'common/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    const f = parseFile(zip);
    expect(f.kind).toBe('rpk');
    if (f.kind !== 'rpk') return;
    expect(f.id).toBe('com.example.hello');
    expect(f.versionCode).toBe(3);
    expect(f.icon?.size).toBe(4);
  });

  it('parses a v2 watchface header', () => {
    const wf = new Uint8Array(0x200);
    wf[0] = 0x5a;
    wf[1] = 0xa5;
    wf.set(new TextEncoder().encode('12345678'), 0x28);
    wf.set(new TextEncoder().encode('My Face'), 0x68);
    const f = parseFile(wf);
    expect(f).toMatchObject({ kind: 'watchface', id: '12345678', name: 'My Face' });
  });

  it('rejects unknown files', () => {
    expect(parseFile(new Uint8Array([1, 2, 3, 4])).kind).toBe('unsupported');
  });
});

