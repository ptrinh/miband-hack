import {
  ACCOUNT_NO_BOUND,
  accountErrorName,
  AUTH_COMMAND_TYPE,
  type AuthAttempt,
  AuthSession,
  type AuthVariant,
  CMD_AUTH,
  CMD_BIND_STATUS,
  CMD_NONCE,
  CMD_SEND_USERID,
  COMPANION_ANDROID,
  COMPANION_IOS,
  describeIdShape,
  planAuthAttempts,
} from './core/auth';
import { concat, hex, u16le, u32le } from './core/bytes';
import { crc32 } from './core/checksum';
import { md5 } from './core/crypto';
import type { ParsedFile } from './core/files';
import { type Command, decodeCommand, encodeCommand } from './core/proto';
import { deferred, type Link } from './protocol/link';
import { ActivityAssembler, checkFile, compareFileIds, encodeFileId, type FileId, fileIdKey, type HealthFile, parseFileIdList, sameFileId } from './health/files';
import { t } from './i18n';
import { watchfaceFaceCount } from './watchface/check';

// Command types / subtypes, from Gadgetbridge's Xiaomi*Service classes (AGPL-3.0).
const SYSTEM = 2;
const SYS_BATTERY = 1;
const SYS_DEVICE_INFO = 2;
const SYS_STORAGE = 62;
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
const RPK_LAUNCH = 4;
const HEALTH = 8;
const HEALTH_LIST_TODAY = 1;
const HEALTH_LIST_PAST = 2;
const HEALTH_FETCH_FILE = 3;
const HEALTH_ACK_FILE = 5;
const DATA_UPLOAD = 22;
const UPLOAD_START = 0;
const UPLOAD_TYPE_WATCHFACE = 16;
const UPLOAD_TYPE_RPK = 64;

// Long enough to accept the pairing prompt the band shows on a first BLE connection and to try every
// handshake variant.
const AUTH_TIMEOUT_MS = 120_000;
// A step-1 attempt the band does not answer at all; one that may show a prompt on the band gets longer.
const AUTH_ATTEMPT_TIMEOUT_MS = 10_000;
const AUTH_PROMPT_ATTEMPT_TIMEOUT_MS = 30_000;
const BIND_STATUS_TIMEOUT_MS = 3_000;
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
  /** Bytes, from GET_STORAGE_INFO. */
  storage?: { used: number; total: number };
}
export interface InstalledApp { id: string; name: string; sha?: Uint8Array }
export interface InstalledFace { id: string; name: string; active: boolean; canDelete: boolean }

