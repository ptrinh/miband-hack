import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { crc32 } from '../src/core/checksum';
import { encodeV1, encodeV2Frame, parseV1, parseV2, V2_ACK, V2_DATA, V2_SESSION_CONFIG } from '../src/core/packets';
import { type Command, decodeCommand, encodeCommand } from '../src/core/proto';
import type { ByteTransport } from '../src/transport/types';

/**
 * Simulated Mi Band 9 speaking SPP (version probe → V2). Crypto on the band side uses node:crypto
 * only, so it checks our implementation instead of reusing it.
 */
export class FakeBand {
  readonly transport: ByteTransport;
  received: { rpk?: Uint8Array; type?: number } = {};
  dataFrames = 0;
  maxInFlight = 0;

  private rxBuf = Buffer.alloc(0);
  private v2 = false;
  private seq = 0;
  private encKey: Buffer | null = null; // band → phone
  private decKey: Buffer | null = null; // phone → band
  private watchNonce = randomBytes(16);
  private phoneNonce: Buffer | null = null;
  private phoneEncNonce: Buffer | null = null;
  private upload: { parts: Buffer[]; total: number; type: number; size: number } | null = null;
  private pendingAcks: number[] = [];
  /** Every auth step 1 received, with the session device type in force. */
  authAttempts: { deviceId?: string; checkDynamicCode?: boolean; sessionDeviceType?: number }[] = [];
  sessionConfigs = 0;
  /** Decrypted CompanionDevice from step 2 (field 1 = device_type). */
  companionInfo: Buffer | null = null;
  bindStatusQueries = 0;
  private sessionDeviceType: number | undefined;
  /** Health file ids the phone acked (8/5), as hex. */
  healthAcked: string[] = [];
  /** Health file ids the phone requested (8/3), as hex. */
  healthRequested: string[] = [];

  constructor(
    readonly secret: Buffer,
    private readonly opts: {
      txWindow: number;
      chunkSize: number;
      ackDelayMs: number;
      /**
       * Binding the band enforces on auth step 1, as a band paired from iOS seems to: step 1 is refused with
       * Account.error_code NO_BOUND (4) unless it carries this app_device_id / followed a session config
       * with this device type (TLV 5).
       */
      bound?: { deviceId?: string; sessionDeviceType?: number };
      /** Recorded health files (id | 00 | body | crc32), listed under "today" or "past". */
      health?: { today: Uint8Array[]; past: Uint8Array[]; activityChunk?: number; corrupt?: string[]; drop?: string[] };
      /** Bytes used / total reported by GET_STORAGE_INFO; default 1 MB of 128 MB. */
      storage?: { used: number; total: number };
    },
  ) {
    const band = this;
    this.transport = {
      label: 'fake',
      onData: () => {},
      onClose: () => {},
      async write(data: Uint8Array) {
        // deliver in odd-sized fragments to exercise stream reassembly
        for (let off = 0; off < data.length; off += 7) band.onPhoneBytes(Buffer.from(data.subarray(off, off + 7)));
      },
      async close() {},
    };
  }

  private toPhone(bytes: Uint8Array): void {
    // also fragment band → phone traffic
    setTimeout(() => {
      for (let off = 0; off < bytes.length; off += 5) this.transport.onData(bytes.slice(off, off + 5));
    }, 1);
  }

  private sendCommand(cmd: Command, encrypt: boolean): void {
    let body = Buffer.from(encodeCommand(cmd));
    if (encrypt) {
      const c = createCipheriv('aes-128-ctr', this.encKey!, this.encKey!);
      body = Buffer.concat([c.update(body), c.final()]);
    }
    const payload = Buffer.concat([Buffer.from([1, encrypt ? 2 : 1]), body]);
    this.toPhone(encodeV2Frame(V2_DATA, this.seq++ & 0xff, payload));
  }

  /** XiaomiActivityFileFetcher's side: the file in `u16 total | u16 index | data` chunks on channel 5. */
  private sendActivityFile(file: Uint8Array): void {
    const size = this.opts.health?.activityChunk ?? 400;
    const total = Math.ceil(file.length / size);
    for (let i = 0; i < total; i++) {
      const head = Buffer.alloc(4);
      head.writeUInt16LE(total, 0);
      head.writeUInt16LE(i + 1, 2);
      const c = createCipheriv('aes-128-ctr', this.encKey!, this.encKey!);
      const body = Buffer.concat([c.update(Buffer.concat([head, file.subarray(i * size, (i + 1) * size)])), c.final()]);
      this.toPhone(encodeV2Frame(V2_DATA, this.seq++ & 0xff, Buffer.concat([Buffer.from([5, 2]), body])));
    }
  }

