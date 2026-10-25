import type { AuthSession } from '../core/auth';
import { ByteQueue, concat, hex } from '../core/bytes';
import {
  type Channel,
  type V1Packet,
  type V2Packet,
  encodeV1,
  encodeV2Frame,
  parseV1,
  parseV2,
  parseV2SessionConfig,
  v1VersionRequest,
  V1_DATA_AUTH,
  V1_DATA_ENCRYPTED,
  V1_DATA_PLAIN,
  V1_OPCODE_SEND,
  v2DataPayload,
  v2DecodeData,
  v2SessionConfigPayload,
  V2_ACK,
  V2_DATA,
  V2_NACK,
  V2_OPCODE_ENCRYPTED,
  V2_SESSION_CONFIG,
} from '../core/packets';
import type { ByteTransport } from '../transport/types';
import { deferred, type Link, noop } from './link';

// Ported from Gadgetbridge XiaomiSppSupport / XiaomiSppProtocolV1 / XiaomiSppProtocolV2 /
// XiaomiSppV2SendWindow / XiaomiBleProtocolV2 (AGPL-3.0).

const VERSION_TIMEOUT_MS = 5000;
const RESEND_TIMEOUT_MS = 10_000;
const MAX_TIMEOUTS_WITHOUT_ACK = 3;
const MAX_TX_WINDOW = 32;

type Mode = 'detect' | 'v1' | 'v2';

/**
 * SPP-style framing over a byte stream.
 *  - `detect` (Bluetooth Classic SPP): asks for the protocol version first, then V1 or V2.
 *  - `v2` (BLE V2): SPP V2 frames straight away.
 */
export class StreamLink implements Link {
  auth: AuthSession | null = null;
  onReadyForAuth = noop;
  onCommand: (b: Uint8Array) => void = noop;
  onClose = noop;
  log: (m: string) => void = noop;

  private mode: Mode;
  private readonly rx = new ByteQueue();
  private versionTimer: ReturnType<typeof setTimeout> | null = null;

  // V1 state
  private frameCounter = 0;
  private encryptionCounter = 0;

