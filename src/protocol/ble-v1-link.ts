import type { AuthSession } from '../core/auth';
import { concat, readU16le, u16le } from '../core/bytes';
import { type BleV1Chars, DEFAULT_BLE_WRITE_SIZE, GattWriter } from '../transport/ble';
import { deferred, type Link, noop } from './link';

// Ported from Gadgetbridge XiaomiBleProtocolV1 / XiaomiCharacteristicV1 (AGPL-3.0).

const MISSING_CHUNK_TIMEOUT_MS = 5000;
const PAYLOAD_ACK = new Uint8Array([0, 0, 3, 0]);

interface Payload {
  bytes: Uint8Array;
  done?: { resolve: () => void; reject: (e: unknown) => void };
}

/** One Xiaomi V1 characteristic: chunked/single-command framing with acks, both directions. */
class XiaomiCharacteristic {
  handler: ((b: Uint8Array) => void) | null = null;
  incrementNonce = true;
  private encryptedIndex = 1;
  private readonly writer: GattWriter;

  private numChunks = 0;
  private received = new Map<number, Uint8Array>();
  private missingTimer: ReturnType<typeof setTimeout> | null = null;

  private queue: Payload[] = [];
  private current: Payload | null = null;
  private currentBytes: Uint8Array = new Uint8Array(0);
  private waitingAck = false;
  private sendingChunked = false;

  constructor(
    private readonly ch: BluetoothRemoteGATTCharacteristic,
    private readonly link: BleV1Link,
    private readonly maxWriteSize: number,
    preferWithoutResponse = false,
  ) {
    this.writer = new GattWriter(ch, preferWithoutResponse);
  }

  async start(): Promise<void> {
    this.ch.addEventListener('characteristicvaluechanged', (e) => {
      const v = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      try {
        this.onNotify(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
      } catch (err) {
        this.link.log(`⚠ ${(err as Error).message}`);
      }
    });
    await this.ch.startNotifications();
  }

  reset(): void {
    this.numChunks = 0;
    this.encryptedIndex = 1; // 0 is used by the auth handshake
    this.received.clear();
    this.queue = [];
    this.current = null;
    this.waitingAck = false;
    this.sendingChunked = false;
    if (this.missingTimer) clearTimeout(this.missingTimer);
  }

  write(bytes: Uint8Array, waitAck = false): Promise<void> {
    if (!waitAck) {
      this.queue.push({ bytes });
      this.sendNext();
      return Promise.resolve();
    }
    const d = deferred();
    this.queue.push({ bytes, done: { resolve: d.resolve, reject: d.reject } });
    this.sendNext();
    return d.promise;
  }

  private get auth(): AuthSession | null {
    return this.link.auth;
  }

  private raw(bytes: Uint8Array): void {
    this.writer.write(bytes).catch((e) => this.link.log(`⚠ GATT write failed: ${(e as Error).message}`));
  }

  private sendChunk(index: number, chunkSize: number): void {
    const start = index * chunkSize;
    this.raw(concat(u16le(index + 1), this.currentBytes.subarray(start, start + chunkSize)));
  }

  private finishCurrent(ok: boolean): void {
    const done = this.current?.done;
    this.current = null;
    if (done) ok ? done.resolve() : done.reject(new Error('Band rejected (NACK)'));
  }

  private sendNext(): void {
    if (this.waitingAck || this.sendingChunked) return;
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;

    const encrypt = !!this.auth?.encryptionInitialized;
    let bytes: Uint8Array = next.bytes;
    if (encrypt) bytes = this.auth!.encrypt(bytes, this.incrementNonce ? this.encryptedIndex : 0);

    // Only encrypted UUID sets (Mi Band 8 and later) are supported, so short payloads go out as
    // single commands even before the handshake completes, as in Gadgetbridge.
    const chunked = bytes.length + 6 > this.maxWriteSize;
    if (chunked) {
      if (encrypt && this.incrementNonce) bytes = concat(u16le(this.encryptedIndex++), bytes);
      this.currentBytes = bytes;
      this.sendingChunked = true;
      const n = Math.ceil(bytes.length / (this.maxWriteSize - 2));
      this.raw(concat(new Uint8Array([0, 0, 0, encrypt ? 1 : 0]), u16le(n)));
    } else {
      const header = encrypt
        ? concat(new Uint8Array([0, 0, 2, 1]), u16le(this.incrementNonce ? this.encryptedIndex++ : 0))
        : new Uint8Array([0, 0, 2, 2]);
      this.waitingAck = true;
      this.raw(concat(header, bytes));
    }
  }

  private onNotify(value: Uint8Array): void {
    const chunk = readU16le(value, 0);
    if (chunk !== 0) {
      if (chunk > this.numChunks) return;
      this.received.set(chunk, value.slice(2));
      this.armMissingTimer();
      if (this.received.size === this.numChunks) {
        if (this.missingTimer) clearTimeout(this.missingTimer);
        this.raw(new Uint8Array([0, 0, 1, 0]));
        const parts: Uint8Array[] = [];
        for (let i = 1; i <= this.numChunks; i++) parts.push(this.received.get(i)!);
        const payload = concat(...parts);
        this.numChunks = 0;
        this.received.clear();
        const isEncrypted = !!this.auth?.encryptionInitialized;
        this.handler?.(isEncrypted ? this.auth!.decrypt(payload) : payload);
      }
      return;
    }

    const type = value[2];
    switch (type) {
      case 0: {
        // band starts a chunked transfer to us
        this.numChunks = readU16le(value, 4);
        this.received.clear();
        this.raw(new Uint8Array([0, 0, 1, 1]));
        return;
      }
      case 1: {
        const subtype = value[3];
        if (subtype === 0) {
          this.sendingChunked = false;
          this.finishCurrent(true);
          this.sendNext();
        } else if (subtype === 1) {
          const size = this.maxWriteSize - 2;
          for (let i = 0; i * size < this.currentBytes.length; i++) this.sendChunk(i, size);
        } else if (subtype === 2) {
          this.sendingChunked = false;
          this.finishCurrent(false);
          this.sendNext();
        } else if (subtype === 5) {
          const size = this.maxWriteSize - 2;
          for (let off = 4; off + 1 < value.length; off += 2) this.sendChunk(readU16le(value, off) - 1, size);
        }
        return;
      }
      case 2: {
        // single command from the band
        this.raw(PAYLOAD_ACK);
        const encrypted = value[3] === 1;
        const body = value.slice(4);
        this.handler?.(encrypted ? this.auth!.decrypt(body) : body);
        return;
      }
      case 3: {
        this.waitingAck = false;
        this.finishCurrent(value[3] === 0);
        this.sendNext();
        return;
      }
    }
  }

  private armMissingTimer(): void {
    if (this.missingTimer) clearTimeout(this.missingTimer);
    this.missingTimer = setTimeout(() => {
      const missing: number[] = [];
      for (let i = 1; i <= this.numChunks; i++) if (!this.received.has(i)) missing.push(i);
      const n = Math.min(missing.length, (this.maxWriteSize - 4) >> 1);
      this.raw(concat(new Uint8Array([0, 0, 1, 5]), ...missing.slice(0, n).map(u16le)));
    }, MISSING_CHUNK_TIMEOUT_MS);
  }
}

export class BleV1Link implements Link {
  readonly name = 'BLE V1';
  readonly overBle = true;
  /** Parts go straight to 0x0055: a Mi Band 8 answers a 2046-byte part with a bare chunk request and stalls. */
  readonly uploadPartOverhead = 0;
  auth: AuthSession | null = null;
  onReadyForAuth = noop;
  onCommand: (b: Uint8Array) => void = noop;
  onActivity: (b: Uint8Array) => void = noop;
  onClose = noop;
  log: (m: string) => void = noop;

