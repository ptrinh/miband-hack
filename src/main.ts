import './style.css';
import { AUTH_VARIANTS, type AuthVariant, parseAuthKey } from './core/auth';
import { type ParsedFile, parseFile } from './core/files';
import { setIosSessionProfile } from './core/packets';
import { type ConnectOptions, type InstalledApp, type InstalledFace, XiaomiDevice } from './device';
import { BleV1Link } from './protocol/ble-v1-link';
import type { Link } from './protocol/link';
import { StreamLink } from './protocol/stream-link';
import { requestBle, webBluetoothAvailable } from './transport/ble';
import { SerialTransport, webSerialAvailable } from './transport/serial';
import { BridgeTransport } from './transport/bridge';

// The Mac helper is a developer tool: offer it only on a locally served page, not on miband.trinh.uk.
const SHOW_BRIDGE = ['localhost', '127.0.0.1'].includes(location.hostname);
// The Band 8 face builder bricked a band on its first real install (2026-10-26: a face without the AOD face),
// so it stays a local developer tool until a build of it is proven on a band.
const SHOW_FACE_MAKER = SHOW_BRIDGE;
import { applyI18n, getLang, LANGS, pick, setLang, t } from './i18n';
import { buildChecklistRpk, buildFlashcardsRpk, buildNotesRpk, customVersionCode, type Note } from './rpk';
import { bindImport, downloadJson, loadStored, saveStored } from './custom-editor';
import { checklistsForBand, mountChecklist, renderChecklistEditor } from './checklist/ui';
import { mountHealth, renderHealth } from './health/ui';
import { decksForInstall, mountDecksEditor, renderDecksEditor } from './decks/ui';
import { buildBand8Face } from './watchface/band8';
import { STORAGE_RESERVE } from './device';
import { renderBand8Face } from './watchface/render';


const KEY_STORAGE = 'miband-hack.authkey';

