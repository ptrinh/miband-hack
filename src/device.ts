import { AUTH_COMMAND_TYPE, AuthSession, CMD_AUTH, CMD_NONCE, CMD_SEND_USERID } from './core/auth';
import { concat, hex, u16le, u32le } from './core/bytes';
import { crc32 } from './core/checksum';
import { md5 } from './core/crypto';
import type { ParsedFile } from './core/files';
import { type Command, decodeCommand, encodeCommand } from './core/proto';
import { deferred, type Link } from './protocol/link';
import { t } from './i18n';

// Command types / subtypes, from Gadgetbridge's Xiaomi*Service classes (AGPL-3.0).
const SYSTEM = 2;
const SYS_BATTERY = 1;
const SYS_DEVICE_INFO = 2;
const WATCHFACE = 4;
const WF_LIST = 0;
const WF_SET = 1;
const WF_DELETE = 2;
const WF_INSTALL = 4;
const RPK = 20;
const RPK_LIST = 0;
const RPK_INSTALL = 1;
const RPK_INSTALLED = 2;
const RPK_DELETE = 3;
const DATA_UPLOAD = 22;
const UPLOAD_START = 0;
const UPLOAD_TYPE_WATCHFACE = 16;
const UPLOAD_TYPE_RPK = 64;

const AUTH_TIMEOUT_MS = 20_000;
const REPLY_TIMEOUT_MS = 15_000;
const INSTALL_CONFIRM_TIMEOUT_MS = 90_000;

export interface DeviceInfo {
  model?: string;
  firmware?: string;
  serial?: string;
  battery?: number;
}
export interface InstalledApp { id: string; name: string; sha?: Uint8Array }
export interface InstalledFace { id: string; name: string; active: boolean; canDelete: boolean }

