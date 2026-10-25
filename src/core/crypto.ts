import { ctr, unsafe } from '@noble/ciphers/aes.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { md5 as md5Hash } from '@noble/hashes/legacy.js';
import { concat, equals } from './bytes';

export const hmacSha256 = (key: Uint8Array, data: Uint8Array): Uint8Array => hmac(sha256, key, data);
export const md5 = (data: Uint8Array): Uint8Array => md5Hash(data);

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

// noble's mode wrappers are single-use; CCM needs the raw block function many times per key.
function aesBlock(key: Uint8Array): (block: Uint8Array) => Uint8Array {
  const xk = unsafe.expandKeyLE(key);
  return (block) => unsafe.encryptBlock(xk, block.slice());
}

/**
 * AES-CCM (RFC 3610 / NIST SP 800-38C).
 * WebCrypto has no CCM, so it is built from the raw AES block function.
 */
function ccmCore(key: Uint8Array, nonce: Uint8Array, tagLen: number, aad: Uint8Array) {
  const L = 15 - nonce.length;
  if (L < 2 || L > 8) throw new Error('CCM: invalid nonce length');
  const enc = aesBlock(key);

  const ctrBlock = (i: number): Uint8Array => {
    const b = new Uint8Array(16);
    b[0] = L - 1;
    b.set(nonce, 1);
    for (let k = 0; k < L && k < 4; k++) b[15 - k] = (i >>> (8 * k)) & 0xff;
    return b;
  };

  const mac = (plain: Uint8Array): Uint8Array => {
    const b0 = new Uint8Array(16);
    b0[0] = (aad.length > 0 ? 0x40 : 0) | (((tagLen - 2) / 2) << 3) | (L - 1);
    b0.set(nonce, 1);
    let len = plain.length;
    for (let k = 0; k < L; k++) {
      b0[15 - k] = len & 0xff;
      len = Math.floor(len / 256);
    }
    let x = enc(b0);
    const absorb = (data: Uint8Array) => {
      for (let off = 0; off < data.length; off += 16) {
        const blk = new Uint8Array(16);
        blk.set(data.subarray(off, off + 16));
        for (let k = 0; k < 16; k++) blk[k] ^= x[k];
        x = enc(blk);
      }
    };
    if (aad.length > 0) {
      if (aad.length >= 0xff00) throw new Error('CCM: AAD too long');
      absorb(concat(new Uint8Array([aad.length >> 8, aad.length & 0xff]), aad));
    }
    absorb(plain);
    return x.subarray(0, tagLen);
  };

  const xorStream = (data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(data.length);
    for (let off = 0, i = 1; off < data.length; off += 16, i++) {
      const s = enc(ctrBlock(i));
      for (let k = 0; k < 16 && off + k < data.length; k++) out[off + k] = data[off + k] ^ s[k];
    }
    return out;
  };

  const s0 = enc(ctrBlock(0));
  return { mac, xorStream, s0 };
}

export function ccmEncrypt(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, tagLen = 4, aad: Uint8Array = new Uint8Array(0)): Uint8Array {
  const { mac, xorStream, s0 } = ccmCore(key, nonce, tagLen, aad);
  const t = mac(plain);
  const tag = t.map((v, k) => v ^ s0[k]);
  return concat(xorStream(plain), tag);
}

export function ccmDecrypt(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, tagLen = 4, checkTag = true, aad: Uint8Array = new Uint8Array(0)): Uint8Array {
  const { mac, xorStream, s0 } = ccmCore(key, nonce, tagLen, aad);
  const body = data.subarray(0, data.length - tagLen);
  const plain = xorStream(body);
  if (checkTag) {
    const expected = mac(plain).map((v, k) => v ^ s0[k]);
    if (!equals(expected, data.subarray(data.length - tagLen))) throw new Error('CCM: tag mismatch');
  }
  return plain;
}

/** AES-128-CTR with a full 128-bit big-endian counter (Java "AES/CTR/NoPadding"). */
export function aesCtr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  return ctr(key, iv).encrypt(data);
}