// Static shell only — every value coming from the band or a file is set via textContent.
// Translatable text is filled in by applyI18n() from data-i18n* attributes.
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<div class="wrap">
  <header class="hero">
    <div class="brand">
      <img class="logo" src="logo.svg" width="56" height="56" alt="" />
      <h1>MiBand Hack<small data-i18n="subtitle"></small></h1>
    </div>
    <div class="row">
      <button class="small hidden" id="btn-install-app" data-i18n="installApp"></button>
      <div class="lang-switch" id="lang-switch" role="group" aria-label="Language"></div>
      <span class="tag">Mi Band 8 · 9 · 10 · 11 · Chrome / Edge</span>
      <a class="tag" href="https://github.com/ptrinh/miband-hack/" target="_blank" rel="noopener">GitHub</a>
    </div>
  </header>

  <div class="banner err" role="alert" data-i18n-html="brickWarning"></div>
  <div id="support"></div>

  <div class="grid">
    <section class="card" id="card-key">
      <h2><span class="step">1</span><span data-i18n="keyTitle"></span><span class="card-sum" id="sum-key"></span></h2>
      <label for="authkey" data-i18n="keyLabel"></label>
      <input id="authkey" type="text" placeholder="0x0123456789abcdef0123456789abcdef" autocomplete="off" spellcheck="false" />
      <label for="deviceid" style="font-weight:400;color:var(--muted)" data-i18n="deviceIdLabel"></label>
      <input id="deviceid" type="text" autocomplete="off" spellcheck="false" data-i18n-placeholder="deviceIdPh" />
      <label class="check"><input type="checkbox" id="remember" /> <span data-i18n="remember"></span></label>

      <button class="primary" id="btn-qr" style="margin-top:14px;width:100%" data-i18n="qrBtn"></button>
      <div id="qr-panel" class="qr-panel hidden">
        <div class="qr-box"><img id="qr-img" data-i18n-alt="qrAlt" /></div>
        <ol class="qr-steps">
          <li data-i18n-html="qrStep1"></li>
          <li data-i18n="qrStep2"></li>
          <li data-i18n="qrStep3"></li>
        </ol>
        <p class="hint" id="qr-noscan" data-i18n-html="qrNoScan"></p>
        <div class="row" style="margin-top:8px">
          <label for="qr-server" style="margin:0;font-weight:400;color:var(--muted)" data-i18n="region"></label>
          <select id="qr-server">
            <option value="" data-i18n="regAuto"></option>
            <option value="sg" data-i18n="regSg"></option>
            <option value="de" data-i18n="regDe"></option>
            <option value="us" data-i18n="regUs"></option>
            <option value="cn" data-i18n="regCn"></option>
            <option value="i2" data-i18n="regI2"></option>
            <option value="in" data-i18n="regIn"></option>
            <option value="ru" data-i18n="regRu"></option>
            <option value="tw" data-i18n="regTw"></option>
          </select>
          <button class="small ghost" id="btn-qr-cancel" style="margin-left:auto" data-i18n="cancel"></button>
        </div>
        <p class="progress-label" id="qr-status"></p>
      </div>
      <ul class="list hidden" id="cloud-devices" style="margin-top:10px"></ul>
      <p class="hint" data-i18n="privacyNote"></p>

      <details id="other-ways">
        <summary data-i18n="otherWays"></summary>
        <p data-i18n="otherP1"></p>
        <h4 data-i18n="iosTitle"></h4>
        <ol>
          <li data-i18n-html="iosStep1"></li>
          <li data-i18n-html="iosStep2"></li>
          <li data-i18n-html="iosStep3"></li>
        </ol>
        <label for="mf-files" data-i18n="iosPick"></label>
        <!-- No accept filter: iOS greys out manifest.sqlite-wal (no UTI for that extension). The reader checks the content. -->
        <input type="file" id="mf-files" multiple />
        <ul class="list hidden" id="mf-keys" style="margin-top:10px"></ul>
        <p class="hint" data-i18n="iosPrivacy"></p>
        <h4 data-i18n="androidTitle"></h4>
        <ol>
          <li data-i18n-html="androidStep1"></li>
          <li data-i18n-html="androidStep2"></li>
          <li data-i18n-html="androidStep3"></li>
        </ol>
        <ul>
          <li data-i18n-html="otherLi1"></li>
          <li data-i18n="otherLi2"></li>
        </ul>
        <p data-i18n="otherP2"></p>
      </details>
    </section>

    <section class="card" id="card-connect">
      <h2><span class="step">2</span><span data-i18n="connTitle"></span><span class="card-sum" id="sum-connect"></span></h2>
      <div class="connect-opts">
        <button class="connect-opt primary" id="btn-ble"><span data-i18n="bleBtn" style="color:inherit;font-weight:600;font-size:14px"></span><span data-i18n="bleSub" style="color:inherit;opacity:.85"></span></button>
        <button class="connect-opt" id="btn-spp"><span data-i18n="sppBtn" style="color:inherit;font-weight:600;font-size:14px"></span><span data-i18n="sppSub"></span></button>
        <button class="connect-opt hidden" id="btn-bridge"><span data-i18n="bridgeBtn" style="color:inherit;font-weight:600;font-size:14px"></span><span data-i18n-html="bridgeSub"></span></button>
      </div>
      <details>
        <summary data-i18n="beforeConnect"></summary>
        <ol>
          <li data-i18n-html="before1"></li>
          <li data-i18n-html="before2"></li>
          <li data-i18n-html="before3"></li>
          <li data-i18n-html="before4"></li>
          <li data-i18n-html="before5"></li>
          <li data-i18n-html="before6"></li>
          <li data-i18n-html="before7"></li>
        </ol>
        <label for="auth-variant" style="font-weight:400;color:var(--muted)" data-i18n="authVariantLabel"></label>
        <select id="auth-variant">
          <option value="auto" data-i18n="authVariantAuto"></option>
          <option value="nonce" data-i18n="authVariantNonce"></option>
          <option value="id" data-i18n="authVariantId"></option>
          <option value="uuid" data-i18n="authVariantUuid"></option>
          <option value="code" data-i18n="authVariantCode"></option>
          <option value="l1-ios" data-i18n="authVariantL1Ios"></option>
        </select>
      </details>
    </section>

    <section class="card span-2 hidden" id="card-device">
      <h2><span class="dot" id="dot"></span><span id="device-title"></span></h2>
      <div class="device">
        <div class="stat"><b id="d-model">—</b><span data-i18n="model"></span></div>
        <div class="stat"><b id="d-fw">—</b><span data-i18n="firmware"></span></div>
        <div class="stat"><b id="d-batt">—</b><span data-i18n="battery"></span></div>
        <div class="stat"><b id="d-link">—</b><span data-i18n="protocol"></span></div>
        <div class="stat"><b id="d-storage">—</b><span data-i18n="storageFree"></span></div>
      </div>
      <div class="row cleanup">
        <button class="small" id="btn-disconnect" data-i18n="disconnect"></button>
        <button class="small ghost" id="btn-storage" data-i18n="storageRefresh"></button>
        <button class="small ghost" id="btn-del-apps" data-i18n="delAllApps"></button>
        <button class="small ghost" id="btn-del-faces" data-i18n="delAllFaces"></button>
        <button class="small ghost" id="btn-clear-health" data-i18n="clearHealth"></button>
        <span class="progress-label" id="cleanup-status" style="margin:0"></span>
      </div>
    </section>

    <section class="card span-2" id="card-catalog">
      <h2><span class="step">3</span><span data-i18n="catalogTitle"></span><span class="card-sum" id="sum-catalog"></span></h2>
      <ul class="list catalog" id="catalog"><li class="empty" data-i18n="catalogLoading"></li></ul>
      <p class="hint" data-i18n="catalogTap"></p>
      <div id="notes-editor" class="notes-editor hidden">
        <p class="hint" data-i18n="notesHint"></p>
        <div id="notes-list"></div>
        <div class="row notes-actions">
          <button class="small" id="btn-note-add" data-i18n="notesAdd"></button>
          <button class="small ghost" id="btn-notes-export" data-i18n="notesExport"></button>
          <button class="small ghost" id="btn-notes-import" data-i18n="notesImport"></button>
          <input type="file" id="notes-file" accept=".json,application/json" class="hidden" />
          <span class="progress-label" id="notes-saved" style="margin:0 0 0 auto"></span>
        </div>
      </div>
      <div id="checklist-editor" class="notes-editor hidden"></div>
      <div id="decks-editor" class="notes-editor deck-editor hidden"></div>
      <p class="hint" id="catalog-hint" data-i18n-html="catalogHint"></p>
    </section>

    <section class="card span-2" id="card-install">
      <h2><span class="step">4</span><span data-i18n="fileTitle"></span><span class="card-sum" id="sum-install"></span></h2>
      <div class="drop" id="drop" tabindex="0" role="button">
        <span data-i18n-html="dropMain"></span><br />
        <small data-i18n="dropSub"></small>
      </div>
      <input type="file" id="file" accept=".rpk,.bin,.face,application/zip,application/octet-stream" class="hidden" />
      <div id="file-info" class="hidden">
        <div class="file">
          <div class="ph" id="f-icon">FILE</div>
          <div class="meta"><b id="f-name"></b><span id="f-sub"></span></div>
          <button class="primary" id="btn-install" disabled data-i18n="install"></button>
        </div>
        <div class="progress hidden" id="progress"><div id="progress-bar"></div></div>
        <div class="progress-label" id="progress-label"></div>
      </div>
    </section>

    <section class="card span-2" id="card-face">
      <h2><span data-i18n="faceTitle"></span></h2>
      <div class="face-maker">
        <canvas id="face-canvas" width="192" height="490"></canvas>
        <div class="face-form">
          <label><span data-i18n="faceText"></span><input type="text" id="face-text" maxlength="40" value="KHOI TRINH" /></label>
          <label><span data-i18n="faceAccent"></span><input type="color" id="face-accent" value="#ffb02e" /></label>
          <div class="row">
            <button class="primary" id="btn-face-install" disabled data-i18n="faceInstall"></button>
            <button class="small ghost" id="btn-face-download" data-i18n="faceDownload"></button>
          </div>
          <p class="hint" id="face-size"></p>
          <p class="hint" data-i18n="faceHint"></p>
        </div>
      </div>
    </section>

    <section class="card" id="card-apps">
      <h2><span data-i18n="appsTitle"></span><span class="card-sum" id="sum-apps"></span><button class="small ghost" id="btn-refresh-apps" disabled data-i18n="refresh"></button></h2>
      <ul class="list" id="apps"></ul>
    </section>

    <section class="card" id="card-faces">
      <h2><span data-i18n="facesTitle"></span><span class="card-sum" id="sum-faces"></span><button class="small ghost" id="btn-refresh-faces" disabled data-i18n="refresh"></button></h2>
      <ul class="list" id="faces"></ul>
    </section>

    <section class="card span-2" id="card-health"></section>

    <section class="card span-2" id="card-log">
      <h2><span data-i18n="logTitle"></span><span class="card-sum" id="sum-log"></span><button class="small ghost" id="btn-log-copy" data-i18n="logCopy"></button></h2>
      <pre class="log" id="log"></pre>
    </section>
  </div>

  <footer>
    <p data-i18n="footer1"></p>
    <p data-i18n-html="footer2"></p>
  </footer>
</div>
<dialog class="app-dialog" id="app-dialog" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-desc">
  <div class="app-dialog-body">
    <div class="app-dialog-head">
      <img class="catalog-icon" id="app-dialog-icon" alt="" />
      <h3><span id="app-dialog-title"></span><small id="app-dialog-devices"></small></h3>
      <button class="small ghost" id="app-dialog-close" data-i18n="close"></button>
    </div>
    <p id="app-dialog-desc"></p>
    <div class="shots" id="app-dialog-shots" role="region" tabindex="0"></div>
    <p class="hint" id="app-dialog-caption"></p>
    <div class="row app-dialog-actions">
      <span id="app-dialog-action"></span>
      <span class="hint" id="app-dialog-hint" data-i18n-html="catalogHint" style="margin:0"></span>
    </div>
  </div>
</dialog>
<div class="toast hidden" id="toast"></div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let device: XiaomiDevice | null = null;
let pending: ParsedFile | null = null;
let iconUrl: string | null = null;