  private onHealth(cmd: Command): void {
    const h = this.opts.health ?? { today: [], past: [] };
    const idHex = (f: Uint8Array) => Buffer.from(f.subarray(0, 7)).toString('hex');
    if (cmd.subtype === 1 || cmd.subtype === 2) {
      const list = cmd.subtype === 1 ? h.today : h.past;
      this.sendCommand({ type: 8, subtype: cmd.subtype, health: { activityRequestFileIds: Buffer.concat(list.map((f) => f.subarray(0, 7))) } }, true);
    } else if (cmd.subtype === 3) {
      const want = Buffer.from(cmd.health!.activityRequestFileIds!).toString('hex');
      this.healthRequested.push(want);
      if (h.drop?.includes(want)) return; // band never answers
      const file = [...h.today, ...h.past].find((f) => idHex(f) === want);
      if (!file) return;
      const out = Buffer.from(file);
      if (h.corrupt?.includes(want)) out[out.length - 1] ^= 0xff;
      this.sendActivityFile(out);
    } else if (cmd.subtype === 5) {
      this.healthAcked.push(Buffer.from(cmd.health!.activitySyncAckFileIds!).toString('hex'));
    }
  }

  private onPhoneBytes(chunk: Buffer): void {
    this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
    for (;;) {
      const res = this.v2 ? parseV2(this.rxBuf) : parseV1(this.rxBuf);
      if (res.status !== 'complete') return;
      this.rxBuf = this.rxBuf.subarray(res.size);
      if (!res.packet) throw new Error('band: bad frame from phone');
      if (!this.v2) {
        // V1 version probe → answer "protocol 2"
        this.v2 = true;
        this.toPhone(encodeV1({ channel: 'version', flag: true, needsResponse: false, opCode: 0, frameSerial: 0, dataType: 0, payload: new Uint8Array([2, 0, 0]) }));
        continue;
      }
      this.onV2(res.packet as { type: number; seq: number; payload: Uint8Array });
    }
  }

  private onV2(p: { type: number; seq: number; payload: Uint8Array }): void {
    if (p.type === V2_SESSION_CONFIG) {
      this.sessionConfigs++;
      this.sessionDeviceType = undefined;
      for (let off = 1; off + 3 <= p.payload.length; ) {
        const key = p.payload[off];
        const len = p.payload[off + 1] | (p.payload[off + 2] << 8);
        if (key === 5 && len === 1) this.sessionDeviceType = p.payload[off + 3];
        off += 3 + len;
      }
      const w = this.opts.txWindow;
      this.toPhone(encodeV2Frame(V2_SESSION_CONFIG, 0, new Uint8Array([2, 0x03, 0x02, 0x00, w & 0xff, w >> 8])));
      return;
    }
    if (p.type !== V2_DATA) return;

    this.pendingAcks.push(p.seq);
    this.maxInFlight = Math.max(this.maxInFlight, this.pendingAcks.length);
    setTimeout(() => {
      const s = this.pendingAcks.shift();
      if (s !== undefined) this.toPhone(encodeV2Frame(V2_ACK, s, new Uint8Array(0)));
    }, this.opts.ackDelayMs);

    const channel = p.payload[0] & 0x0f;
    const opCode = p.payload[1];
    let body = Buffer.from(p.payload.subarray(2));
    if (channel === 2) {
      this.onUploadPart(body);
      return;
    }
    if (opCode === 2) {
      const d = createDecipheriv('aes-128-ctr', this.decKey!, this.decKey!);
      body = Buffer.concat([d.update(body), d.final()]);
    }
    this.onCommand(decodeCommand(body));
  }