interface Waiter {
  match: (c: Command) => boolean;
  resolve: (c: Command) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class XiaomiDevice {
  info: DeviceInfo = {};
  apps: InstalledApp[] = [];
  faces: InstalledFace[] = [];
  connected = false;

  onChange: () => void = () => {};
  onLog: (msg: string) => void = () => {};
  onDisconnect: () => void = () => {};

  private readonly auth: AuthSession;
  private authDone = deferred();
  private waiters: Waiter[] = [];
  private busy = false;

  constructor(readonly link: Link, authKey: Uint8Array) {
    this.auth = new AuthSession(authKey);
    this.authDone.promise.catch(() => {}); // observed in connect(); avoid unhandled rejection on later disconnects
    link.log = (m) => this.onLog(m);
    link.onCommand = (b) => this.handleBytes(b);
    link.onReadyForAuth = () => {
      this.onLog('→ starting authentication');
      void this.send(this.auth.buildNonceCommand());
    };
    link.onClose = () => {
      this.connected = false;
      this.authDone.reject(new Error(t('errConnLost')));
      this.waiters.forEach((w) => w.reject(new Error(t('errConnLost'))));
      this.waiters = [];
      this.onDisconnect();
    };
  }

  async connect(): Promise<void> {
    const timer = setTimeout(() => this.authDone.reject(new Error(t('errAuthTimeout'))), AUTH_TIMEOUT_MS);
    try {
      await this.link.start();
      await this.authDone.promise;
    } finally {
      clearTimeout(timer);
    }
    this.connected = true;
    this.onLog('✓ authenticated');
    await Promise.allSettled([this.refreshInfo(), this.refreshApps(), this.refreshFaces()]);
  }

  async disconnect(): Promise<void> {
    await this.link.close();
  }

  // ------------------------------------------------------------ plumbing ---

  private send(cmd: Command): Promise<void> {
    return this.link.sendCommand(encodeCommand(cmd), cmd.type === AUTH_COMMAND_TYPE);
  }

  private waitFor(match: (c: Command) => boolean, what: string, timeoutMs = REPLY_TIMEOUT_MS): Promise<Command> {
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error(t('errNoReply', { what })));
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  /** Registers the waiter before sending so a fast reply cannot be missed. */
  private async request(cmd: Command, match: (c: Command) => boolean, what: string, timeoutMs?: number): Promise<Command> {
    const reply = this.waitFor(match, what, timeoutMs);
    await this.send(cmd);
    return reply;
  }

  private handleBytes(bytes: Uint8Array): void {
    let cmd: Command;
    try {
      cmd = decodeCommand(bytes);
    } catch (e) {
      this.onLog(`⚠ could not decode protobuf (${(e as Error).message}): ${hex(bytes, 32)}`);
      return;
    }
    if (cmd.type === AUTH_COMMAND_TYPE) {
      this.handleAuth(cmd);
      return;
    }
    this.handlePassive(cmd);
    for (const w of [...this.waiters]) {
      if (w.match(cmd)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(cmd);
      }
    }
  }

  private handleAuth(cmd: Command): void {
    if (cmd.subtype === CMD_NONCE) {
      const dv = cmd.auth?.deviceVerify;
      if (!dv) {
        this.authDone.reject(new Error(t('errHandshake', { status: cmd.auth?.status ?? cmd.status ?? '?' })));
        return;
      }
      try {
        void this.send(this.auth.handleWatchNonce(dv.nonce, dv.hmac));
      } catch (e) {
        this.authDone.reject(e);
        void this.link.close();
      }
    } else if (cmd.subtype === CMD_AUTH) {
      this.auth.encryptionInitialized = true;
      this.link.auth = this.auth;
      this.link.onAuthSuccess();
      this.authDone.resolve();
    } else if (cmd.subtype === CMD_SEND_USERID) {
      this.authDone.reject(new Error(t('errLegacy')));
    }
  }

  private handlePassive(cmd: Command): void {
    if (cmd.type === SYSTEM && cmd.subtype === SYS_DEVICE_INFO && cmd.system?.deviceInfo) {
      const d = cmd.system.deviceInfo;
      Object.assign(this.info, { model: d.model, firmware: d.firmware, serial: d.serialNumber });
      this.onChange();
    } else if (cmd.type === SYSTEM && cmd.subtype === SYS_BATTERY && cmd.system?.power?.battery) {
      this.info.battery = cmd.system.power.battery.level;
      this.onChange();
    } else if (cmd.type === RPK && cmd.subtype === RPK_LIST) {
      this.apps = (cmd.rpk?.rpkList?.rpkInfo ?? []).map((r) => ({ id: r.id ?? '', name: r.name || r.id || '?', sha: r.sha }));
      this.onChange();
    } else if (cmd.type === WATCHFACE && cmd.subtype === WF_LIST) {
      this.faces = (cmd.watchface?.watchfaceList?.watchface ?? []).map((w) => ({
        id: w.id ?? '',
        name: w.name || w.id || '?',
        active: !!w.active,
        canDelete: !!w.canDelete,
      }));
      this.onChange();
    } else if (cmd.type === RPK && (cmd.subtype === RPK_INSTALLED || cmd.subtype === RPK_DELETE)) {
      void this.refreshApps();
    } else if (cmd.type === WATCHFACE && cmd.subtype === WF_DELETE) {
      void this.refreshFaces();
    }
  }

  // ------------------------------------------------------------- queries ---

  refreshInfo(): Promise<unknown> {
    return Promise.allSettled([
      this.request({ type: SYSTEM, subtype: SYS_DEVICE_INFO }, (c) => c.type === SYSTEM && c.subtype === SYS_DEVICE_INFO, t('whatInfo')),
      this.request({ type: SYSTEM, subtype: SYS_BATTERY }, (c) => c.type === SYSTEM && c.subtype === SYS_BATTERY, t('whatBattery')),
    ]);
  }

  refreshApps(): Promise<Command> {
    return this.request({ type: RPK, subtype: RPK_LIST }, (c) => c.type === RPK && c.subtype === RPK_LIST, t('whatApps'));
  }

  refreshFaces(): Promise<Command> {
    return this.request({ type: WATCHFACE, subtype: WF_LIST }, (c) => c.type === WATCHFACE && c.subtype === WF_LIST, t('whatFaces'));
  }

  // ------------------------------------------------------------- actions ---

  async deleteApp(app: InstalledApp): Promise<void> {
    this.onLog(`→ deleting app ${app.id}`);
    await this.send({ type: RPK, subtype: RPK_DELETE, rpk: { rpkDel: { id: app.id, sha: app.sha } } });
    // the band usually sends no reply to a delete
    await new Promise((r) => setTimeout(r, 800));
    await this.refreshApps();
  }

  async setWatchface(id: string): Promise<void> {
    await this.send({ type: WATCHFACE, subtype: WF_SET, watchface: { watchfaceId: id } });
    await this.refreshFaces();
  }

  async deleteWatchface(face: InstalledFace): Promise<void> {
    if (face.active) throw new Error(t('errDeleteActive'));
    if (!face.canDelete) throw new Error(t('errSystemFace'));
    await this.send({ type: WATCHFACE, subtype: WF_DELETE, watchface: { watchfaceId: face.id } });
  }

  async install(file: ParsedFile, onProgress: (pct: number, stage: string) => void): Promise<void> {
    if (file.kind === 'unsupported') throw new Error(file.reason);
    if (this.busy) throw new Error(t('errBusy'));
    this.busy = true;
    try {
      if (file.kind === 'rpk') await this.installRpk(file, onProgress);
      else await this.installWatchface(file, onProgress);
    } finally {
      this.busy = false;
    }
  }

  private async installRpk(file: Extract<ParsedFile, { kind: 'rpk' }>, onProgress: (pct: number, stage: string) => void): Promise<void> {
    onProgress(0, t('stRequesting'));
    const reply = await this.request(
      { type: RPK, subtype: RPK_INSTALL, rpk: { rpkInfo: { id: file.id, unknown2: file.versionCode, size: file.bytes.length } } },
      (c) => c.type === RPK && c.subtype === RPK_INSTALL,
      t('whatAppInstall'),
    );
    const status = reply.rpk?.rpkInstallStart?.cmd ?? 0;
    if (status !== 0) throw new Error(t('errAppRejected', { status }));

    const installed = this.waitFor((c) => c.type === RPK && c.subtype === RPK_INSTALLED, t('whatInstallConfirm'), INSTALL_CONFIRM_TIMEOUT_MS);
    installed.catch(() => {}); // awaited below
    await this.upload(UPLOAD_TYPE_RPK, file.bytes, (p) => onProgress(p, t('stSending')));
    onProgress(100, t('stWaitInstall'));
    try {
      await installed;
    } catch {
      this.onLog('⚠ band sent no install confirmation — check the app list on the band');
    }
    await this.refreshApps();
  }

  private async installWatchface(file: Extract<ParsedFile, { kind: 'watchface' }>, onProgress: (pct: number, stage: string) => void): Promise<void> {
    onProgress(0, t('stRequesting'));
    const reply = await this.request(
      { type: WATCHFACE, subtype: WF_INSTALL, watchface: { watchfaceInstallStart: { id: file.id, size: file.bytes.length } } },
      (c) => c.type === WATCHFACE && c.subtype === WF_INSTALL,
      t('whatFaceInstall'),
    );
    const status = reply.watchface?.installStatus ?? 0;
    if (status === 2) throw new Error(t('errFaceExists'));
    if (status !== 0) throw new Error(t('errFaceRejected', { status }));
    await this.upload(UPLOAD_TYPE_WATCHFACE, file.bytes, (p) => onProgress(p, t('stSending')));
    onProgress(100, t('stSetFace'));
    await new Promise((r) => setTimeout(r, 1500));
    await this.setWatchface(file.id);
  }

  /** XiaomiDataUploadService: negotiate, then stream [0, type, md5, size, bytes, crc32] in parts. */
  private async upload(type: number, bytes: Uint8Array, onProgress: (pct: number) => void): Promise<void> {
    const md5sum = md5(bytes);
    const reply = await this.request(
      { type: DATA_UPLOAD, subtype: UPLOAD_START, dataUpload: { dataUploadRequest: { type, md5sum, size: bytes.length } } },
      (c) => c.type === DATA_UPLOAD && c.subtype === UPLOAD_START,
      t('whatUploadStart'),
    );
    const ack = reply.dataUpload?.dataUploadAck;
    if (!ack) throw new Error(t('errUploadInvalid'));
    if ((ack.errno ?? 0) !== 0) throw new Error(t('errUploadRefused', { errno: ack.errno ?? '?' }));
    const chunkSize = ack.chunkSize || 2048;
    const resume = ack.resumePosition ?? 0;
    this.onLog(`upload: chunk=${chunkSize}B, resume=${resume}, size=${bytes.length}B`);

    const body = concat(new Uint8Array([0, type & 0xff]), md5sum, u32le(bytes.length), bytes.subarray(resume));
    const payload = concat(body, u32le(crc32(body)));
    const partSize = chunkSize - 4;
    const total = Math.ceil(payload.length / partSize);
    for (let i = 0; i < total; i++) {
      if (!this.connected) throw new Error(t('errUploadLost'));
      const part = payload.subarray(i * partSize, (i + 1) * partSize);
      await this.link.sendData(concat(u16le(total), u16le(i + 1), part));
      onProgress(Math.round(((i + 1) * 100) / total));
    }
  }
}