interface Waiter {
  match: (c: Command) => boolean;
  resolve: (c: Command) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ConnectOptions {
  /** Which step-1 shapes to try (see planAuthAttempts); `auto` tries them all. */
  authVariant?: AuthVariant;
  /** CompanionDevice.device_type in step 2; `auto` = iOS over BLE when a Device ID is set, else Android. */
  companion?: 'auto' | 'android' | 'ios';
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

  private attempts: AuthAttempt[] = [];
  private attemptIdx = 0;
  private attemptTimer: ReturnType<typeof setTimeout> | null = null;
  private authStarted = false;
  private sessionDeviceType: number | undefined = undefined;
  private bindStatusProbe: ReturnType<typeof deferred<void>> | null = null;
  private bindStatusProbed = false;
  /** The step-1 variant the band accepted. */
  authVariantUsed: string | null = null;

  constructor(readonly link: Link, authKey: Uint8Array, deviceId = '', opts: ConnectOptions = {}) {
    this.auth = new AuthSession(authKey, true, deviceId);
    const companion = opts.companion ?? 'auto';
    this.auth.companionType =
      companion === 'ios' || (companion === 'auto' && link.overBle && !!deviceId.trim()) ? COMPANION_IOS : COMPANION_ANDROID;
    this.authDone.promise.catch(() => {}); // observed in connect(); avoid unhandled rejection on later disconnects
    link.log = (m) => this.onLog(m);
    link.onCommand = (b) => this.handleBytes(b);
    link.onActivity = (b) => this.handleActivity(b);
    link.onReadyForAuth = () => {
      if (!this.authStarted) {
        this.authStarted = true;
        // Planned here: an SPP link only knows whether it speaks V2 (and can restart its session) by now.
        this.attempts = planAuthAttempts(deviceId, opts.authVariant ?? 'auto', !!link.restartSession && link.name.endsWith('V2'));
        this.onLog('→ starting authentication');
        this.onLog(
          `  Device ID: ${deviceId.trim() ? `entered (${describeIdShape(deviceId.trim())})` : 'none entered'}; ` +
            `${this.attempts.length} step-1 variant(s): ${this.attempts.map((a) => a.id).join(', ')}`,
        );
        this.onLog(t('authAcceptOnBand'));
      }
      this.sendAttempt();
    };
    link.onClose = () => {
      this.connected = false;
      this.clearAttemptTimer();
      this.authDone.reject(new Error(t('errConnLost')));
      this.waiters.forEach((w) => w.reject(new Error(t('errConnLost'))));
      this.waiters = [];
      this.fileWaiter?.reject(new Error(t('errConnLost')));
      this.onDisconnect();
    };
  }

  // ---------------------------------------------------------------- auth ---

  private clearAttemptTimer(): void {
    if (this.attemptTimer) clearTimeout(this.attemptTimer);
    this.attemptTimer = null;
  }

  /** Sends step 1 for the current attempt, restarting the session first if the attempt needs another one. */
  private sendAttempt(): void {
    const a = this.attempts[this.attemptIdx];
    if (!a || this.authVariantUsed) return;
    if (a.sessionDeviceType !== this.sessionDeviceType) {
      this.sessionDeviceType = a.sessionDeviceType;
      this.onLog(`→ restarting the session${a.sessionDeviceType === undefined ? '' : ` with device type ${a.sessionDeviceType}`}`);
      this.link.restartSession!(a.sessionDeviceType).catch((e) => this.authDone.reject(e));
      return; // onReadyForAuth comes back here
    }
    const bytes = encodeCommand(this.auth.buildNonceCommand(a));
    const n = this.attempts.length;
    this.onLog(
      `→ auth step 1 [${this.attemptIdx + 1}/${n} ${a.id}]: nonce 16 B, ` +
        `app_device_id ${a.deviceId ? `sent (${describeIdShape(a.deviceId)})` : 'not sent'}, ` +
        `check_dynamic_code ${a.checkDynamicCode ? 'true' : 'not sent'}, ` +
        `session device type ${this.sessionDeviceType ?? 'not sent'}; ${bytes.length} B protobuf, channel 1, unencrypted`,
    );
    if (a.checkDynamicCode && this.attemptIdx > 0) this.onLog(t('authAcceptOnBand'));
    this.clearAttemptTimer();
    // The first attempt may wait for the band's pairing prompt; a dynamic code may wait for a press on the band.
    const wait = a.checkDynamicCode || this.attemptIdx === 0 ? AUTH_PROMPT_ATTEMPT_TIMEOUT_MS : AUTH_ATTEMPT_TIMEOUT_MS;
    this.attemptTimer = setTimeout(() => {
      this.onLog(`⚠ no reply to auth step 1 [${a.id}] within ${wait / 1000} s`);
      this.nextAttempt(t('errAuthTimeout'));
    }, wait);
    this.link.sendCommand(bytes, true).catch((e) => this.authDone.reject(e));
  }

  private nextAttempt(lastError: string): void {
    this.clearAttemptTimer();
    if (++this.attemptIdx < this.attempts.length) {
      this.sendAttempt();
      return;
    }
    this.authDone.reject(new Error(lastError));
  }

  /** Asks the band whether it considers itself bound (read-only); logs the answer, if any. */
  private async probeBindStatus(): Promise<void> {
    this.bindStatusProbed = true;
    const probe = deferred<void>();
    this.bindStatusProbe = probe;
    this.onLog('→ asking the band for its bind status (Account subtype 0, read-only)');
    const timer = setTimeout(() => {
      this.onLog(`  no bind status reply within ${BIND_STATUS_TIMEOUT_MS / 1000} s`);
      probe.resolve();
    }, BIND_STATUS_TIMEOUT_MS);
    try {
      await this.send({ type: AUTH_COMMAND_TYPE, subtype: CMD_BIND_STATUS });
      await probe.promise;
    } finally {
      clearTimeout(timer);
      this.bindStatusProbe = null;
    }
  }

  async connect(): Promise<void> {
    const timer = setTimeout(() => this.authDone.reject(new Error(t('errAuthTimeout'))), AUTH_TIMEOUT_MS);
    try {
      await this.link.start();
      await this.authDone.promise;
    } finally {
      clearTimeout(timer);
      this.clearAttemptTimer();
    }
    this.connected = true;
    this.onLog('✓ authenticated');
    // A Mi Band 8 leaves every app (.rpk) command unanswered; asking for its app list only costs a timeout.
    const apps = this.isBand8 ? Promise.resolve() : this.refreshApps();
    await Promise.allSettled([this.refreshInfo(), apps, this.refreshFaces()]);
    // not awaited: older firmware may never answer GET_STORAGE_INFO
    void this.refreshStorage().catch(() => {});
  }

  /** Mi Band 8, not the Pro: firmware 2.3.14 answered no app (.rpk) command, list or install (2026-10-26). */
  get isBand8(): boolean {
    return /Band 8(?! Pro)/i.test(this.link.deviceName ?? '');
  }

  /** An install or another long transfer is running. */
  get isBusy(): boolean {
    return this.busy;
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
    let handled = this.handlePassive(cmd);
    for (const w of [...this.waiters]) {
      if (w.match(cmd)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(cmd);
        handled = true;
      }
    }
    if (!handled) this.onLog(`← unhandled command type ${cmd.type} subtype ${cmd.subtype} (${bytes.length} B: ${hex(bytes, 32)})`);
  }

  private handleAuth(cmd: Command, raw: Uint8Array): void {
    // Raw auth replies carry nonces, HMACs and status codes only: no key material.
    if (cmd.subtype === CMD_BIND_STATUS) {
      const err = cmd.auth?.errorCode;
      this.onLog(
        `← bind status: ${cmd.auth?.bindStatus === undefined ? '—' : `bind_status=${cmd.auth.bindStatus}`}` +
          `${err === undefined ? '' : `, error_code ${accountErrorName(err)}`} (raw ${hex(raw, 64)})`,
      );
      this.bindStatusProbe?.resolve();
      return;
    }
    if (cmd.subtype === CMD_NONCE) {
      const a = this.attempts[this.attemptIdx];
      const dv = cmd.auth?.deviceVerify;
      if (!dv) {
        this.clearAttemptTimer();
        const err = cmd.auth?.errorCode;
        const status = err !== undefined ? accountErrorName(err) : String(cmd.auth?.status ?? cmd.status ?? '?');
        this.onLog(`← refused [${a?.id ?? '?'}]: ${err !== undefined ? `error_code ${status}` : `status ${status}`} (raw ${raw.length} B: ${hex(raw, 64)})`);
        const message = t('errHandshake', { status }) + (err === ACCOUNT_NO_BOUND ? ` ${t('errNoBound')}` : '');
        if (err === ACCOUNT_NO_BOUND && !this.bindStatusProbed && this.attemptIdx + 1 < this.attempts.length) {
          void this.probeBindStatus().then(() => this.nextAttempt(message));
        } else {
          this.nextAttempt(message);
        }
        return;
      }
      this.clearAttemptTimer();
      this.authVariantUsed = a?.id ?? '?';
      this.onLog(`← watch nonce received: the band accepted step 1 variant [${this.authVariantUsed}]`);
      try {
        const step2 = this.auth.handleWatchNonce(dv.nonce, dv.hmac);
        this.onLog(`→ auth step 2: companion device_type ${this.auth.companionType === COMPANION_IOS ? 'iOS (1)' : 'Android (0)'}`);
        void this.send(step2);
      } catch (e) {
        this.authDone.reject(e);
        void this.link.close();
      }
    } else if (cmd.subtype === CMD_AUTH) {
      const err = cmd.auth?.errorCode;
      if ((err !== undefined && err !== 0) || cmd.auth?.authStep4?.unknown1 === false) {
        const status = err !== undefined ? accountErrorName(err) : 'confirm_result=false';
        this.onLog(`← auth step 2 refused: ${status} (raw ${raw.length} B: ${hex(raw, 64)})`);
        this.authDone.reject(new Error(t('errHandshake', { status })));
        return;
      }
      this.onLog(`← auth step 2 accepted (variant [${this.authVariantUsed}], companion ${this.auth.companionType === COMPANION_IOS ? 'iOS' : 'Android'})`);
      this.auth.encryptionInitialized = true;
      this.link.auth = this.auth;
      this.link.onAuthSuccess();
      this.authDone.resolve();
    } else if (cmd.subtype === CMD_SEND_USERID) {
      this.authDone.reject(new Error(t('errLegacy')));
    }
  }

  /** Returns false when the command is none of the ones the band sends on its own. */
  private handlePassive(cmd: Command): boolean {
    if (cmd.type === SYSTEM && cmd.subtype === SYS_DEVICE_INFO && cmd.system?.deviceInfo) {
      const d = cmd.system.deviceInfo;
      Object.assign(this.info, { model: d.model, firmware: d.firmware, serial: d.serialNumber });
      this.onChange();
      return true;
    } else if (cmd.type === SYSTEM && cmd.subtype === SYS_STORAGE && cmd.system?.storageInfo) {
      // uint64: a plain number or a Long, depending on whether protobufjs found the long package
      const n = (v: unknown) => Number(typeof v === 'object' && v ? String(v) : v ?? 0);
      this.info.storage = { used: n(cmd.system.storageInfo.used), total: n(cmd.system.storageInfo.total) };
      this.onChange();
      return true;
    } else if (cmd.type === SYSTEM && cmd.subtype === SYS_BATTERY && cmd.system?.power?.battery) {
      this.info.battery = cmd.system.power.battery.level;
      this.onChange();
      return true;
    } else if (cmd.type === RPK && cmd.subtype === RPK_LIST) {
      this.apps = (cmd.rpk?.rpkList?.rpkInfo ?? []).map((r) => ({ id: r.id ?? '', name: r.name || r.id || '?', sha: r.sha }));
      this.onChange();
      return true;
    } else if (cmd.type === WATCHFACE && cmd.subtype === WF_LIST) {
      this.faces = (cmd.watchface?.watchfaceList?.watchface ?? []).map((w) => ({
        id: w.id ?? '',
        name: w.name || w.id || '?',
        active: !!w.active,
        canDelete: !!w.canDelete,
      }));
      this.onChange();
      return true;
    } else if (cmd.type === RPK && (cmd.subtype === RPK_INSTALLED || cmd.subtype === RPK_DELETE)) {
      void this.refreshApps();
      return true;
    } else if (cmd.type === WATCHFACE && cmd.subtype === WF_DELETE) {
      void this.refreshFaces();
      return true;
    }
    return false;
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

  refreshStorage(): Promise<Command> {
    return this.request({ type: SYSTEM, subtype: SYS_STORAGE }, (c) => c.type === SYSTEM && c.subtype === SYS_STORAGE, t('whatStorage'));
  }

  refreshApps(): Promise<Command> {
    return this.request({ type: RPK, subtype: RPK_LIST }, (c) => c.type === RPK && c.subtype === RPK_LIST, t('whatApps'));
  }

  refreshFaces(): Promise<Command> {
    return this.request({ type: WATCHFACE, subtype: WF_LIST }, (c) => c.type === WATCHFACE && c.subtype === WF_LIST, t('whatFaces'));
  }

  // ------------------------------------------------------------- actions ---

  /** Opens an installed app on the band (no reply is sent). */
  async launchApp(app: InstalledApp, uri = ''): Promise<void> {
    await this.send({ type: RPK, subtype: RPK_LAUNCH, rpk: { rpkLaunch: { app: { id: app.id, sha: app.sha }, uri } } });
  }

  async deleteApp(app: InstalledApp): Promise<void> {
    this.onLog(`→ deleting app ${app.id}`);
    await this.send({ type: RPK, subtype: RPK_DELETE, rpk: { rpkDel: { id: app.id, sha: app.sha } } });
    // the band usually sends no reply to a delete
    await new Promise((r) => setTimeout(r, 800));
    await this.refreshApps();
  }

  /** Deletes every quick app, then reports the free space again. */
  async deleteAllApps(onProgress: (done: number, total: number) => void): Promise<void> {
    const apps = [...this.apps];
    for (const [i, app] of apps.entries()) {
      this.onLog(`→ deleting app ${app.id}`);
      await this.send({ type: RPK, subtype: RPK_DELETE, rpk: { rpkDel: { id: app.id, sha: app.sha } } });
      await new Promise((r) => setTimeout(r, 800));
      onProgress(i + 1, apps.length);
    }
    await this.refreshApps();
    await this.refreshStorage().catch(() => {});
  }

  /** Deletes every watchface the band lets us delete, except the active one. */
  async deleteAllFaces(onProgress: (done: number, total: number) => void): Promise<void> {
    const faces = this.faces.filter((f) => f.canDelete && !f.active);
    for (const [i, face] of faces.entries()) {
      this.onLog(`→ deleting watchface ${face.id}`);
      await this.send({ type: WATCHFACE, subtype: WF_DELETE, watchface: { watchfaceId: face.id } });
      await new Promise((r) => setTimeout(r, 800));
      onProgress(i + 1, faces.length);
    }
    await this.refreshFaces();
    await this.refreshStorage().catch(() => {});
  }

  /**
   * Marks every recorded health file as synced without downloading it, so the band can drop it.
   * Data the official app has not synced yet is lost.
   */
  async clearHealthFiles(): Promise<number> {
    if (this.busy) throw new Error(t('errBusy'));
    this.busy = true;
    try {
      const lists = await Promise.allSettled([this.listHealthFiles(HEALTH_LIST_TODAY), this.listHealthFiles(HEALTH_LIST_PAST)]);
      if (lists.every((l) => l.status === 'rejected')) throw (lists[0] as PromiseRejectedResult).reason;
      const seen = new Map<string, FileId>();
      for (const l of lists) if (l.status === 'fulfilled') for (const id of l.value) seen.set(fileIdKey(id), id);
      this.onLog(`health: acknowledging ${seen.size} files`);
      for (const id of seen.values()) {
        await this.send({ type: HEALTH, subtype: HEALTH_ACK_FILE, health: { activitySyncAckFileIds: encodeFileId(id) } });
      }
      return seen.size;
    } finally {
      this.busy = false;
    }
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
    ).catch((e: Error) => {
      if (this.isBand8) throw new Error(`${e.message}. ${t('errBand8Apps')}`);
      throw e;
    });
    const status = reply.rpk?.rpkInstallStart?.cmd ?? 0;
    if (status !== 0) throw new Error(t('errAppRejected', { status }));

    const installed = this.waitFor((c) => c.type === RPK && c.subtype === RPK_INSTALLED, t('whatInstallConfirm'), INSTALL_CONFIRM_TIMEOUT_MS);
    installed.catch(() => {}); // awaited below
    await this.upload(UPLOAD_TYPE_RPK, file.bytes, (p) => onProgress(p, t('stSending')));
    onProgress(100, t('stWaitInstall'));
    let result: Command | undefined;
    try {
      result = await installed;
    } catch {
      this.onLog('⚠ band sent no install confirmation — check the app list on the band');
    }
    const code = result?.rpk?.rpkInstallResult?.code ?? 0;
    if (code === 2) throw new Error(t('errAppVerify'));
    if (code !== 0) throw new Error(t('errAppRejected', { status: code }));
    await this.refreshApps();
  }

  private async installWatchface(file: Extract<ParsedFile, { kind: 'watchface' }>, onProgress: (pct: number, stage: string) => void): Promise<void> {
    // A Mi Band 8 stopped booting after a face without the always-on (AOD) face (2026-10-26).
    if (this.isBand8 && watchfaceFaceCount(file.bytes) !== 2) throw new Error(t('errFaceNoAod'));
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
    // chunkSize covers the whole part: the link's own header (channel + opcode on SPP, as in AstroBox; none on
    // BLE V1, as in Gadgetbridge) and total + part numbers (4).
    const partSize = chunkSize - 4 - (this.link.uploadPartOverhead ?? 2);
    const total = Math.ceil(payload.length / partSize);
    for (let i = 0; i < total; i++) {
      if (!this.connected) throw new Error(t('errUploadLost'));
      const part = payload.subarray(i * partSize, (i + 1) * partSize);
      await this.link.sendData(concat(u16le(total), u16le(i + 1), part));
      onProgress(Math.round(((i + 1) * 100) / total));
    }
  }
}