// ------------------------------------------------------------------ utils ---

function log(msg: string, cls?: 'e' | 'ok'): void {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  if (cls === 'e' && !logHasError) {
    logHasError = true;
    if (document.getElementById('card-log')?.querySelector('.card-body')) render();
  }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, err = false): void {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4500);
}

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  // the user closing the device picker is not an error
  if (e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'AbortError')) {
    log(t('pickerCancelled'));
    return;
  }
  log(`✗ ${msg}`, 'e');
  toast(msg, true);
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** The phone identity some bands need with the key (see AuthSession); remembered with the key. */
const DEVICE_ID_STORAGE = 'miband-hack.device-id';
const deviceIdStorage = {
  get(): string | null {
    try { return localStorage.getItem(DEVICE_ID_STORAGE); } catch { return null; }
  },
  set(v: string | null): void {
    try { v ? localStorage.setItem(DEVICE_ID_STORAGE, v) : localStorage.removeItem(DEVICE_ID_STORAGE); } catch { /* storage blocked */ }
  },
};

const storage = {
  get(): string | null {
    try { return localStorage.getItem(KEY_STORAGE); } catch { return null; }
  },
  set(v: string | null): void {
    try { v ? localStorage.setItem(KEY_STORAGE, v) : localStorage.removeItem(KEY_STORAGE); } catch { /* storage blocked */ }
  },
};

// ---------------------------------------------------------- browser check ---

function renderSupport(): void {
  const box = $('support');
  const serial = webSerialAvailable();
  const ble = webBluetoothAvailable();
  if (!window.isSecureContext) {
    box.innerHTML = `<div class="banner err">${t('bannerHttps')}</div>`;
  } else if (!serial && !ble) {
    box.innerHTML = `<div class="banner err">${t('bannerNoBrowser')}</div>`;
  } else if (!serial) {
    box.innerHTML = `<div class="banner warn">${t('bannerNoSerial')}</div>`;
  } else {
    box.replaceChildren();
  }
  $<HTMLButtonElement>('btn-spp').disabled = !serial;
  $<HTMLButtonElement>('btn-ble').disabled = !ble;
}

// ---------------------------------------------------------------- connect ---

function readKey(): Uint8Array {
  const raw = $<HTMLInputElement>('authkey').value;
  const key = parseAuthKey(raw);
  const remember = $<HTMLInputElement>('remember').checked;
  storage.set(remember ? raw.trim() : null);
  deviceIdStorage.set(remember ? readDeviceId() || null : null);
  return key;
}

/** Handshake variant from the selector; `?auth=<variant>` and `?companion=ios|android` set them from the URL. */
function readConnectOptions(): ConnectOptions {
  const v = $<HTMLSelectElement>('auth-variant').value;
  const companion = new URLSearchParams(location.search).get('companion');
  return {
    authVariant: (AUTH_VARIANTS as readonly string[]).includes(v) ? (v as AuthVariant) : 'auto',
    companion: companion === 'ios' || companion === 'android' ? companion : 'auto',
  };
}

function readDeviceId(): string {
  return $<HTMLInputElement>('deviceid').value.trim();
}

