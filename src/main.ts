import './style.css';
import { parseAuthKey } from './core/auth';
import { type ParsedFile, parseFile } from './core/files';
import { type InstalledApp, type InstalledFace, XiaomiDevice } from './device';
import { BleV1Link } from './protocol/ble-v1-link';
import type { Link } from './protocol/link';
import { StreamLink } from './protocol/stream-link';
import { requestBle, webBluetoothAvailable } from './transport/ble';
import { SerialTransport, webSerialAvailable } from './transport/serial';
import { applyI18n, getLang, LANGS, pick, setLang, t } from './i18n';
import { buildNotesRpk, notesVersionCode, type Note } from './rpk';
import { mountHealth, renderHealth } from './health/ui';

const KEY_STORAGE = 'miband-hack.authkey';

// Static shell only — every value coming from the band or a file is set via textContent.
// Translatable text is filled in by applyI18n() from data-i18n* attributes.
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<div class="wrap">
  <header class="hero">
    <div class="brand">
      <div class="band-mark" aria-hidden="true"></div>
      <h1>MiBand Hack<small data-i18n="subtitle"></small></h1>
    </div>
    <div class="row">
      <button class="small hidden" id="btn-install-app" data-i18n="installApp"></button>
      <div class="lang-switch" id="lang-switch" role="group" aria-label="Language"></div>
      <span class="tag">Mi Band 8 · 9 · 10 · Chrome / Edge</span>
    </div>
  </header>

  <div id="support"></div>

  <div class="grid">
    <section class="card" id="card-key">
      <h2><span class="step">1</span><span data-i18n="keyTitle"></span></h2>
      <label for="authkey" data-i18n="keyLabel"></label>
      <input id="authkey" type="password" placeholder="0x0123456789abcdef0123456789abcdef" autocomplete="off" spellcheck="false" />
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

      <details>
        <summary data-i18n="otherWays"></summary>
        <p data-i18n="otherP1"></p>
        <ul>
          <li data-i18n-html="otherLi1"></li>
          <li data-i18n="otherLi2"></li>
        </ul>
        <p data-i18n="otherP2"></p>
      </details>
    </section>

    <section class="card" id="card-connect">
      <h2><span class="step">2</span><span data-i18n="connTitle"></span></h2>
      <div class="connect-opts">
        <button class="connect-opt primary" id="btn-spp"><span data-i18n="sppBtn" style="color:inherit;font-weight:600;font-size:14px"></span><span data-i18n="sppSub" style="color:inherit;opacity:.85"></span></button>
        <button class="connect-opt" id="btn-ble"><span data-i18n="bleBtn" style="color:inherit;font-weight:600;font-size:14px"></span><span data-i18n="bleSub"></span></button>
        <button class="ghost hidden" id="btn-disconnect" data-i18n="disconnect"></button>
      </div>
      <details>
        <summary data-i18n="beforeConnect"></summary>
        <ol>
          <li data-i18n-html="before1"></li>
          <li data-i18n-html="before2"></li>
          <li data-i18n-html="before3"></li>
        </ol>
      </details>
    </section>

    <section class="card span-2 hidden" id="card-device">
      <h2><span class="dot" id="dot"></span><span id="device-title"></span></h2>
      <div class="device">
        <div class="stat"><b id="d-model">—</b><span data-i18n="model"></span></div>
        <div class="stat"><b id="d-fw">—</b><span data-i18n="firmware"></span></div>
        <div class="stat"><b id="d-batt">—</b><span data-i18n="battery"></span></div>
        <div class="stat"><b id="d-link">—</b><span data-i18n="protocol"></span></div>
      </div>
    </section>

    <section class="card span-2" id="card-catalog">
      <h2><span class="step">3</span><span data-i18n="catalogTitle"></span></h2>
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
      <p class="hint" id="catalog-hint" data-i18n-html="catalogHint"></p>
    </section>

    <section class="card span-2" id="card-install">
      <h2><span class="step">4</span><span data-i18n="fileTitle"></span></h2>
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

    <section class="card">
      <h2><span data-i18n="appsTitle"></span> <button class="small ghost" id="btn-refresh-apps" disabled style="margin-left:auto" data-i18n="refresh"></button></h2>
      <ul class="list" id="apps"></ul>
    </section>

    <section class="card">
      <h2><span data-i18n="facesTitle"></span> <button class="small ghost" id="btn-refresh-faces" disabled style="margin-left:auto" data-i18n="refresh"></button></h2>
      <ul class="list" id="faces"></ul>
    </section>

    <section class="card span-2" id="card-health"></section>

    <section class="card span-2">
      <details open>
        <summary data-i18n="logTitle"></summary>
        <pre class="log" id="log"></pre>
      </details>
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
  storage.set($<HTMLInputElement>('remember').checked ? raw.trim() : null);
  return key;
}