  private onCommand(cmd: Command): void {
    if (cmd.type === 1 && cmd.subtype === 0) {
      this.bindStatusQueries++;
      this.sendCommand({ type: 1, subtype: 0, auth: { bindStatus: true } }, false);
      return;
    }
    if (cmd.type === 1 && cmd.subtype === 26) {
      const av = cmd.auth!.appVerify!;
      this.authAttempts.push({
        ...(av.deviceId ? { deviceId: av.deviceId } : {}),
        ...(av.checkDynamicCode ? { checkDynamicCode: true } : {}),
        ...(this.sessionDeviceType !== undefined ? { sessionDeviceType: this.sessionDeviceType } : {}),
      });
      const b = this.opts.bound;
      if (b && ((b.deviceId !== undefined && av.deviceId !== b.deviceId) || (b.sessionDeviceType !== undefined && this.sessionDeviceType !== b.sessionDeviceType))) {
        this.sendCommand({ type: 1, subtype: 26, auth: { errorCode: 4 } }, false);
        return;
      }
      this.phoneNonce = Buffer.from(cmd.auth!.appVerify!.nonce);
      const hk = createHmac('sha256', Buffer.concat([this.phoneNonce, this.watchNonce])).update(this.secret).digest();
      let t = Buffer.alloc(0);
      const parts: Buffer[] = [];
      for (let i = 1; i <= 2; i++) {
        t = createHmac('sha256', hk).update(Buffer.concat([t, Buffer.from('miwear-auth'), Buffer.from([i])])).digest();
        parts.push(t);
      }
      const k = Buffer.concat(parts);
      this.encKey = k.subarray(0, 16);
      this.decKey = k.subarray(16, 32);
      const hmac = createHmac('sha256', this.encKey).update(Buffer.concat([this.watchNonce, this.phoneNonce])).digest();
      this.phoneEncNonce = k.subarray(36, 40);
      this.sendCommand({ type: 1, subtype: 26, auth: { deviceVerify: { nonce: this.watchNonce, hmac } } }, false);
      return;
    }
    if (cmd.type === 1 && cmd.subtype === 27) {
      const conf = cmd.auth!.appConfirm!;
      const expected = createHmac('sha256', this.decKey!).update(Buffer.concat([this.phoneNonce!, this.watchNonce])).digest();
      if (!expected.equals(Buffer.from(conf.encryptedNonces))) throw new Error('band: phone confirmation mismatch');
      // device info is AES-CCM encrypted with the phone's encryption key/nonce, counter 0
      const nonce = Buffer.concat([this.phoneEncNonce!, Buffer.alloc(8)]);
      const enc = Buffer.from(conf.encryptedDeviceInfo);
      const d = createDecipheriv('aes-128-ccm', this.decKey!, nonce, { authTagLength: 4 });
      d.setAuthTag(enc.subarray(enc.length - 4));
      const info = d.update(enc.subarray(0, enc.length - 4)); // throws on a bad tag via final()
      d.final();
      this.companionInfo = info;
      this.sendCommand({ type: 1, subtype: 27 }, false);
      return;
    }
    if (cmd.type === 2 && cmd.subtype === 2) {
      this.sendCommand({ type: 2, subtype: 2, system: { deviceInfo: { model: 'Xiaomi Smart Band 9', firmware: '2.3.93', serialNumber: 'FAKE' } } }, true);
    } else if (cmd.type === 2 && cmd.subtype === 62) {
      this.sendCommand({ type: 2, subtype: 62, system: { storageInfo: this.opts.storage ?? { used: 2 ** 20, total: 2 ** 27 } } }, true);
    } else if (cmd.type === 2 && cmd.subtype === 1) {
      this.sendCommand({ type: 2, subtype: 1, system: { power: { battery: { level: 77 } } } }, true);
    } else if (cmd.type === 20 && cmd.subtype === 0) {
      const apps = this.received.rpk ? [{ id: 'com.example.hello', name: 'Hello' }] : [];
      this.sendCommand({ type: 20, subtype: 0, rpk: { rpkList: { rpkInfo: apps } } }, true);
    } else if (cmd.type === 4 && cmd.subtype === 0) {
      this.sendCommand({ type: 4, subtype: 0, watchface: { watchfaceList: { watchface: [{ id: '1', name: 'Default', active: true, canDelete: false }] } } }, true);
    } else if (cmd.type === 20 && cmd.subtype === 1) {
      this.sendCommand({ type: 20, subtype: 1, rpk: { rpkInstallStart: { cmd: 0 } } }, true);
    } else if (cmd.type === 8) {
      this.onHealth(cmd);
    } else if (cmd.type === 22 && cmd.subtype === 0) {
      const req = cmd.dataUpload!.dataUploadRequest!;
      this.upload = { parts: [], total: 0, type: req.type!, size: req.size! };
      this.sendCommand({ type: 22, subtype: 0, dataUpload: { dataUploadAck: { errno: 0, chunkSize: this.opts.chunkSize, resumePosition: 0 } } }, true);
    }
  }

  private onUploadPart(part: Buffer): void {
    this.dataFrames++;
    const u = this.upload!;
    u.total = part.readUInt16LE(0);
    const idx = part.readUInt16LE(2);
    if (idx !== u.parts.length + 1) throw new Error(`band: part ${idx} out of order`);
    u.parts.push(part.subarray(4));
    if (idx < u.total) return;

    const all = Buffer.concat(u.parts);
    const body = all.subarray(0, all.length - 4);
    if (crc32(body) !== all.readUInt32LE(all.length - 4)) throw new Error('band: crc32 mismatch');
    const md5 = body.subarray(2, 18);
    const size = body.readUInt32LE(18);
    const data = body.subarray(22);
    if (size !== data.length || size !== u.size) throw new Error('band: size mismatch');
    if (!createHash('md5').update(data).digest().equals(md5)) throw new Error('band: md5 mismatch');
    this.received = { rpk: new Uint8Array(data), type: body[1] };
    this.sendCommand({ type: 20, subtype: 2 }, true);
  }
}
