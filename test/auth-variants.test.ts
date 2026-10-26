import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeIdShape, planAuthAttempts } from '../src/core/auth';
import { decodeCommand, encodeCommand } from '../src/core/proto';
import { AuthSession } from '../src/core/auth';
import { v2SessionConfigPayload } from '../src/core/packets';
import { XiaomiDevice } from '../src/device';
import { StreamLink } from '../src/protocol/stream-link';
import { FakeBand } from './fake-band';

// Shape of a Mi Fitness (iOS) detail.phone_id; made up.
const PHONE_ID = 'abcdef01-2345-6789-abcd-ef0123456789_1729000000_a1B2c3D4e5F6';
const UUID = PHONE_ID.split('_')[0];

function connectTo(band: FakeBand, deviceId: string, opts: ConstructorParameters<typeof XiaomiDevice>[3] = {}) {
  const dev = new XiaomiDevice(new StreamLink(band.transport, 'detect'), new Uint8Array(band.secret), deviceId, opts);
  const logs: string[] = [];
  dev.onLog = (m) => logs.push(m);
  return { dev, logs };
}

function band(bound?: { deviceId?: string; sessionDeviceType?: number }): FakeBand {
  const b = new FakeBand(randomBytes(16), { txWindow: 8, chunkSize: 1024, ackDelayMs: 1, bound });
  return b;
}

describe('auth step 1 variants', () => {
  it('plans nonce only first, then the full Device ID, the UUID part, the dynamic code, then the iOS session round', () => {
    const plan = planAuthAttempts(PHONE_ID, 'auto', true);
    expect(plan.map((a) => a.id)).toEqual([
      'nonce', 'id', 'uuid', 'uuid-upper', 'code',
      'l1-ios+nonce', 'l1-ios+id', 'l1-ios+uuid', 'l1-ios+uuid-upper',
    ]);
    expect(plan[2].deviceId).toBe(UUID);
    expect(plan[3].deviceId).toBe(UUID.toUpperCase());
    expect(plan[4]).toMatchObject({ deviceId: PHONE_ID, checkDynamicCode: true });
    expect(plan[6]).toMatchObject({ deviceId: PHONE_ID, sessionDeviceType: 1 });
    // No Device ID: nonce only, then with the dynamic code; no session restart where it is impossible.
    expect(planAuthAttempts('', 'auto', false).map((a) => a.id)).toEqual(['nonce', 'code']);
    expect(planAuthAttempts(PHONE_ID, 'nonce')).toEqual([{ id: 'nonce' }]);
    expect(planAuthAttempts(PHONE_ID, 'uuid')).toEqual([{ id: 'uuid', deviceId: UUID }]);
    expect(planAuthAttempts(PHONE_ID, 'l1-ios', true)).toEqual([{ id: 'l1-ios+id', deviceId: PHONE_ID, sessionDeviceType: 1 }]);
  });

  it('describes a Device ID without revealing it', () => {
    expect(describeIdShape(PHONE_ID)).toBe('60 chars: UUID_10 digits_12 chars');
    expect(describeIdShape(UUID.toUpperCase())).toBe('36 chars: UUID, upper case');
  });

  it('encodes check_dynamic_code as AppVerify field 3 and the session device type as TLV 5', () => {
    const cmd = new AuthSession(new Uint8Array(16)).buildNonceCommand({ id: 'code', checkDynamicCode: true });
    const bytes = encodeCommand(cmd);
    expect(decodeCommand(bytes).auth?.appVerify?.checkDynamicCode).toBe(true);
    // ...| 0a 10 <nonce16> 18 01 inside AppVerify
    expect(Buffer.from(bytes).subarray(-2).toString('hex')).toBe('1801');
    expect(Buffer.from(v2SessionConfigPayload(1, 1)).subarray(-4).toString('hex')).toBe('05010001');
    expect(v2SessionConfigPayload(1).length).toBe(22);
  });

  it('uses a fresh phone nonce for each attempt', () => {
    const s = new AuthSession(new Uint8Array(16));
    const a = Buffer.from(s.buildNonceCommand({ id: 'nonce' }).auth!.appVerify!.nonce);
    const b = Buffer.from(s.buildNonceCommand({ id: 'nonce' }).auth!.appVerify!.nonce);
    expect(a.equals(b)).toBe(false);
  });
});

describe('handshake against a band that answers NO_BOUND', () => {
  it('keeps the unchanged path for an ordinary band: one attempt, no Device ID', async () => {
    const b = band();
    const { dev, logs } = connectTo(b, '');
    await dev.connect();
    expect(b.authAttempts).toEqual([{}]);
    expect(dev.authVariantUsed).toBe('nonce');
    expect(b.companionInfo![0]).toBe(0x08);
    expect(b.companionInfo![1]).toBe(0); // Android
    expect(logs.join('\n')).toContain('app_device_id not sent');
  });

  it('finds the UUID part of the Device ID when the band wants that, after probing the bind status once', async () => {
    const b = band({ deviceId: UUID });
    const { dev, logs } = connectTo(b, PHONE_ID);
    await dev.connect();
    expect(dev.authVariantUsed).toBe('uuid');
    expect(b.authAttempts.map((a) => a.deviceId)).toEqual([undefined, PHONE_ID, UUID]);
    expect(b.bindStatusQueries).toBe(1);
    const text = logs.join('\n');
    expect(text).toContain('error_code NO_BOUND (4)');
    expect(text).toContain('bind_status=true');
    expect(text).toContain('app_device_id sent (36 chars: UUID');
    // The Device ID itself never reaches the log.
    expect(text).not.toContain(UUID);
    expect(text).not.toContain(PHONE_ID.slice(-12));
  });

  it('restarts the session with device type 1 when only that is accepted', async () => {
    const b = band({ deviceId: PHONE_ID, sessionDeviceType: 1 });
    const { dev, logs } = connectTo(b, PHONE_ID);
    await dev.connect();
    expect(dev.authVariantUsed).toBe('l1-ios+id');
    expect(b.sessionConfigs).toBe(2);
    expect(b.authAttempts.at(-1)).toEqual({ deviceId: PHONE_ID, sessionDeviceType: 1 });
    expect(logs.join('\n')).toContain('restarting the session with device type 1');
    // Authenticated traffic works after the restart.
    expect(dev.info.model).toBe('Xiaomi Smart Band 9');
  });

  it('tries every variant once, then fails with NO_BOUND', async () => {
    const b = band({ deviceId: 'something-else' });
    const { dev, logs } = connectTo(b, PHONE_ID);
    await expect(dev.connect()).rejects.toThrow(/NO_BOUND/);
    expect(b.authAttempts.length).toBe(planAuthAttempts(PHONE_ID, 'auto', true).length);
    expect(logs.filter((l) => l.startsWith('← refused')).length).toBe(b.authAttempts.length);
  });

  it('sends exactly the pinned variant', async () => {
    const b = band({ deviceId: UUID });
    const { dev } = connectTo(b, PHONE_ID, { authVariant: 'id' });
    await expect(dev.connect()).rejects.toThrow(/NO_BOUND/);
    expect(b.authAttempts).toEqual([{ deviceId: PHONE_ID }]);
  });

  it('claims an iOS companion in step 2 only when asked to (SPP here)', async () => {
    const b = band();
    const { dev } = connectTo(b, PHONE_ID, { companion: 'ios' });
    await dev.connect();
    expect(b.companionInfo![1]).toBe(1);
  });
});
