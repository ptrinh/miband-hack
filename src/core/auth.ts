import { concat, equals, fromHex } from './bytes';
import { aesCtr, ccmDecrypt, ccmEncrypt, hmacSha256, randomBytes } from './crypto';
import { type Command, encodeCompanionDevice } from './proto';

// Ported from Gadgetbridge XiaomiAuthService (AGPL-3.0).
export const AUTH_COMMAND_TYPE = 1;
export const CMD_SEND_USERID = 5;
export const CMD_NONCE = 26;
export const CMD_AUTH = 27;

/** Parses the 32-hex-char auth key (with or without 0x) into 16 bytes. */
export function parseAuthKey(key: string): Uint8Array {
  const bytes = fromHex(key);
  if (bytes.length !== 16) throw new Error('Auth key phải có đúng 32 ký tự hex');
  return bytes;
}

export function computeAuthStep3Hmac(secretKey: Uint8Array, phoneNonce: Uint8Array, watchNonce: Uint8Array): Uint8Array {
  const hk = hmacSha256(concat(phoneNonce, watchNonce), secretKey);
  const label = new TextEncoder().encode('miwear-auth');
  const out = new Uint8Array(64);
  let prev: Uint8Array = new Uint8Array(0);
  for (let i = 0, b = 1; i < out.length; b++) {
    prev = hmacSha256(hk, concat(prev, label, new Uint8Array([b])));
    for (let j = 0; j < prev.length && i < out.length; j++, i++) out[i] = prev[j];
  }
  return out;
}

export class AuthSession {
  readonly phoneNonce = randomBytes(16);
  encryptionInitialized = false;
  private encKey = new Uint8Array(16);
  private decKey = new Uint8Array(16);
  private encNonce = new Uint8Array(4);
  private decNonce = new Uint8Array(4);

  constructor(private readonly secretKey: Uint8Array, private readonly checkDecryptionMac = true) {}

  buildNonceCommand(): Command {
    return { type: AUTH_COMMAND_TYPE, subtype: CMD_NONCE, auth: { appVerify: { nonce: this.phoneNonce } } };
  }

  /** Handles the watch nonce; returns the step-2 command, or throws if the key is wrong. */
  handleWatchNonce(watchNonce: Uint8Array, watchHmac: Uint8Array): Command {
    const k = computeAuthStep3Hmac(this.secretKey, this.phoneNonce, watchNonce);
    this.decKey = k.slice(0, 16);
    this.encKey = k.slice(16, 32);
    this.decNonce = k.slice(32, 36);
    this.encNonce = k.slice(36, 40);

    const confirm = hmacSha256(this.decKey, concat(watchNonce, this.phoneNonce));
    if (!equals(confirm, watchHmac)) throw new Error('Sai auth key (HMAC của band không khớp)');

    const deviceInfo = encodeCompanionDevice({
      unknown1: 0,
      phoneApiLevel: 34,
      phoneName: 'MiBandHack Web',
      unknown3: 224,
      region: (navigator.language || 'en').slice(0, 2).toUpperCase(),
    });

    return {
      type: AUTH_COMMAND_TYPE,
      subtype: CMD_AUTH,
      auth: {
        appConfirm: {
          encryptedNonces: hmacSha256(this.encKey, concat(this.phoneNonce, watchNonce)),
          encryptedDeviceInfo: this.encrypt(deviceInfo, 0),
        },
      },
    };
  }

  private packetNonce(base: Uint8Array, counter: number): Uint8Array {
    const n = new Uint8Array(12);
    n.set(base, 0);
    new DataView(n.buffer).setUint32(8, counter >>> 0, true);
    return n;
  }

  /** V1 (BLE V1 / SPP V1): AES-CCM, 4-byte tag. */
  encrypt(data: Uint8Array, counter: number): Uint8Array {
    return ccmEncrypt(this.encKey, this.packetNonce(this.encNonce, counter), data, 4);
  }

  decrypt(data: Uint8Array): Uint8Array {
    return ccmDecrypt(this.decKey, this.packetNonce(this.decNonce, 0), data, 4, this.checkDecryptionMac);
  }

  /** V2 (SPP V2 / BLE V2): AES-CTR with IV = key. */
  encryptV2(data: Uint8Array): Uint8Array {
    return aesCtr(this.encKey, this.encKey, data);
  }

  decryptV2(data: Uint8Array): Uint8Array {
    return aesCtr(this.decKey, this.decKey, data);
  }
}