async function connect(kind: 'spp' | 'ble'): Promise<void> {
  let key: Uint8Array;
  try {
    key = readKey();
  } catch (e) {
    $('authkey').focus();
    fail(e);
    return;
  }
  setConnecting(true);
  try {
    let link: Link;
    if (kind === 'spp') {
      log(t('pickSpp'));
      link = new StreamLink(await SerialTransport.request(), 'detect');
    } else {
      log(t('pickBle'));
      const c = await requestBle();
      link = c.kind === 'v2' ? new StreamLink(c.transport, 'v2') : new BleV1Link(c.device, c.chars);
    }
    const dev = new XiaomiDevice(link, key);
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
  $('dot').classList.toggle('on', connected);
  $<HTMLButtonElement>('btn-refresh-apps').disabled = !connected;
  $<HTMLButtonElement>('btn-refresh-faces').disabled = !connected;
  $<HTMLButtonElement>('btn-install').disabled = !connected || !pending || pending.kind === 'unsupported';

  if (device) {
    const i = device.info;
    $('device-title').textContent = connected ? t('connected') : t('connecting');
    $('d-model').textContent = i.model ?? '—';
    $('d-fw').textContent = i.firmware ?? '—';
    $('d-batt').textContent = i.battery !== undefined ? `${i.battery}%` : '—';
    $('d-link').textContent = device.link.name;
  }
  renderApps(connected ? device!.apps : null);
  renderFaces(connected ? device!.faces : null);
  renderCatalog();
  renderAppDialogAction();
  renderHealth();
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
    li.append(nameCell(a.name, a.id), button(t('del'), async () => {
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
  const bytes = new Uint8Array(await file.arrayBuffer());
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
    $('f-name').textContent = file.name;
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

// ----------------------------------------------------------------- wiring ---

const saved = storage.get();
if (saved) {
  $<HTMLInputElement>('authkey').value = saved;
  $<HTMLInputElement>('remember').checked = true;
}

$('btn-spp').onclick = () => void connect('spp');
$('btn-ble').onclick = () => void connect('ble');
$('btn-disconnect').onclick = () => void device?.disconnect();
$('btn-install').onclick = () => void install();
$('btn-refresh-apps').onclick = () => void device?.refreshApps().catch(fail);
$('btn-refresh-faces').onclick = () => void device?.refreshFaces().catch(fail);
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
interface CatalogApp { id: string; name: string; description: string | Record<string, string>; file: string; icon?: string; devices?: string[]; customize?: 'notes'; screenshots?: CatalogShot[] }

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
    const btn = button(installed ? t('reinstall') : t('add'), () => installFromCatalog(app), !connected || catalogBusy);
    if (!installed) btn.classList.add('primary');
    li.append(details);
    if (app.customize === 'notes') {
      const open = !$('notes-editor').classList.contains('hidden');
      const edit = document.createElement('button');
      edit.className = 'small';
      edit.textContent = open ? t('notesHide') : t('notesEdit');
      edit.onclick = () => {
        $('notes-editor').classList.toggle('hidden');
        renderNotesEditor();
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
  }, !connected || catalogBusy);
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
      bytes = await buildNotesRpk(bytes, notes.filter((n) => n.title.trim() || n.body.trim()), undefined, { versionCode: notesVersionCode() });
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
  try {
    const raw = localStorage.getItem(NOTES_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as Note[];
      if (Array.isArray(parsed)) return parsed.filter((n) => typeof n?.title === 'string' && typeof n?.body === 'string');
    }
  } catch {
    /* storage blocked or corrupt */
  }
  return [{ title: t('notesSample1Title'), body: t('notesSample1Body') }];
}

let notes: Note[] = loadNotes();

let notesSaveOk = true;

function saveNotes(): void {
  try {
    localStorage.setItem(NOTES_STORAGE, JSON.stringify(notes));
    notesSaveOk = true;
  } catch {
    notesSaveOk = false;
  }
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
  const json = JSON.stringify({ app: 'miband-hack-notes', version: 1, exported: new Date().toISOString(), notes }, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `miband-notes-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
$('btn-notes-import').onclick = () => $<HTMLInputElement>('notes-file').click();
$<HTMLInputElement>('notes-file').onchange = (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // allow importing the same file again
  if (file) importNotes(file).catch(fail);
};

$('btn-note-add').onclick = () => {
  notes.push({ title: '', body: '' });
  saveNotes();
  renderNotesEditor();
  ($('notes-list').lastElementChild?.querySelector('input') as HTMLInputElement | null)?.focus();
};

// ------------------------------------------------------- key from cloud ---

interface CloudDevice { server: string; name: string; model: string; did: string; mac?: string; key?: string }

let qrAbort: AbortController | null = null;
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
    const qr = await api<{ qr: string; loginUrl: string; lp: string; timeout: number }>('/api/xiaomi/qr', {}, ctl.signal);
    $<HTMLImageElement>('qr-img').src = qr.qr;
    qrLoginUrl = qr.loginUrl;
    setQrLink();
    status.textContent = t('qrWaiting');
    const deadline = Date.now() + qr.timeout * 1000;
    while (Date.now() < deadline) {
      const server = $<HTMLSelectElement>('qr-server').value;
      const res = await api<{ status: string; devices?: CloudDevice[] }>('/api/xiaomi/poll', { lp: qr.lp, server }, ctl.signal);
      if (res.status === 'ok') {
        stopQr();
        renderCloudDevices(res.devices ?? []);
        return;
      }
    }
    status.textContent = t('qrExpired');
    throw new Error(t('qrExpiredErr'));
  } catch (e) {
    if (ctl.signal.aborted) return;
    stopQr();
    fail(e);
  }
}

function renderCloudDevices(devices: CloudDevice[]): void {
  const ul = $('cloud-devices');
  ul.replaceChildren();
  ul.classList.remove('hidden');
  const withKey = devices.filter((d) => d.key);
  const looksLikeBand = (d: CloudDevice) => /band|watch|wear|hlth/i.test(`${d.model} ${d.name}`);
  withKey.sort((a, b) => Number(looksLikeBand(b)) - Number(looksLikeBand(a)));
  log(`Account has ${devices.length} devices, ${withKey.length} Bluetooth devices with a key`);
  if (withKey.length === 0) {
    ul.appendChild(emptyItem(devices.length ? t('cloudNoKey', { n: devices.length }) : t('cloudNone')));
    return;
  }
  for (const d of withKey) {
    const li = document.createElement('li');
    const valid = /^[0-9a-f]{32}$/i.test(d.key!);
    const sub = `${d.model} · ${d.mac ?? d.did} · ${d.server}${valid ? '' : ` · ${t('keyWarn', { n: d.key!.length })}`}`;
    li.append(nameCell(d.name || d.model, sub), button(t('useKey'), async () => {
      $<HTMLInputElement>('authkey').value = d.key!;
      toast(t('keyFilled', { name: d.name || d.model }));
      log(`Filled in key of ${d.name || d.model} (${d.model})`, 'ok');
    }));
    ul.appendChild(li);
  }
}

$('btn-qr').onclick = () => void startQr();
$('btn-qr-cancel').onclick = () => stopQr();

// --------------------------------------------------------------- PWA ---

if ('serviceWorker' in navigator && location.protocol === 'https:') {
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
  renderLangSwitch();
  renderSupport();
  render();
  renderAppDialog();
}

mountHealth($('card-health'), { device: () => device, log, toast, fail });
localize();
void loadCatalog();
log(t('ready'));