/** One line about the browser and page, so a pasted log says where it came from. */
function logEnvironment(kind: 'spp' | 'ble' | 'bridge'): void {
  const ua = (navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string } }).userAgentData;
  const browser = ua?.brands?.filter((b) => !/not.?a.?brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`).join(', ');
  log(
    `  environment: ${browser || navigator.userAgent}${ua?.platform ? ` on ${ua.platform}` : ''}; ` +
      `Web Bluetooth ${webBluetoothAvailable() ? 'yes' : 'no'}, Web Serial ${webSerialAvailable() ? 'yes' : 'no'}; ` +
      `transport ${kind.toUpperCase()}; page ${location.pathname}${location.search}`,
  );
}

async function connect(kind: 'spp' | 'ble' | 'bridge'): Promise<void> {
  let key: Uint8Array;
  try {
    key = readKey();
  } catch (e) {
    $('authkey').focus();
    fail(e);
    return;
  }
  setConnecting(true);
  logEnvironment(kind);
  try {
    let link: Link;
    if (kind === 'spp') {
      log(t('pickSpp'));
      link = new StreamLink(await SerialTransport.request(), 'detect');
    } else if (kind === 'bridge') {
      link = new StreamLink(await BridgeTransport.open((m) => log(m)), 'detect');
    } else {
      log(t('pickBle'));
      const c = await requestBle((m) => log(m));
      link = c.kind === 'v2' ? new StreamLink(c.transport, 'v2') : new BleV1Link(c.device, c.chars);
    }
    const dev = new XiaomiDevice(link, key, readDeviceId(), readConnectOptions());
    dev.onLog = (m) => log(m, m.startsWith('✓') ? 'ok' : m.startsWith('⚠') ? 'e' : undefined);
    dev.onChange = () => render();
    dev.onDisconnect = () => {
      log(t('disconnected'));
      if (device === dev) device = null;
      render();
    };
    device = dev;
    render();
    await dev.connect();
    toast(t('connectedToast'));
  } catch (e) {
    fail(e);
    const d = device;
    device = null;
    await d?.disconnect().catch(() => {});
  } finally {
    setConnecting(false);
    render();
  }
}

function setConnecting(on: boolean): void {
  $<HTMLButtonElement>('btn-spp').disabled = on || !webSerialAvailable();
  $<HTMLButtonElement>('btn-ble').disabled = on || !webBluetoothAvailable();
  $<HTMLButtonElement>('btn-bridge').disabled = on;
}

// ----------------------------------------------------------------- render ---

function render(): void {
  const connected = !!device?.connected;
  $('card-device').classList.toggle('hidden', !device);
  $('card-key').classList.toggle('done', connected);
  $('card-connect').classList.toggle('done', connected);
  $('btn-disconnect').classList.toggle('hidden', !device);
  $('btn-spp').classList.toggle('hidden', !!device);
  $('btn-ble').classList.toggle('hidden', !!device);
  $('btn-bridge').classList.toggle('hidden', !SHOW_BRIDGE || !!device);
  $('dot').classList.toggle('on', connected);
  $<HTMLButtonElement>('btn-refresh-apps').disabled = !connected;
  $<HTMLButtonElement>('btn-refresh-faces').disabled = !connected;
  $<HTMLButtonElement>('btn-install').disabled = !connected || !pending || pending.kind === 'unsupported' || device!.isBusy || catalogBusy;
  $<HTMLButtonElement>('btn-face-install').disabled = !connected || device!.isBusy || catalogBusy;

  if (device) {
    const i = device.info;
    $('device-title').textContent = connected ? t('connected') : t('connecting');
    $('d-model').textContent = i.model ?? '—';
    $('d-fw').textContent = i.firmware ?? '—';
    $('d-batt').textContent = i.battery !== undefined ? `${i.battery}%` : '—';
    $('d-link').textContent = device.link.name;
    const st = i.storage;
    $('d-storage').textContent = st && st.total ? `${fmtBytes(st.total - st.used)} / ${fmtBytes(st.total)}` : '—';
    $('d-storage').classList.toggle('low', !!st?.total && st.total - st.used < STORAGE_RESERVE * st.total);
  }
  renderFolds(connected);
  renderApps(connected ? device!.apps : null);
  renderFaces(connected ? device!.faces : null);
  renderCatalog();
  renderAppDialogAction();
  renderHealth();
}

// ---------------------------------------------------------------- folding ---
// Every card folds to its title. render() opens what the user needs next and folds what is done or not yet
// useful; a card opened or closed by hand stays so until its automatic state changes.

const folds = new Map<HTMLElement, { auto: boolean; open: boolean }>();
/** True while the key in the field came from storage untouched: it needs no attention, so its card folds. */
let keyFromStorage = false;
let logHasError = false;

function makeFoldable(card: HTMLElement): void {
  const h2 = card.querySelector('h2')!;
  const body = document.createElement('div');
  body.className = 'card-body';
  const inner = document.createElement('div');
  while (h2.nextSibling) inner.appendChild(h2.nextSibling);
  body.appendChild(inner);
  card.appendChild(body);
  h2.tabIndex = 0;
  h2.setAttribute('role', 'button');
  const toggle = () => {
    folds.set(card, { auto: card.dataset.auto === '1', open: card.classList.contains('collapsed') });
    render();
  };
  h2.onclick = (e) => {
    if (!(e.target as Element).closest('button, a, input, select')) toggle();
  };
  h2.onkeydown = (e) => {
    if (e.target === h2 && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggle();
    }
  };
}

function fold(id: string, autoOpen: boolean, summary = ''): void {
  const card = $(id);
  const manual = folds.get(card);
  if (manual && manual.auto !== autoOpen) folds.delete(card);
  const open = manual && manual.auto === autoOpen ? manual.open : autoOpen;
  card.dataset.auto = autoOpen ? '1' : '0';
  card.classList.toggle('collapsed', !open);
  card.querySelector('h2')!.setAttribute('aria-expanded', String(open));
  const sum = card.querySelector('.card-sum');
  if (sum) sum.textContent = open ? '' : summary;
}

function keyReady(): boolean {
  try {
    parseAuthKey($<HTMLInputElement>('authkey').value);
    return true;
  } catch {
    return false;
  }
}

function renderFolds(connected: boolean): void {
  const keyOk = keyReady();
  const tail = $<HTMLInputElement>('authkey').value.trim().replace(/^0x/i, '').slice(-4);
  const busy = !!device?.isBusy || catalogBusy;
  // The one step that needs the user now gets the accent ring.
  const focus = !keyOk ? 'card-key' : !connected ? 'card-connect' : pending || busy ? 'card-install' : 'card-catalog';
  for (const id of ['card-key', 'card-connect', 'card-catalog', 'card-install']) $(id).classList.toggle('focus', id === focus);
  $('card-key').classList.toggle('done', keyOk);

  fold('card-key', !connected && !(keyOk && keyFromStorage), keyOk ? t('sumKey', { tail }) : '');
  fold('card-connect', !connected, connected ? `${t('connected')} · ${device!.link.name}` : '');
  fold('card-catalog', connected, connected ? '' : t('sumConnectFirst'));
  fold('card-install', !!pending || busy, '.rpk · .bin · .face');
  fold('card-apps', false, connected ? String(device!.apps?.length ?? '—') : '');
  fold('card-faces', false, connected ? String(device!.faces?.length ?? '—') : '');
  fold('card-health', false);
  fold('card-log', logHasError, String($('log').childElementCount || ''));
}

function emptyItem(text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

function nameCell(title: string, sub: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'name';
  d.textContent = title;
  const s = document.createElement('small');
  s.textContent = sub;
  d.appendChild(s);
  return d;
}

function button(text: string, onClick: () => Promise<void>, disabled = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'small';
  b.textContent = text;
  b.disabled = disabled;
  b.onclick = async () => {
    b.disabled = true;
    try { await onClick(); } catch (e) { fail(e); } finally { b.disabled = false; }
  };
  return b;
}

function renderApps(apps: InstalledApp[] | null): void {
  const ul = $('apps');
  ul.replaceChildren();
  if (!apps) return void ul.appendChild(emptyItem(t('notConnected')));
  if (apps.length === 0) return void ul.appendChild(emptyItem(t('noApps')));
  for (const a of apps) {
    const li = document.createElement('li');
    li.append(nameCell(a.name, a.id), button(t('open'), async () => {
      await device!.launchApp(a);
      toast(t('opened', { name: a.name }));
      // A second launch while the app is open crashed a Mi Band 10, so keep the button off for a while.
      await new Promise((r) => setTimeout(r, 30_000));
    }), button(t('del'), async () => {
      if (!confirm(t('confirmDeleteApp', { name: a.name }))) return;
      await device!.deleteApp(a);
      toast(t('deleted', { name: a.name }));
    }));
    ul.appendChild(li);
  }
}

function renderFaces(faces: InstalledFace[] | null): void {
  const ul = $('faces');
  ul.replaceChildren();
  if (!faces) return void ul.appendChild(emptyItem(t('notConnected')));
  if (faces.length === 0) return void ul.appendChild(emptyItem(t('noFaces')));
  for (const f of faces) {
    const li = document.createElement('li');
    li.appendChild(nameCell(f.name, f.id));
    if (f.active) {
      const p = document.createElement('span');
      p.className = 'pill';
      p.textContent = t('active');
      li.appendChild(p);
    } else {
      li.appendChild(button(t('use'), () => device!.setWatchface(f.id)));
      if (f.canDelete) {
        li.appendChild(button(t('del'), async () => {
          if (!confirm(t('confirmDeleteFace', { name: f.name }))) return;
          await device!.deleteWatchface(f);
        }));
      }
    }
    ul.appendChild(li);
  }
}

// ------------------------------------------------------------------ files ---

async function pickFile(file: File): Promise<void> {
  showFile(new Uint8Array(await file.arrayBuffer()), file.name);
}

/** Makes `bytes` the pending file of the install card. */
function showFile(bytes: Uint8Array, fileName: string): void {
  pending = parseFile(bytes);
  if (iconUrl) URL.revokeObjectURL(iconUrl);
  iconUrl = null;

  $('file-info').classList.remove('hidden');
  $('progress').classList.add('hidden');
  $('progress-label').textContent = '';
  const icon = $('f-icon');
  const img = document.createElement('img');
  if (pending.kind === 'rpk' && pending.icon) {
    iconUrl = URL.createObjectURL(pending.icon);
    img.src = iconUrl;
    img.alt = '';
    icon.replaceChildren(img);
  } else {
    icon.replaceChildren(document.createTextNode(pending.kind === 'watchface' ? 'FACE' : pending.kind === 'rpk' ? 'RPK' : '?'));
  }

  if (pending.kind === 'rpk') {
    $('f-name').textContent = `${pending.name} — v${pending.version}`;
    $('f-sub').textContent = `${pending.id} · ${fmtSize(bytes.length)}`;
  } else if (pending.kind === 'watchface') {
    $('f-name').textContent = pending.name;
    $('f-sub').textContent = `watchface #${pending.id} · ${fmtSize(bytes.length)}`;
  } else {
    $('f-name').textContent = fileName;
    $('f-sub').textContent = `✗ ${pending.reason}`;
  }
  render();
}