  get deviceName(): string | undefined {
    return this.device.name;
  }

  private readonly cmdRead: XiaomiCharacteristic;
  private readonly cmdWrite: XiaomiCharacteristic;
  private readonly activity: XiaomiCharacteristic;
  private readonly upload: XiaomiCharacteristic | null;

  constructor(private readonly device: BluetoothDevice, chars: BleV1Chars, writeSize = DEFAULT_BLE_WRITE_SIZE) {
    this.cmdRead = new XiaomiCharacteristic(chars.commandRead, this, writeSize);
    this.cmdWrite = new XiaomiCharacteristic(chars.commandWrite, this, writeSize);
    this.activity = new XiaomiCharacteristic(chars.activity, this, writeSize);
    // Writes with response cost a round trip each: a Mi Band 8 upload ran 5× faster without them (2026-10-26).
    this.upload = chars.upload ? new XiaomiCharacteristic(chars.upload, this, writeSize, true) : null;
    if (this.upload) this.upload.incrementNonce = false;
    this.cmdRead.handler = (b) => this.onCommand(b);
    this.activity.handler = (b) => this.onActivity(b);
    device.addEventListener('gattserverdisconnected', () => this.onClose());
  }

  private all(): XiaomiCharacteristic[] {
    return [this.cmdRead, this.cmdWrite, this.activity, ...(this.upload ? [this.upload] : [])];
  }

  async start(): Promise<void> {
    for (const c of this.all()) {
      c.reset();
      await c.start();
    }
    this.onReadyForAuth();
  }

  sendCommand(bytes: Uint8Array): Promise<void> {
    return this.cmdWrite.write(bytes);
  }

  sendData(chunk: Uint8Array): Promise<void> {
    if (!this.upload) return Promise.reject(new Error('Device has no upload characteristic (0x0055)'));
    return this.upload.write(chunk, true);
  }

  onAuthSuccess(): void {
    this.all().forEach((c) => c.reset());
  }

  async close(): Promise<void> {
    this.device.gatt?.disconnect();
  }
}