  // V2 state
  private nextSeq = 0;
  private unacked: { seq: number; frame: Uint8Array }[] = [];
  private txWindow = MAX_TX_WINDOW;
  private windowWaiters: (() => void)[] = [];
  private resendTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutsWithoutAck = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly transport: ByteTransport, initialMode: 'detect' | 'v2') {
    this.mode = initialMode;
    transport.onData = (d) => this.onBytes(d);
    transport.onClose = () => {
      this.dispose();
      this.onClose();
    };
  }

  get name(): string {
    return `${this.transport.label} / ${this.mode === 'detect' ? '…' : this.mode.toUpperCase()}`;
  }

  async start(): Promise<void> {
    if (this.mode === 'v2') {
      await this.sendSessionConfig();
      return;
    }
    this.log('→ asking for SPP protocol version');
    this.versionTimer = setTimeout(() => {
      this.log('No version reply, falling back to SPP V1');
      this.onVersion(new Uint8Array(0));
    }, VERSION_TIMEOUT_MS);
    await this.write(v1VersionRequest());
  }

  private write(data: Uint8Array): Promise<void> {
    const p = this.writeChain.then(() => this.transport.write(data));
    this.writeChain = p.catch(() => {});
    return p;
  }

  private async sendSessionConfig(): Promise<void> {
    this.log('→ SPP V2 session config');
    this.resetV2();
    await this.write(encodeV2Frame(V2_SESSION_CONFIG, 0, v2SessionConfigPayload(1)));
  }

  private onVersion(payload: Uint8Array): void {
    if (this.versionTimer) clearTimeout(this.versionTimer);
    this.versionTimer = null;
    if (this.mode !== 'detect') return;
    if (payload.length > 0) this.log(`SPP version: ${hex(payload)}`);
    if (payload.length > 0 && payload[0] >= 2) {
      this.mode = 'v2';
      this.rx.clear();
      void this.sendSessionConfig();
    } else {
      this.mode = 'v1';
      this.onReadyForAuth();
    }
  }

  // ------------------------------------------------------------- receive ---

  private onBytes(data: Uint8Array): void {
    this.rx.push(data);
    for (;;) {
      const buf = this.rx.peek();
      if (buf.length === 0) return;
      const v2 = this.mode === 'v2';
      const res = v2 ? parseV2(buf) : parseV1(buf);
      if (res.status === 'incomplete') return;
      if (res.status === 'invalid') {
        const magic = v2 ? 0xa5 : 0xba;
        let next = buf.indexOf(magic, 1);
        if (next < 0) next = buf.length;
        this.rx.skip(next);
        continue;
      }
      this.rx.skip(res.size);
      if (!res.packet) {
        this.log('⚠ frame checksum error, dropped');
        continue;
      }
      try {
        if (v2) this.handleV2(res.packet as V2Packet);
        else this.handleV1(res.packet as V1Packet);
      } catch (e) {
        this.log(`⚠ packet handling error: ${(e as Error).message}`);
      }
    }
  }

  private handleV1(p: V1Packet): void {
    let payload = p.payload;
    if (p.dataType === V1_DATA_ENCRYPTED && this.auth?.encryptionInitialized) payload = this.auth.decrypt(payload);
    if (p.channel === 'version') this.onVersion(payload);
    else if (p.channel === 'proto') this.onCommand(payload);
  }

  private handleV2(p: V2Packet): void {
    switch (p.type) {
      case V2_SESSION_CONFIG: {
        const cfg = parseV2SessionConfig(p.payload);
        if (cfg.txWindow) this.txWindow = Math.max(1, Math.min(MAX_TX_WINDOW, cfg.txWindow));
        this.log(`← session config (op=${cfg.opCode}, window=${cfg.txWindow ?? '?'}, maxFrame=${cfg.maxPacketSize ?? '?'})`);
        this.onReadyForAuth();
        break;
      }
      case V2_DATA: {
        const d = v2DecodeData(p.payload);
        void this.write(encodeV2Frame(V2_ACK, p.seq, new Uint8Array(0)));
        if (!d) return;
        let body = d.body;
        if (d.opCode === V2_OPCODE_ENCRYPTED) {
          if (!this.auth) return;
          body = this.auth.decryptV2(body);
        }
        if (d.channel === 'proto') this.onCommand(body);
        break;
      }
      case V2_ACK:
        this.onAck(p.seq);
        break;
      case V2_NACK:
        this.onNack(p.seq);
        break;
    }
  }

  // ---------------------------------------------------------- V2 window ---

  private resetV2(): void {
    this.nextSeq = 0;
    this.unacked = [];
    this.timeoutsWithoutAck = 0;
    if (this.resendTimer) clearTimeout(this.resendTimer);
    this.resendTimer = null;
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    const w = this.windowWaiters;
    this.windowWaiters = [];
    w.forEach((f) => f());
  }

  private onAck(seq: number): void {
    const idx = this.unacked.findIndex((f) => f.seq === seq);
    if (idx < 0) return;
    this.unacked.splice(0, idx + 1);
    this.timeoutsWithoutAck = 0;
    if (this.resendTimer) clearTimeout(this.resendTimer);
    this.resendTimer = null;
    if (this.unacked.length > 0) this.armResend();
    this.releaseWaiters();
  }

  private onNack(expected: number): void {
    this.onAck((expected - 1) & 0xff);
    if (this.unacked[0]?.seq !== expected) return;
    this.log(`⚠ band requested resend from packet ${expected}`);
    void this.resendAll();
  }

  private async resendAll(): Promise<void> {
    for (const f of this.unacked) await this.write(f.frame);
    this.armResend();
  }

  private armResend(): void {
    if (this.resendTimer) return;
    this.resendTimer = setTimeout(() => {
      this.resendTimer = null;
      if (this.unacked.length === 0) return;
      if (++this.timeoutsWithoutAck >= MAX_TIMEOUTS_WITHOUT_ACK) {
        this.log('⚠ band not responding, disconnecting');
        void this.close();
        return;
      }
      this.log(`⚠ ack timeout for packet ${this.unacked[0].seq}, resending`);
      void this.resendAll();
    }, RESEND_TIMEOUT_MS);
  }

  private async sendV2(channel: Channel, body: Uint8Array): Promise<void> {
    while (this.unacked.length >= this.txWindow) {
      const d = deferred();
      this.windowWaiters.push(d.resolve);
      await d.promise;
    }
    if (channel === 'proto' || channel === 'activity') {
      if (!this.auth) throw new Error('Not authenticated');
      body = this.auth.encryptV2(body);
    }
    const seq = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) & 0xff;
    const frame = encodeV2Frame(V2_DATA, seq, v2DataPayload(channel, body));
    this.unacked.push({ seq, frame });
    await this.write(frame);
    this.armResend();
  }

  // ---------------------------------------------------------------- V1 ----

  private async sendV1(channel: Channel, body: Uint8Array): Promise<void> {
    const dataType = channel === 'auth' ? V1_DATA_AUTH : channel === 'activity' ? V1_DATA_PLAIN : V1_DATA_ENCRYPTED;
    let payload = body;
    if (dataType === V1_DATA_ENCRYPTED) {
      if (!this.auth) throw new Error('Not authenticated');
      if (channel === 'proto') {
        const counter = ++this.encryptionCounter;
        const enc = this.auth.encrypt(body, counter);
        payload = concat(new Uint8Array([counter & 0xff, (counter >> 8) & 0xff]), enc);
      } else {
        payload = this.auth.encrypt(body, 0);
      }
    }
    await this.write(
      encodeV1({
        channel,
        flag: true,
        needsResponse: false,
        opCode: V1_OPCODE_SEND,
        frameSerial: this.frameCounter++ & 0xff,
        dataType,
        payload,
      }),
    );
  }

  // ------------------------------------------------------------- public ---

  sendCommand(bytes: Uint8Array, isAuth: boolean): Promise<void> {
    const ch: Channel = isAuth ? 'auth' : 'proto';
    return this.mode === 'v2' ? this.sendV2(ch, bytes) : this.sendV1(ch, bytes);
  }

  sendData(chunk: Uint8Array): Promise<void> {
    return this.mode === 'v2' ? this.sendV2('data', chunk) : this.sendV1('data', chunk);
  }

  onAuthSuccess(): void {}

  private dispose(): void {
    if (this.versionTimer) clearTimeout(this.versionTimer);
    if (this.resendTimer) clearTimeout(this.resendTimer);
    this.versionTimer = this.resendTimer = null;
    this.releaseWaiters();
  }

  async close(): Promise<void> {
    this.dispose();
    await this.transport.close();
  }
}
