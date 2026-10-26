import { concat, equals, fromHex } from './bytes';
import { aesCtr, ccmDecrypt, ccmEncrypt, hmacSha256, randomBytes } from './crypto';
import { type Command, encodeCompanionDevice } from './proto';
import { t } from '../i18n';

// Ported from Gadgetbridge XiaomiAuthService (AGPL-3.0).
export const AUTH_COMMAND_TYPE = 1;
export const CMD_SEND_USERID = 5;
export const CMD_NONCE = 26;
export const CMD_AUTH = 27;

/** Parses the 32-hex-char auth key (with or without 0x) into 16 bytes. */
export function parseAuthKey(key: string): Uint8Array {
  const bytes = fromHex(key);
  if (bytes.length !== 16) throw new Error(t('errAuthKeyLen'));
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

/** Account.ErrorCode, from Xiaomi's wear_account.proto (AstroBox-NG-Module-Pb). */
export const ACCOUNT_ERRORS: Record<number, string> = {
  0: 'NO_ERROR',
  1: 'HAVE_BOUND',
  2: 'INFO_MISSING',
  3: 'INVALID_PARAM',
  4: 'NO_BOUND',
  5: 'SERVER_ERROR',
  6: 'CANCEL',
  7: 'VERIFY_ERROR',
  8: 'STATE_NOT_MATCH',
  9: 'USER_CHANGED',
  10: 'CONNECTION_REACH_LIMIT',
  100: 'UNKNOWN',
};
export const ACCOUNT_NO_BOUND = 4;
/** Account subtype 0 (BIND_STATUS): asks the band whether it is bound; read-only. */
export const CMD_BIND_STATUS = 0;

export function accountErrorName(code: number): string {
  return `${ACCOUNT_ERRORS[code] ?? 'unknown'} (${code})`;
}

/** CompanionDevice.device_type */
export const COMPANION_ANDROID = 0;
export const COMPANION_IOS = 1;

/**
 * One way of sending auth step 1. A band paired from iOS answered the plain Gadgetbridge/AstroBox step 1
 * with Account.error_code NO_BOUND, so the handshake can try several shapes in one connection.
 */
export interface AuthAttempt {
  id: string;
  /** app_device_id to send (AppVerify field 2), or none. */
  deviceId?: string;
  /** AppVerify.check_dynamic_code = true. */
  checkDynamicCode?: boolean;
  /** Session config TLV 5 (device type) to (re)start the SPP V2 session with, if any. */
  sessionDeviceType?: number;
}

export const AUTH_VARIANTS = ['auto', 'nonce', 'id', 'uuid', 'code', 'l1-ios'] as const;
export type AuthVariant = (typeof AUTH_VARIANTS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The attempts to make, in order. `auto` tries them all (most likely first) and stops at the first one the band
 * answers with its nonce; the others pin one shape for a test run.
 */
export function planAuthAttempts(deviceId: string, variant: AuthVariant = 'auto', canRestartSession = true): AuthAttempt[] {
  const id = deviceId.trim();
  // phone_id from an iOS Mi Fitness looks like UUID_digits_chars; the UUID alone is the iOS identifierForVendor.
  const head = id.split('_')[0];
  const uuid = id.includes('_') && UUID_RE.test(head) ? head : '';
  const firstRound: AuthAttempt[] = [];
  const add = (a: AuthAttempt) => {
    if (!firstRound.some((x) => x.deviceId === a.deviceId && !!x.checkDynamicCode === !!a.checkDynamicCode)) firstRound.push(a);
  };
  // Nonce only first: a Mi Band 10 bound on iOS answers it, and NO_BOUND to any app_device_id (2026-10-26).
  add({ id: 'nonce' });
  if (id) add({ id: 'id', deviceId: id });
  if (uuid) {
    add({ id: 'uuid', deviceId: uuid });
    add({ id: 'uuid-upper', deviceId: uuid.toUpperCase() });
    add({ id: 'uuid-lower', deviceId: uuid.toLowerCase() });
  }
  add({ id: 'code', ...(id ? { deviceId: id } : {}), checkDynamicCode: true });

  const ios = (a: AuthAttempt): AuthAttempt => ({ ...a, id: `l1-ios+${a.id}`, sessionDeviceType: COMPANION_IOS });
  switch (variant) {
    case 'nonce':
      return [{ id: 'nonce' }];
    case 'id':
      return id ? [{ id: 'id', deviceId: id }] : [{ id: 'nonce' }];
    case 'uuid':
      return uuid ? [{ id: 'uuid', deviceId: uuid }] : [{ id: 'nonce' }];
    case 'code':
      return [firstRound[firstRound.length - 1]];
    case 'l1-ios':
      return canRestartSession ? [ios(id ? { id: 'id', deviceId: id } : { id: 'nonce' })] : [{ id: 'nonce' }];
    default:
      // Second round: the same shapes after restarting the session as an iOS phone would.
      return canRestartSession ? [...firstRound, ...firstRound.filter((a) => !a.checkDynamicCode).map(ios)] : firstRound;
  }
}

/** Describes an id without revealing it, e.g. "60 chars: UUID_10 digits_12 chars". */
export function describeIdShape(id: string): string {
  const parts = id.split('_').map((p) => (UUID_RE.test(p) ? 'UUID' : /^\d+$/.test(p) ? `${p.length} digits` : `${p.length} chars`));
  const c = UUID_RE.test(id) ? (id === id.toUpperCase() ? ', upper case' : id === id.toLowerCase() ? ', lower case' : '') : '';
  return `${id.length} chars: ${parts.join('_')}${c}`;
}

export class AuthSession {
  phoneNonce = randomBytes(16);
  encryptionInitialized = false;
  /** CompanionDevice.device_type sent in step 2. */
  companionType = COMPANION_ANDROID;
  private encKey = new Uint8Array(16);
  private decKey = new Uint8Array(16);
  private encNonce = new Uint8Array(4);
  private decNonce = new Uint8Array(4);

  /**
   * deviceId: the phone's identity as registered with the band by Mi Fitness (`phone_id`), sent as
   * AppVerify.app_device_id when an attempt asks for it (see planAuthAttempts).
   */
  constructor(
    private readonly secretKey: Uint8Array,
    private readonly checkDecryptionMac = true,
    readonly deviceId = '',
  ) {}

  /** Step 1. Each call uses a fresh phone nonce. */
  buildNonceCommand(attempt: AuthAttempt = this.deviceId ? { id: 'id', deviceId: this.deviceId } : { id: 'nonce' }): Command {
    this.phoneNonce = randomBytes(16);
    const appVerify: NonNullable<NonNullable<Command['auth']>['appVerify']> = { nonce: this.phoneNonce };
    if (attempt.deviceId) appVerify.deviceId = attempt.deviceId;
    if (attempt.checkDynamicCode) appVerify.checkDynamicCode = true;
    return { type: AUTH_COMMAND_TYPE, subtype: CMD_NONCE, auth: { appVerify } };
  }

  /** Handles the watch nonce; returns the step-2 command, or throws if the key is wrong. */
  handleWatchNonce(watchNonce: Uint8Array, watchHmac: Uint8Array): Command {
    const k = computeAuthStep3Hmac(this.secretKey, this.phoneNonce, watchNonce);
    this.decKey = k.slice(0, 16);
    this.encKey = k.slice(16, 32);
    this.decNonce = k.slice(32, 36);
    this.encNonce = k.slice(36, 40);

    const confirm = hmacSha256(this.decKey, concat(watchNonce, this.phoneNonce));
    if (!equals(confirm, watchHmac)) throw new Error(t('errWrongKey'));

    const deviceInfo = encodeCompanionDevice({
      unknown1: this.companionType,
      phoneApiLevel: this.companionType === COMPANION_IOS ? 18 : 34,
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
