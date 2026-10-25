import { type ByteTransport, uuid16, XIAOMI_SERVICE } from './types';
import { t } from '../i18n';

export const webBluetoothAvailable = (): boolean => typeof navigator !== 'undefined' && 'bluetooth' in navigator;

// Web Bluetooth cannot request an MTU. 180 bytes fits the smallest MTU seen on desktop
// (macOS negotiates ~185), so writes never fall back to long/prepared writes.
export const DEFAULT_BLE_WRITE_SIZE = 180;

/** Serializes GATT writes: Web Bluetooth rejects a write while another is in flight. */
export class GattWriter {
  private chain: Promise<void> = Promise.resolve();
  private readonly withResponse: boolean;

  constructor(private readonly ch: BluetoothRemoteGATTCharacteristic) {
    this.withResponse = !ch.properties.writeWithoutResponse || ch.properties.write;
  }

  write(data: Uint8Array): Promise<void> {
    const run = async () => {
      const buf = data.slice().buffer as ArrayBuffer;
      if (this.withResponse) await this.ch.writeValueWithResponse(buf);
      else await this.ch.writeValueWithoutResponse(buf);
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => {});
    return p;
  }
}

export interface BleV1Chars {
  commandRead: BluetoothRemoteGATTCharacteristic;
  commandWrite: BluetoothRemoteGATTCharacteristic;
  activity: BluetoothRemoteGATTCharacteristic;
  upload: BluetoothRemoteGATTCharacteristic | null;
}

export type BleConnection =
  | { kind: 'v1'; device: BluetoothDevice; chars: BleV1Chars }
  | { kind: 'v2'; device: BluetoothDevice; transport: BleV2Transport };

async function optionalChar(svc: BluetoothRemoteGATTService, id: number) {
  try {
    return await svc.getCharacteristic(uuid16(id));
  } catch {
    return null;
  }
}

const props = (c: BluetoothRemoteGATTCharacteristic): string =>
  (['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'] as const).filter((k) => c.properties[k]).join('+') || 'none';

/**
 * Opens the device picker, connects and detects which Xiaomi BLE protocol the band speaks. Every step
 * is logged with its duration, and a failing step with the browser's error name and message.
 */
export async function requestBle(log: (m: string) => void = () => {}): Promise<BleConnection> {
  if (!webBluetoothAvailable()) throw new Error(t('errNoWebBt'));
  const step = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    const s = performance.now();
    try {
      const r = await f();
      log(`  ✓ ${what} (${Math.round(performance.now() - s)} ms)`);
      return r;
    } catch (e) {
      const err = e as Error;
      log(`  ✗ ${what} failed after ${Math.round(performance.now() - s)} ms: ${err.name}: ${err.message}`);
      throw e;
    }
  };
  const available = await navigator.bluetooth.getAvailability?.().catch(() => undefined);
  log(`  Bluetooth adapter available: ${available === undefined ? 'unknown' : available ? 'yes' : 'no'}`);
  const device = await step('device picked', () =>
    navigator.bluetooth.requestDevice({
      filters: [{ services: [XIAOMI_SERVICE] }, { namePrefix: 'Xiaomi' }, { namePrefix: 'Redmi' }],
      optionalServices: [XIAOMI_SERVICE],
    }),
  );
  log(`  device: "${device.name ?? '?'}", browser id ${device.id.slice(0, 8)}…`);
  const connectedAt = performance.now();
  device.addEventListener('gattserverdisconnected', () =>
    log(`  · GATT disconnected by the band or the system after ${Math.round(performance.now() - connectedAt)} ms`),
  );
  let gatt: BluetoothRemoteGATTServer;
  try {
    gatt = await step('GATT connect', () => device.gatt!.connect());
  } catch (e) {
    log(`  hint: ${t('bleConnectHint')}`);
    throw e;
  }
  const svc = await step(`Xiaomi service ${XIAOMI_SERVICE}`, () => gatt.getPrimaryService(XIAOMI_SERVICE));
  const chars = await svc.getCharacteristics().catch(() => [] as BluetoothRemoteGATTCharacteristic[]);
  log(`  characteristics: ${chars.map((c) => `${c.uuid.slice(4, 8)}(${props(c)})`).join(', ') || 'none listed'}`);

  // BLE V2 (e.g. Mi Band 9 Active): SPP V2 framing over 0x005e (rx) / 0x005f (tx).
  const rx = await optionalChar(svc, 0x005e);
  const tx = await optionalChar(svc, 0x005f);
  if (rx && tx) {
    log('  protocol: BLE V2 (SPP V2 frames over 005e / 005f)');
    const transport = new BleV2Transport(device, rx, tx);
    await step('notifications on 005e', () => transport.start());
    return { kind: 'v2', device, transport };
  }

  // BLE V1 (e.g. Mi Band 8): chunked protocol over 0x0051..0x0055.
  const commandRead = await optionalChar(svc, 0x0051);
  const commandWrite = await optionalChar(svc, 0x0052);
  const activity = await optionalChar(svc, 0x0053);
  const upload = await optionalChar(svc, 0x0055);
  if (commandRead && commandWrite && activity) {
    log('  protocol: BLE V1 (chunks over 0051..0055)');
    return { kind: 'v1', device, chars: { commandRead, commandWrite, activity, upload } };
  }

  log('  ✗ neither BLE V2 (005e/005f) nor BLE V1 (0051..0053) characteristics found');
  gatt.disconnect();
  throw new Error(t('errUnknownBle'));
}

export class BleV2Transport implements ByteTransport {
  readonly label = 'BLE V2';
  onData: (data: Uint8Array) => void = () => {};
  onClose: () => void = () => {};
  private readonly writer: GattWriter;

  constructor(
    private readonly device: BluetoothDevice,
    private readonly rx: BluetoothRemoteGATTCharacteristic,
    tx: BluetoothRemoteGATTCharacteristic,
    private readonly writeSize = DEFAULT_BLE_WRITE_SIZE,
  ) {
    this.writer = new GattWriter(tx);
  }

  async start(): Promise<void> {
    this.rx.addEventListener('characteristicvaluechanged', (e) => {
      const v = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      this.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
    });
    this.device.addEventListener('gattserverdisconnected', () => this.onClose());
    await this.rx.startNotifications();
  }

  async write(data: Uint8Array): Promise<void> {
    for (let off = 0; off < data.length; off += this.writeSize) {
      await this.writer.write(data.subarray(off, off + this.writeSize));
    }
  }

  async close(): Promise<void> {
    this.device.gatt?.disconnect();
  }
}