async function install(): Promise<void> {
  if (!device?.connected || !pending) return;
  const btn = $<HTMLButtonElement>('btn-install');
  btn.disabled = true;
  $('progress').classList.remove('hidden');
  const started = performance.now();
  const total = pending.bytes.length;
  try {
    await device.install(pending, (pct, stage) => {
      $('progress-bar').style.width = `${pct}%`;
      const secs = (performance.now() - started) / 1000;
      const rate = secs > 0.5 ? ` · ${fmtSize((total * pct) / 100 / secs)}/s` : '';
      $('progress-label').textContent = `${stage} ${pct}%${pct < 100 ? rate : ''}`;
    });
    $('progress-label').textContent = t('installDone');
    log('✓ install complete', 'ok');
    toast(t('installedToast'));
  } catch (e) {
    $('progress-label').textContent = `✗ ${(e as Error).message}`;
    fail(e);
  } finally {
    render();
  }
}

// -------------------------------------------------------------- watchface ---

/** Draws the Band 8 face from the form, shows it and returns the .bin. */
function makeFace(): { bytes: Uint8Array; name: string } {
  const face = renderBand8Face({ text: $<HTMLInputElement>('face-text').value, accent: $<HTMLInputElement>('face-accent').value });
  const bytes = buildBand8Face(face);
  $<HTMLCanvasElement>('face-canvas').getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(face.screen.data), face.screen.width, face.screen.height), 0, 0);
  $('face-size').textContent = t('faceSize', { id: face.id, size: fmtSize(bytes.length) });
  return { bytes, name: face.name };
}

let faceTimer: ReturnType<typeof setTimeout> | undefined;
const redrawFace = () => {
  clearTimeout(faceTimer);
  faceTimer = setTimeout(() => {
    try {
      makeFace();
    } catch (e) {
      fail(e);
    }
  }, 150);
};
$('card-face').classList.toggle('hidden', !SHOW_FACE_MAKER);
$('face-text').oninput = redrawFace;
$('face-accent').oninput = redrawFace;
redrawFace();

$('btn-face-download').onclick = () => {
  const { bytes, name } = makeFace();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' }));
  a.download = `${name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'watchface'}.bin`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('btn-face-install').onclick = () => {
  const { bytes, name } = makeFace();
  showFile(bytes, `${name}.bin`);
  $('card-install').scrollIntoView({ behavior: 'smooth', block: 'center' });
  void install();
};

// ----------------------------------------------------------------- wiring ---

const saved = storage.get();
if (saved) {
  $<HTMLInputElement>('authkey').value = saved;
  $<HTMLInputElement>('remember').checked = true;
  keyFromStorage = true;
}
$<HTMLInputElement>('deviceid').value = deviceIdStorage.get() ?? '';
// ?session=ios[&name=iPhone%2013%20mini&os=27.0.1]: send the session config the way Mi Fitness on iOS does.
{
  const q = new URLSearchParams(location.search);
  if (q.get('session') === 'ios') {
    const os = (q.get('os') ?? '27.0.1').split('.').map((n) => Number(n) || 0);
    setIosSessionProfile({ name: q.get('name') ?? 'iPhone', os: [os[0] ?? 0, os[1] ?? 0, os[2] ?? 0] });
  }
}
{
  const v = new URLSearchParams(location.search).get('auth');
  if (v && (AUTH_VARIANTS as readonly string[]).includes(v)) {
    $<HTMLSelectElement>('auth-variant').value = v;
    $('auth-variant').closest('details')?.setAttribute('open', '');
  }
}

$('btn-log-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('log').textContent ? [...$('log').children].map((l) => l.textContent).join('\n') : '');
    toast(t('logCopied'));
  } catch (e) {
    fail(e);
  }
};

$('btn-spp').onclick = () => void connect('spp');
$('btn-ble').onclick = () => void connect('ble');
$('btn-bridge').onclick = () => void connect('bridge');
$('btn-disconnect').onclick = () => void device?.disconnect();
$('btn-install').onclick = () => void install();
$('btn-refresh-apps').onclick = () => void device?.refreshApps().catch(fail);
$('btn-refresh-faces').onclick = () => void device?.refreshFaces().catch(fail);
$('btn-storage').onclick = () => void device?.refreshStorage().catch(fail);
$('btn-del-apps').onclick = () => cleanup('btn-del-apps', async (d, status) => {
  if (!d.apps.length) return toast(t('noApps'));
  if (!confirm(t('confirmDelAllApps', { n: d.apps.length }))) return;
  await d.deleteAllApps((done, total) => status(`${done}/${total}`));
});
$('btn-del-faces').onclick = () => cleanup('btn-del-faces', async (d, status) => {
  const n = d.faces.filter((f) => f.canDelete && !f.active).length;
  if (!n) return toast(t('noDeletableFaces'));
  if (!confirm(t('confirmDelAllFaces', { n }))) return;
  await d.deleteAllFaces((done, total) => status(`${done}/${total}`));
});
$('btn-clear-health').onclick = () => cleanup('btn-clear-health', async (d) => {
  if (!confirm(t('confirmClearHealth'))) return;
  const n = await d.clearHealthFiles();
  toast(t('healthCleared', { n }));
  await d.refreshStorage().catch(() => {});
});

/** Runs one storage clean-up action with its button disabled and a short status next to the buttons. */
function cleanup(id: string, run: (d: XiaomiDevice, status: (s: string) => void) => Promise<void>): void {
  if (!device?.connected) return;
  const b = $<HTMLButtonElement>(id);
  const status = (s: string) => ($('cleanup-status').textContent = s);
  b.disabled = true;
  run(device, status).catch(fail).finally(() => {
    b.disabled = false;
    status('');
  });
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
$('remember').onchange = (e) => {
  if (!(e.target as HTMLInputElement).checked) storage.set(null);
};

const drop = $('drop');
const input = $<HTMLInputElement>('file');
drop.onclick = () => input.click();
drop.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && input.click();
input.onchange = () => input.files?.[0] && void pickFile(input.files[0]);
drop.ondragover = (e) => {
  e.preventDefault();
  drop.classList.add('over');
};
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) void pickFile(f);
};

// ---------------------------------------------------------------- catalog ---

/** A preview image rendered by tools/screenshots (not a photo of a real band); alt may be per language. */
interface CatalogShot { src: string; alt?: string | Record<string, string> }
interface CatalogApp { id: string; name: string; description: string | Record<string, string>; file: string; icon?: string; devices?: string[]; customize?: CustomizeKind; screenshots?: CatalogShot[] }

/** Apps whose content is written here and packed into the rpk in the browser, with their editor panel. */
type CustomizeKind = 'notes' | 'checklist' | 'flashcards';
const EDITORS: Record<CustomizeKind, { panel: string; render: () => void; edit: 'notesEdit' | 'checklistEdit' | 'decksEdit'; hide: 'notesHide' | 'checklistHide' | 'decksHide' }> = {
  notes: { panel: 'notes-editor', render: () => renderNotesEditor(), edit: 'notesEdit', hide: 'notesHide' },
  checklist: { panel: 'checklist-editor', render: () => renderChecklistEditor(), edit: 'checklistEdit', hide: 'checklistHide' },
  flashcards: { panel: 'decks-editor', render: () => renderDecksEditor(), edit: 'decksEdit', hide: 'decksHide' },
};

