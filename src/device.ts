import { AUTH_COMMAND_TYPE, AuthSession, CMD_AUTH, CMD_NONCE, CMD_SEND_USERID } from './core/auth';
import { concat, hex, u16le, u32le } from './core/bytes';
import { crc32 } from './core/checksum';
import { md5 } from './core/crypto';
import type { ParsedFile } from './core/files';
import { type Command, decodeCommand, encodeCommand } from './core/proto';
import { deferred, type Link } from './protocol/link';
import { ActivityAssembler, checkFile, compareFileIds, encodeFileId, type FileId, fileIdKey, type HealthFile, parseFileIdList, sameFileId } from './health/files';
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
const HEALTH = 8;
const HEALTH_LIST_TODAY = 1;
const HEALTH_LIST_PAST = 2;
const HEALTH_FETCH_FILE = 3;
const HEALTH_ACK_FILE = 5;
const DATA_UPLOAD = 22;
const UPLOAD_START = 0;
const UPLOAD_TYPE_WATCHFACE = 16;
const UPLOAD_TYPE_RPK = 64;

// Long enough to accept the pairing prompt the band shows on a first BLE connection.
const AUTH_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 15_000;
const INSTALL_CONFIRM_TIMEOUT_MS = 90_000;
// Gadgetbridge gives up on a file after 5 s without a chunk; a little more slack for Web Serial.
const FILE_CHUNK_TIMEOUT_MS = 10_000;

export interface HealthFetchOptions {
  /** Unix seconds; files that start after `to` or more than a day and a half before `from` are skipped. */
  from?: number;
  to?: number;
  /**
   * Tell the band each file was synced. Off by default: the band may then delete the file and the
   * official app would not get it any more.
   */
  ack?: boolean;
}

export interface HealthFetchResult {
  files: HealthFile[];
  /** Ids the band listed but did not deliver intact. */
  failed: { id: FileId; reason: string }[];
  listed: number;
}

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
  /** How long to wait for the next chunk of a health file before giving up on it. */
  healthFileTimeoutMs = FILE_CHUNK_TIMEOUT_MS;

  onChange: () => void = () => {};
  onLog: (msg: string) => void = () => {};
  onDisconnect: () => void = () => {};

  private readonly auth: AuthSession;
  private authDone = deferred();
  private waiters: Waiter[] = [];
  private busy = false;
  private readonly activity = new ActivityAssembler();
  private fileWaiter: { resolve: (b: Uint8Array) => void; reject: (e: unknown) => void; poke: () => void } | null = null;

  constructor(readonly link: Link, authKey: Uint8Array, deviceId = '') {
    this.auth = new AuthSession(authKey, true, deviceId);
    this.authDone.promise.catch(() => {}); // observed in connect(); avoid unhandled rejection on later disconnects
    link.log = (m) => this.onLog(m);
    link.onCommand = (b) => this.handleBytes(b);
    link.onActivity = (b) => this.handleActivity(b);
    link.onReadyForAuth = () => {
      this.onLog('→ starting authentication');
      this.onLog(t('authAcceptOnBand'));
      void this.send(this.auth.buildNonceCommand());
    };
    link.onClose = () => {
      this.connected = false;
      this.authDone.reject(new Error(t('errConnLost')));
      this.waiters.forEach((w) => w.reject(new Error(t('errConnLost'))));
      this.waiters = [];
      this.fileWaiter?.reject(new Error(t('errConnLost')));
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
      this.handleAuth(cmd, bytes);
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

  private handleAuth(cmd: Command, raw: Uint8Array): void {
    if (cmd.subtype === CMD_NONCE) {
      const dv = cmd.auth?.deviceVerify;
      if (!dv) {
        // The raw reply (no key material: nonces and status codes only) tells why the band refused.
        this.onLog(`← auth reply without a watch nonce (${raw.length} bytes): ${hex(raw, 64)}`);
        this.authDone.reject(new Error(t('errHandshake', { status: cmd.auth?.refusal ?? cmd.auth?.status ?? cmd.status ?? '?' })));
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

  private handleActivity(chunk: Uint8Array): void {
    try {
      this.fileWaiter?.poke();
      const file = this.activity.push(chunk);
      if (file) this.fileWaiter?.resolve(file);
    } catch (e) {
      this.onLog(`⚠ activity data: ${(e as Error).message}`);
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

  // ---------------------------------------------------------- health data ---

  private async listHealthFiles(subtype: number): Promise<FileId[]> {
    const cmd = subtype === HEALTH_LIST_TODAY
      ? { type: HEALTH, subtype, health: { activitySyncRequestToday: { unknown1: 0 } } }
      : { type: HEALTH, subtype };
    const reply = await this.request(cmd, (c) => c.type === HEALTH && c.subtype === subtype, t('whatHealthList'));
    return parseFileIdList(reply.health?.activityRequestFileIds);
  }

  /** Resolves with the next complete file on the activity channel; times out when chunks stop coming. */
  private nextActivityFile(): Promise<Uint8Array> {
    this.activity.reset();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        this.fileWaiter = null;
      };
      const poke = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          done();
          reject(new Error(t('errNoReply', { what: t('whatHealthFile') })));
        }, this.healthFileTimeoutMs);
      };
      this.fileWaiter = {
        resolve: (b) => (done(), resolve(b)),
        reject: (e) => (done(), reject(e)),
        poke,
      };
      poke();
    });
  }

  /**
   * XiaomiHealthService / XiaomiActivityFileFetcher: list today's and past recorded files, then
   * request them one by one; each arrives on the activity channel as `id | 00 | body | crc32`.
   */
  async fetchHealth(opts: HealthFetchOptions, onProgress: (done: number, total: number) => void): Promise<HealthFetchResult> {
    if (this.busy) throw new Error(t('errBusy'));
    this.busy = true;
    try {
      const lists = await Promise.allSettled([this.listHealthFiles(HEALTH_LIST_TODAY), this.listHealthFiles(HEALTH_LIST_PAST)]);
      if (lists.every((l) => l.status === 'rejected')) throw (lists[0] as PromiseRejectedResult).reason;
      const seen = new Map<string, FileId>();
      for (const l of lists) if (l.status === 'fulfilled') for (const id of l.value) seen.set(fileIdKey(id), id);
      const listed = seen.size;
      const ids = [...seen.values()]
        .filter((id) => (opts.to === undefined || id.ts <= opts.to) && (opts.from === undefined || id.ts >= opts.from - 36 * 3600))
        .sort(compareFileIds);
      this.onLog(`health: band lists ${listed} files, fetching ${ids.length}`);

      const result: HealthFetchResult = { files: [], failed: [], listed };
      onProgress(0, ids.length);
      for (const [i, id] of ids.entries()) {
        if (!this.connected) throw new Error(t('errConnLost'));
        try {
          const file = this.nextActivityFile();
          file.catch(() => {}); // awaited below
          await this.send({ type: HEALTH, subtype: HEALTH_FETCH_FILE, health: { activityRequestFileIds: encodeFileId(id) } });
          const bytes = await file;
          const got = checkFile(bytes);
          if (!sameFileId(got, id)) throw new Error(`band sent ${fileIdKey(got)} instead of ${fileIdKey(id)}`);
          result.files.push({ id, bytes });
          if (opts.ack) await this.send({ type: HEALTH, subtype: HEALTH_ACK_FILE, health: { activitySyncAckFileIds: encodeFileId(id) } });
        } catch (e) {
          this.onLog(`⚠ health file ${fileIdKey(id)}: ${(e as Error).message}`);
          result.failed.push({ id, reason: (e as Error).message });
        }
        onProgress(i + 1, ids.length);
      }
      return result;
    } finally {
      this.busy = false;
    }
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