let catalog: CatalogApp[] = [];
let catalogBusy = false;

async function loadCatalog(): Promise<void> {
  try {
    const r = await fetch('apps/catalog.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    catalog = ((await r.json()) as { apps: CatalogApp[] }).apps ?? [];
  } catch {
    catalog = [];
  }
  renderCatalog();
}

function renderCatalog(): void {
  const ul = $('catalog');
  ul.replaceChildren();
  if (catalog.length === 0) return void ul.appendChild(emptyItem(t('catalogEmpty')));
  const connected = !!device?.connected;
  const installedIds = new Set(device?.apps.map((a) => a.id) ?? []);
  for (const app of catalog) {
    const li = document.createElement('li');
    const icon = document.createElement('img');
    icon.className = 'catalog-icon';
    icon.alt = '';
    if (app.icon) icon.src = app.icon;
    icon.onerror = () => icon.replaceWith(Object.assign(document.createElement('div'), { className: 'catalog-icon', textContent: 'RPK' }));
    // Icon + name open the details dialog; spans, not divs, because they sit inside a <button>.
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = app.name;
    const sub = document.createElement('small');
    sub.textContent = `${pick(app.description)}${app.devices?.length ? ` · ${app.devices.join(', ')}` : ''}`;
    name.appendChild(sub);
    const details = document.createElement('button');
    details.type = 'button';
    details.className = 'catalog-open';
    details.dataset.appId = app.id;
    details.setAttribute('aria-haspopup', 'dialog');
    details.setAttribute('aria-label', t('appDetails', { name: app.name }));
    details.onclick = () => openAppDialog(app);
    details.append(icon, name);
    const installed = installedIds.has(app.id);
    const btn = button(installed ? t('reinstall') : t('add'), () => installFromCatalog(app), !connected || catalogBusy || !!device?.isBusy);
    if (!installed) btn.classList.add('primary');
    li.append(details);
    const editor = app.customize && EDITORS[app.customize];
    if (editor) {
      const open = !$(editor.panel).classList.contains('hidden');
      const edit = document.createElement('button');
      edit.className = 'small';
      edit.textContent = open ? t(editor.hide) : t(editor.edit);
      edit.setAttribute('aria-expanded', String(open));
      edit.setAttribute('aria-controls', editor.panel);
      edit.onclick = () => {
        $(editor.panel).classList.toggle('hidden');
        editor.render();
        renderCatalog();
      };
      li.append(edit);
    }
    li.append(btn);
    ul.appendChild(li);
  }
  $('catalog-hint').classList.toggle('hidden', connected);
}

// ---------------------------------------------------- app details dialog ---

let dialogApp: CatalogApp | null = null;
const appDialog = $<HTMLDialogElement>('app-dialog');

function openAppDialog(app: CatalogApp): void {
  dialogApp = app;
  renderAppDialog();
  if (!appDialog.open) appDialog.showModal(); // native modal: focus trap, Escape closes
}

function renderAppDialog(): void {
  const app = dialogApp;
  if (!app) return;
  $('app-dialog-title').textContent = app.name;
  $('app-dialog-devices').textContent = app.devices?.join(' · ') ?? '';
  const icon = $<HTMLImageElement>('app-dialog-icon');
  icon.classList.toggle('hidden', !app.icon);
  if (app.icon) icon.src = app.icon;
  $('app-dialog-desc').textContent = pick(app.description);
  const shots = app.screenshots ?? [];
  const box = $('app-dialog-shots');
  box.setAttribute('aria-label', t('shotsLabel', { name: app.name }));
  box.replaceChildren(
    ...shots.map((shot, i) => {
      const img = document.createElement('img');
      img.src = shot.src;
      img.alt = pick(shot.alt) || `${app.name} ${i + 1}`;
      img.width = 210; // rendered at 2x: 420 x 978
      img.height = 489;
      img.decoding = 'async';
      return img;
    }),
  );
  box.classList.toggle('hidden', shots.length === 0);
  $('app-dialog-caption').textContent = shots.length ? t('shotsCaption') : t('shotsNone');
  renderAppDialogAction();
}

function renderAppDialogAction(): void {
  const app = dialogApp;
  if (!app) return;
  const connected = !!device?.connected;
  const installed = device?.apps.some((a) => a.id === app.id) ?? false;
  const btn = button(installed ? t('reinstall') : t('add'), async () => {
    appDialog.close();
    await installFromCatalog(app);
  }, !connected || catalogBusy || !!device?.isBusy);
  if (!installed) btn.classList.add('primary');
  $('app-dialog-action').replaceChildren(btn);
  $('app-dialog-hint').classList.toggle('hidden', connected);
}

$('app-dialog-close').onclick = () => appDialog.close();
// A click on the backdrop lands on the <dialog> itself (its content sits in .app-dialog-body).
appDialog.onclick = (e) => e.target === appDialog && appDialog.close();
appDialog.onclose = () => {
  const id = dialogApp?.id;
  dialogApp = null;
  if (id) document.querySelector<HTMLButtonElement>(`.catalog-open[data-app-id="${CSS.escape(id)}"]`)?.focus();
};

/**
 * The last build of each customised app with the content it was built from. A retry with unchanged content
 * sends the same bytes (same md5), so the band resumes its partial upload instead of keeping one more.
 */
const customBuilds = new Map<string, { content: string; bytes: Uint8Array }>();

async function buildOnce(appId: string, content: unknown, build: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const key = JSON.stringify(content);
  const last = customBuilds.get(appId);
  if (last?.content === key) return last.bytes;
  const bytes = await build();
  customBuilds.set(appId, { content: key, bytes });
  return bytes;
}

async function installFromCatalog(app: CatalogApp): Promise<void> {
  if (!device?.connected) throw new Error(t('notConnected'));
  catalogBusy = true;
  renderCatalog();
  const label = $('progress-label');
  $('file-info').classList.remove('hidden');
  $('progress').classList.remove('hidden');
  $('f-name').textContent = app.name;
  $('f-sub').textContent = app.id;
  try {
    label.textContent = t('downloading');
    const r = await fetch(app.file);
    if (!r.ok) throw new Error(t('downloadFailed', { file: app.file, status: r.status }));
    let bytes: Uint8Array = new Uint8Array(await r.arrayBuffer());
    if (app.customize === 'notes') {
      label.textContent = t('notesBuilding');
      const content = notes.filter((n) => n.title.trim() || n.body.trim());
      const base = bytes;
      bytes = await buildOnce(app.id, content, () => buildNotesRpk(base, content, undefined, { versionCode: customVersionCode() }));
    } else if (app.customize === 'checklist') {
      label.textContent = t('checklistBuilding');
      const content = checklistsForBand();
      const base = bytes;
      bytes = await buildOnce(app.id, content, () => buildChecklistRpk(base, content, undefined, { versionCode: customVersionCode() }));
    } else if (app.customize === 'flashcards') {
      label.textContent = t('decksBuilding');
      const content = decksForInstall();
      const base = bytes;
      bytes = await buildOnce(app.id, content, () => buildFlashcardsRpk(base, content, undefined, { versionCode: customVersionCode() }));
    }
    const parsed = parseFile(bytes);
    if (parsed.kind !== 'rpk') throw new Error(parsed.kind === 'unsupported' ? parsed.reason : t('notRpk'));
    pending = parsed;
    await device.install(parsed, (pct, stage) => {
      $('progress-bar').style.width = `${pct}%`;
      label.textContent = `${stage} ${pct}%`;
    });
    label.textContent = `✓ ${t('installedApp', { name: app.name })}`;
    log(`✓ installed ${app.name}`, 'ok');
    toast(t('installedApp', { name: app.name }));
  } catch (e) {
    label.textContent = `✗ ${(e as Error).message}`;
    throw e;
  } finally {
    catalogBusy = false;
    render();
  }
}

// ------------------------------------------------------------------ notes ---

const NOTES_STORAGE = 'miband-hack.notes';

function loadNotes(): Note[] {
  const parsed = loadStored(NOTES_STORAGE) as Note[] | undefined;
  if (Array.isArray(parsed)) return parsed.filter((n) => typeof n?.title === 'string' && typeof n?.body === 'string');
  return [{ title: t('notesSample1Title'), body: t('notesSample1Body') }];
}

let notes: Note[] = loadNotes();

let notesSaveOk = true;

function saveNotes(): void {
  notesSaveOk = saveStored(NOTES_STORAGE, notes);
  renderNotesStatus();
}

function renderNotesStatus(): void {
  $('notes-saved').textContent = notesSaveOk ? t('notesSaved') : t('notesSaveFailed');
}

/** Accepts our export ({notes}), the app's own notes.json, or a bare [{title, body}] array. */
function parseNotesFile(text: string): Note[] {
  const data = JSON.parse(text) as unknown;
  const list = Array.isArray(data) ? data : (data as { notes?: unknown })?.notes;
  if (!Array.isArray(list)) throw new Error(t('notesImportBad'));
  return list.map((n) => {
    const o = n as { title?: unknown; body?: unknown };
    if (typeof o?.title !== 'string' && typeof o?.body !== 'string') throw new Error(t('notesImportBad'));
    return { title: String(o.title ?? ''), body: String(o.body ?? '') };
  });
}

function exportNotes(): void {
  downloadJson('miband-notes', { app: 'miband-hack-notes', version: 1, exported: new Date().toISOString(), notes });
}

async function importNotes(file: File): Promise<void> {
  const imported = parseNotesFile(await file.text());
  const current = notes.filter((n) => n.title.trim() || n.body.trim()).length;
  if (current > 0 && !confirm(t('notesReplaceConfirm', { n: current, m: imported.length }))) return;
  notes = imported;
  saveNotes();
  renderNotesEditor();
  toast(t('notesImported', { n: imported.length }));
}

/** Re-renders the note rows; only called on add/remove/language change so typing keeps focus. */
function renderNotesEditor(): void {
  renderNotesStatus();
  const box = $('notes-list');
  box.replaceChildren();
  notes.forEach((note, i) => {
    const row = document.createElement('div');
    row.className = 'note-row';
    const title = document.createElement('input');
    title.type = 'text';
    title.placeholder = t('notesTitlePh');
    title.value = note.title;
    title.maxLength = 80;
    title.oninput = () => {
      notes[i].title = title.value;
      saveNotes();
    };
    const body = document.createElement('textarea');
    body.placeholder = t('notesBodyPh');
    body.value = note.body;
    body.rows = 3;
    body.oninput = () => {
      notes[i].body = body.value;
      saveNotes();
    };
    const del = document.createElement('button');
    del.className = 'small ghost';
    del.textContent = t('notesRemove');
    del.onclick = () => {
      notes.splice(i, 1);
      saveNotes();
      renderNotesEditor();
    };
    row.append(title, body, del);
    box.appendChild(row);
  });
}

$('btn-notes-export').onclick = () => exportNotes();
bindImport($('btn-notes-import'), $<HTMLInputElement>('notes-file'), importNotes, fail);

$('btn-note-add').onclick = () => {
  notes.push({ title: '', body: '' });
  saveNotes();
  renderNotesEditor();
  ($('notes-list').lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus();
};

// ------------------------------------------------------- key from cloud ---

interface CloudDevice { server: string; source?: 'mifitness' | 'mihome'; keyField?: string; name: string; model: string; did: string; mac?: string; key?: string }
interface PollResult { status: string; devices?: CloudDevice[]; fitness?: { ok: boolean }; mihome?: { ok: boolean | null }; trail?: string[] }

interface KeyRow { title: string; sub: string; key: string; phoneId?: string }

/** One "Use this key" row per key; band/cloud values only ever go through textContent. */
function renderKeyRows(ul: HTMLElement, rows: KeyRow[]): void {
  // A green banner above the rows, so a found key is seen at once; it changes once the key is used.
  const head = document.createElement('li');
  head.className = 'found';
  head.textContent = t('keyFoundHead');
  ul.appendChild(head);
  for (const r of rows) {
    const li = document.createElement('li');
    const valid = /^[0-9a-f]{32}$/i.test(r.key);
    const use = button(t('useKey'), async () => {
      $<HTMLInputElement>('authkey').value = r.key;
      if (r.phoneId) $<HTMLInputElement>('deviceid').value = r.phoneId;
      head.textContent = t('keyFilledHead');
      toast(t('keyFilled', { name: r.title }));
      log(`Filled in key of ${r.title}`, 'ok');
      render();
    });
    use.classList.add('primary');
    li.append(nameCell(r.title, `${r.sub}${valid ? '' : ` · ${t('keyWarn', { n: r.key.length })}`}`), use);
    ul.appendChild(li);
  }
  ul.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

let qrAbort: AbortController | null = null;
const QR_MAX_ROUNDS = 12;
let qrLoginUrl = '';

// The link lives inside translated markup, so it is re-pointed after every language switch.
function setQrLink(): void {
  const a = document.getElementById('qr-link') as HTMLAnchorElement | null;
  if (a && qrLoginUrl) a.href = qrLoginUrl;
}

function stopQr(): void {
  qrAbort?.abort();
  qrAbort = null;
  $('qr-panel').classList.add('hidden');
  $('btn-qr').classList.remove('hidden');
}

async function api<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error || t('serverError', { status: r.status }));
  return data;
}

async function startQr(): Promise<void> {
  qrAbort?.abort();
  const ctl = new AbortController();
  qrAbort = ctl;
  $('btn-qr').classList.add('hidden');
  $('qr-panel').classList.remove('hidden');
  $('cloud-devices').classList.add('hidden');
  const status = $('qr-status');
  status.textContent = t('qrCreating');
  try {
    // An expired QR is replaced by a fresh one; give up after about an hour of nobody scanning.
    for (let round = 0; round < QR_MAX_ROUNDS; round++) {
      const qr = await api<{ qr: string; loginUrl: string; lp: string; timeout: number }>('/api/xiaomi/qr', {}, ctl.signal);
      $<HTMLImageElement>('qr-img').src = qr.qr;
      qrLoginUrl = qr.loginUrl;
      setQrLink();
      status.textContent = t(round ? 'qrRenewed' : 'qrWaiting');
      const deadline = Date.now() + qr.timeout * 1000;
      while (Date.now() < deadline) {
        const server = $<HTMLSelectElement>('qr-server').value;
        const res = await api<PollResult>('/api/xiaomi/poll', { lp: qr.lp, server }, ctl.signal);
        if (res.status === 'ok') {
          stopQr();
          renderCloudDevices(res);
          return;
        }
      }
      log('QR code expired, creating a new one');
    }
    status.textContent = t('qrExpired');
    throw new Error(t('qrExpiredErr'));
  } catch (e) {
    if (ctl.signal.aborted) return;
    stopQr();
    fail(e);
  }
}

function renderCloudDevices(res: PollResult): void {
  const devices = res.devices ?? [];
  const ul = $('cloud-devices');
  ul.replaceChildren();
  ul.classList.remove('hidden');
  const fitness = devices.filter((d) => d.source === 'mifitness');
  const withKey = devices.filter((d) => d.key);
  const looksLikeBand = (d: CloudDevice) => /band|watch|wear|hlth/i.test(`${d.model} ${d.name}`);
  withKey.sort((a, b) => Number(b.source === 'mifitness') - Number(a.source === 'mifitness') || Number(looksLikeBand(b)) - Number(looksLikeBand(a)));
  // Each Xiaomi step: host, HTTP status, Xiaomi code (no tokens), to tell where the key lookup stopped.
  for (const step of res.trail ?? []) log(`  · ${step}`);
  log(
    `Mi Fitness: ${res.fitness?.ok ? `${fitness.length} devices` : 'not readable'}; ` +
      `Mi Home: ${res.mihome?.ok === null ? 'skipped' : res.mihome?.ok ? `${devices.length - fitness.length} devices` : 'not readable'}; ` +
      `${withKey.length} keys`,
  );
  if (withKey.length) {
    // Several keys for one band (e.g. encrypt_key and token differ): label which field each is.
    const perDevice = new Map<string, number>();
    for (const d of withKey) perDevice.set(`${d.source}:${d.did}`, (perDevice.get(`${d.source}:${d.did}`) ?? 0) + 1);
    renderKeyRows(
      ul,
      withKey.map((d) => ({
        title: d.name || d.model,
        sub: [
          d.source === 'mifitness' ? 'Mi Fitness' : 'Mi Home',
          d.model,
          d.mac ?? d.did,
          (perDevice.get(`${d.source}:${d.did}`) ?? 0) > 1 && d.keyField ? t('keyFromField', { field: d.keyField }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
        key: d.key!,
      })),
    );
    return;
  }
  // No key: say what was checked, then point to the fallbacks.
  if (!res.fitness?.ok) ul.appendChild(emptyItem(t('cloudFitnessFail')));
  else if (fitness.length) ul.appendChild(emptyItem(t('cloudFitnessNoKey', { n: fitness.length })));
  else ul.appendChild(emptyItem(t('cloudFitnessEmpty')));
  const home = devices.length - fitness.length;
  if (home) ul.appendChild(emptyItem(t('cloudNoKey', { n: home })));
  ul.appendChild(emptyItem(t('cloudFallback')));
  ($('other-ways') as HTMLDetailsElement).open = true;
}

// ------------------------------------------------- key from Mi Fitness files ---

/** Loose files from every pick so far: manifest.sqlite and its -wal may be picked one at a time. */
const mfLoose: Record<string, Uint8Array> = {};

$<HTMLInputElement>('mf-files').onchange = async (ev) => {
  const input = ev.target as HTMLInputElement;
  const ul = $('mf-keys');
  ul.replaceChildren();
  ul.classList.remove('hidden');
  try {
    const { keysFromFiles, keysFromZip } = await import('./core/mifitness-files');
    const picked = [...(input.files ?? [])];
    const keys = [];
    for (const f of picked) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (/\.zip$/i.test(f.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) keys.push(...keysFromZip(bytes));
      else mfLoose[f.name] = bytes;
    }
    keys.push(...keysFromFiles(mfLoose));
    log(`Mi Fitness folder: ${keys.length} keys found (${Object.keys(mfLoose).join(', ') || 'zip'})`);
    if (!keys.length) {
      const needWal = mfLoose['manifest.sqlite'] && !mfLoose['manifest.sqlite-wal'];
      ul.appendChild(emptyItem(t(needWal ? 'iosNeedWal' : 'iosNone')));
      return;
    }
    renderKeyRows(
      ul,
      keys.map((k) => ({ title: k.name || k.model || 'Mi Fitness', sub: ['Mi Fitness', k.model, k.mac ?? k.did].filter(Boolean).join(' · '), key: k.key, phoneId: k.phoneId })),
    );
  } catch (e) {
    ul.appendChild(emptyItem(t('iosError', { msg: (e as Error).message })));
  } finally {
    input.value = '';
  }
};

$('btn-qr').onclick = () => void startQr();
$('btn-qr-cancel').onclick = () => stopQr();

// --------------------------------------------------------------- PWA ---

// Built pages only: the dev server's files change on every edit.
if ('serviceWorker' in navigator && window.isSecureContext && !import.meta.env.DEV) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
let installPrompt: (Event & { prompt: () => Promise<void> }) | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e as typeof installPrompt;
  $('btn-install-app').classList.remove('hidden');
});
$('btn-install-app').onclick = async () => {
  await installPrompt?.prompt();
  installPrompt = null;
  $('btn-install-app').classList.add('hidden');
};

// ---------------------------------------------------------------- language ---

function renderLangSwitch(): void {
  const box = $('lang-switch');
  box.replaceChildren(
    ...LANGS.map(({ code, label }) => {
      const b = document.createElement('button');
      b.className = `small${code === getLang() ? ' on' : ''}`;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(code === getLang()));
      b.onclick = () => {
        setLang(code);
        localize();
      };
      return b;
    }),
  );
}

function localize(): void {
  applyI18n();
  setQrLink();
  renderNotesEditor();
  renderChecklistEditor();
  renderDecksEditor();
  renderLangSwitch();
  renderSupport();
  render();
  renderAppDialog();
}

mountHealth($('card-health'), { device: () => device, log, toast, fail });
for (const id of ['card-key', 'card-connect', 'card-catalog', 'card-install', 'card-apps', 'card-faces', 'card-health', 'card-log']) makeFoldable($(id));
// A file dragged over the folded install card opens it, so it can be dropped.
$('card-install').addEventListener('dragenter', () => {
  const card = $('card-install');
  if (!card.classList.contains('collapsed')) return;
  folds.set(card, { auto: card.dataset.auto === '1', open: true });
  render();
});
$('authkey').addEventListener('input', () => {
  keyFromStorage = false;
  render();
});
mountChecklist($('checklist-editor'), { toast, fail });
mountDecksEditor($('decks-editor'), { toast, fail });
localize();
void loadCatalog();
log(t('ready'));
