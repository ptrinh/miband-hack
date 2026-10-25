import './style.css';
import { parseAuthKey } from './core/auth';
import { type ParsedFile, parseFile } from './core/files';
import { type InstalledApp, type InstalledFace, XiaomiDevice } from './device';
import { BleV1Link } from './protocol/ble-v1-link';
import type { Link } from './protocol/link';
import { StreamLink } from './protocol/stream-link';
import { requestBle, webBluetoothAvailable } from './transport/ble';
import { SerialTransport, webSerialAvailable } from './transport/serial';

const KEY_STORAGE = 'miband-hack.authkey';
const GB_KEY_GUIDE = 'https://gadgetbridge.org/basics/pairing/huami-xiaomi-server/';

// Static shell only — every value coming from the band or a file is set via textContent.
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<div class="wrap">
  <header class="hero">
    <div class="brand">
      <div class="band-mark" aria-hidden="true"></div>
      <h1>MiBand Hack<small>Cài app &amp; watchface cho Mi Band ngay trên trình duyệt — không cần cài phần mềm</small></h1>
    </div>
    <div class="row">
      <button class="small hidden" id="btn-install-app">Cài thành ứng dụng</button>
      <span class="tag">Mi Band 8 · 9 · 10 · Chrome / Edge</span>
    </div>
  </header>

  <div id="support"></div>

  <div class="grid">
    <section class="card" id="card-key">
      <h2><span class="step">1</span>Auth key</h2>
      <label for="authkey">Auth key của band (32 ký tự hex)</label>
      <input id="authkey" type="password" placeholder="0x0123456789abcdef0123456789abcdef" autocomplete="off" spellcheck="false" />
      <label class="check"><input type="checkbox" id="remember" /> Ghi nhớ trên trình duyệt này</label>

      <button class="primary" id="btn-qr" style="margin-top:14px;width:100%">Chưa có key? Lấy tự động bằng tài khoản Xiaomi</button>
      <div id="qr-panel" class="qr-panel hidden">
        <div class="qr-box"><img id="qr-img" alt="Mã QR đăng nhập Xiaomi" /></div>
        <ol class="qr-steps">
          <li>Dùng điện thoại <b>đã đăng nhập đúng tài khoản Xiaomi đang ghép với band</b> (ví dụ app Xiaomi Home / Mi Home) để quét mã.</li>
          <li>Xác nhận đăng nhập trên điện thoại.</li>
          <li>Đợi vài giây, key sẽ tự hiện ra bên dưới.</li>
        </ol>
        <p class="hint">Không quét được? <a id="qr-link" target="_blank" rel="noopener">Mở trang đăng nhập của Xiaomi</a> trên điện thoại.</p>
        <div class="row" style="margin-top:8px">
          <label for="qr-server" style="margin:0;font-weight:400;color:var(--muted)">Khu vực tài khoản</label>
          <select id="qr-server">
            <option value="">Tự dò</option>
            <option value="sg">Singapore (Đông Nam Á)</option>
            <option value="de">Châu Âu</option>
            <option value="us">Mỹ</option>
            <option value="cn">Trung Quốc</option>
            <option value="i2">Ấn Độ (i2)</option>
            <option value="in">Ấn Độ (in)</option>
            <option value="ru">Nga</option>
            <option value="tw">Đài Loan</option>
          </select>
          <button class="small ghost" id="btn-qr-cancel" style="margin-left:auto">Huỷ</button>
        </div>
        <p class="progress-label" id="qr-status"></p>
      </div>
      <ul class="list hidden" id="cloud-devices" style="margin-top:10px"></ul>
      <p class="hint">Phiên đăng nhập Xiaomi chỉ được dùng một lần để đọc key rồi bỏ đi. Server không lưu và không ghi log. Mật khẩu không bao giờ đi qua trang này.</p>

      <details>
        <summary>Cách khác để lấy auth key</summary>
        <p>Auth key do Xiaomi cấp khi band được ghép với app Mi Fitness. Không có key thì không thiết bị nào khác nói chuyện được với band.</p>
        <ul>
          <li>Xem hướng dẫn của Gadgetbridge (mục <em>Mi Fitness</em> và <em>Xiaomi Cloud Tokens Extractor</em>): <a href="${GB_KEY_GUIDE}" target="_blank" rel="noopener">gadgetbridge.org — server pairing</a>.</li>
          <li>Nếu đang dùng Gadgetbridge với band này: key nằm trong cài đặt riêng của thiết bị.</li>
        </ul>
        <p>Key chỉ được dùng trong trình duyệt của bạn, không gửi đi đâu cả.</p>
      </details>
    </section>

    <section class="card" id="card-connect">
      <h2><span class="step">2</span>Kết nối</h2>
      <div class="connect-opts">
        <button class="connect-opt primary" id="btn-spp">Mi Band 9 / 10 / 9 Pro / 10 Pro<span style="color:inherit;opacity:.85">Bluetooth Classic (SPP) qua Web Serial</span></button>
        <button class="connect-opt" id="btn-ble">Mi Band 8 / 9 Active và đời BLE khác<span>Bluetooth Low Energy qua Web Bluetooth</span></button>
        <button class="ghost hidden" id="btn-disconnect">Ngắt kết nối</button>
      </div>
      <details>
        <summary>Trước khi bấm kết nối</summary>
        <ol>
          <li><b>Tắt Bluetooth trên điện thoại</b> (hoặc tắt Mi Fitness): mỗi lúc band chỉ nói chuyện với một thiết bị.</li>
          <li><b>Mi Band 9/10:</b> ghép (pair) band trong phần cài đặt Bluetooth của máy tính trước, rồi chọn cổng <code>Bluetooth SPP</code> trong hộp thoại.</li>
          <li><b>Linux:</b> bật <code>chrome://flags/#enable-experimental-web-platform-features</code> nếu không thấy thiết bị.</li>
        </ol>
      </details>
    </section>

    <section class="card span-2 hidden" id="card-device">
      <h2><span class="dot" id="dot"></span><span id="device-title">Thiết bị</span></h2>
      <div class="device">
        <div class="stat"><b id="d-model">—</b><span>Model</span></div>
        <div class="stat"><b id="d-fw">—</b><span>Firmware</span></div>
        <div class="stat"><b id="d-batt">—</b><span>Pin</span></div>
        <div class="stat"><b id="d-link">—</b><span>Giao thức</span></div>
      </div>
    </section>

    <section class="card span-2" id="card-catalog">
      <h2><span class="step">3</span>App mẫu: bấm Add để cài</h2>
      <ul class="list catalog" id="catalog"><li class="empty">Đang tải danh sách…</li></ul>
      <p class="hint" id="catalog-hint">Kết nối band ở bước 2 trước rồi bấm <b>Add</b>.</p>
    </section>

    <section class="card span-2" id="card-install">
      <h2><span class="step">4</span>Hoặc cài file của bạn</h2>
      <div class="drop" id="drop" tabindex="0" role="button">
        <strong>Kéo thả file vào đây</strong> hoặc bấm để chọn<br />
        <small>.rpk (quick app) · .bin (watchface)</small>
      </div>
      <input type="file" id="file" accept=".rpk,.bin,.face,application/zip,application/octet-stream" class="hidden" />
      <div id="file-info" class="hidden">
        <div class="file">
          <div class="ph" id="f-icon">FILE</div>
          <div class="meta"><b id="f-name"></b><span id="f-sub"></span></div>
          <button class="primary" id="btn-install" disabled>Cài lên band</button>
        </div>
        <div class="progress hidden" id="progress"><div id="progress-bar"></div></div>
        <div class="progress-label" id="progress-label"></div>
      </div>
    </section>

    <section class="card">
      <h2>App trên band <button class="small ghost" id="btn-refresh-apps" disabled style="margin-left:auto">Làm mới</button></h2>
      <ul class="list" id="apps"><li class="empty">Chưa kết nối</li></ul>
    </section>

    <section class="card">
      <h2>Watchface <button class="small ghost" id="btn-refresh-faces" disabled style="margin-left:auto">Làm mới</button></h2>
      <ul class="list" id="faces"><li class="empty">Chưa kết nối</li></ul>
    </section>

    <section class="card span-2">
      <details open>
        <summary>Nhật ký kết nối</summary>
        <pre class="log" id="log"></pre>
      </details>
    </section>
  </div>

  <footer>
    <p>Dự án độc lập, không liên kết với Xiaomi. Sideload app không chính thức có thể khiến band hoạt động bất thường — tự chịu rủi ro.</p>
    <p>Giao thức port từ <a href="https://codeberg.org/Freeyourgadget/Gadgetbridge" target="_blank" rel="noopener">Gadgetbridge</a> · Giấy phép AGPL-3.0.</p>
  </footer>
</div>
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
    log(`Đã huỷ chọn thiết bị`);
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
    box.innerHTML = '<div class="banner err">Trang phải được mở qua <b>HTTPS</b> (hoặc localhost) thì trình duyệt mới cho dùng Bluetooth.</div>';
  } else if (!serial && !ble) {
    box.innerHTML = '<div class="banner err">Trình duyệt này không hỗ trợ Web Serial / Web Bluetooth. Hãy mở bằng <b>Google Chrome</b> hoặc <b>Microsoft Edge</b> bản desktop (Safari và Firefox chưa hỗ trợ).</div>';
  } else if (!serial) {
    box.innerHTML = '<div class="banner warn">Trình duyệt chưa có Web Serial → không kết nối được Mi Band 9/10 (Bluetooth Classic). Dùng Chrome/Edge desktop bản 117 trở lên.</div>';
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
      log('Chọn cổng "Bluetooth SPP" của band trong hộp thoại…');
      link = new StreamLink(await SerialTransport.request(), 'detect');
    } else {
      log('Chọn band trong danh sách Bluetooth…');
      const c = await requestBle();
      link = c.kind === 'v2' ? new StreamLink(c.transport, 'v2') : new BleV1Link(c.device, c.chars);
    }
    const dev = new XiaomiDevice(link, key);
    dev.onLog = (m) => log(m, m.startsWith('✓') ? 'ok' : m.startsWith('⚠') ? 'e' : undefined);
    dev.onChange = () => render();
    dev.onDisconnect = () => {
      log('Đã ngắt kết nối');
      if (device === dev) device = null;
      render();
    };
    device = dev;
    render();
    await dev.connect();
    toast('Đã kết nối band');
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
    $('device-title').textContent = connected ? 'Đã kết nối' : 'Đang kết nối…';
    $('d-model').textContent = i.model ?? '—';
    $('d-fw').textContent = i.firmware ?? '—';
    $('d-batt').textContent = i.battery !== undefined ? `${i.battery}%` : '—';
    $('d-link').textContent = device.link.name;
  }
  renderApps(connected ? device!.apps : null);
  renderFaces(connected ? device!.faces : null);
  renderCatalog();
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
  if (!apps) return void ul.appendChild(emptyItem('Chưa kết nối'));
  if (apps.length === 0) return void ul.appendChild(emptyItem('Chưa có app bên thứ ba nào'));
  for (const a of apps) {
    const li = document.createElement('li');
    li.append(nameCell(a.name, a.id), button('Xoá', async () => {
      if (!confirm(`Xoá "${a.name}" khỏi band?`)) return;
      await device!.deleteApp(a);
      toast(`Đã xoá ${a.name}`);
    }));
    ul.appendChild(li);
  }
}

function renderFaces(faces: InstalledFace[] | null): void {
  const ul = $('faces');
  ul.replaceChildren();
  if (!faces) return void ul.appendChild(emptyItem('Chưa kết nối'));
  if (faces.length === 0) return void ul.appendChild(emptyItem('Không có watchface'));
  for (const f of faces) {
    const li = document.createElement('li');
    li.appendChild(nameCell(f.name, f.id));
    if (f.active) {
      const p = document.createElement('span');
      p.className = 'pill';
      p.textContent = 'đang dùng';
      li.appendChild(p);
    } else {
      li.appendChild(button('Dùng', () => device!.setWatchface(f.id)));
      if (f.canDelete) {
        li.appendChild(button('Xoá', async () => {
          if (!confirm(`Xoá watchface "${f.name}"?`)) return;
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
    $('progress-label').textContent = '✓ Cài xong';
    log('✓ cài đặt hoàn tất', 'ok');
    toast('Đã cài lên band');
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

interface CatalogApp { id: string; name: string; description: string; file: string; icon?: string; devices?: string[] }

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
  if (catalog.length === 0) return void ul.appendChild(emptyItem('Chưa có app mẫu nào.'));
  const connected = !!device?.connected;
  const installedIds = new Set(device?.apps.map((a) => a.id) ?? []);
  for (const app of catalog) {
    const li = document.createElement('li');
    const icon = document.createElement('img');
    icon.className = 'catalog-icon';
    icon.alt = '';
    if (app.icon) icon.src = app.icon;
    icon.onerror = () => icon.replaceWith(Object.assign(document.createElement('div'), { className: 'catalog-icon', textContent: 'RPK' }));
    const name = nameCell(app.name, `${app.description}${app.devices?.length ? ` · ${app.devices.join(', ')}` : ''}`);
    const installed = installedIds.has(app.id);
    const btn = button(installed ? 'Cài lại' : 'Add', () => installFromCatalog(app), !connected || catalogBusy);
    if (!installed) btn.classList.add('primary');
    li.append(icon, name, btn);
    ul.appendChild(li);
  }
  $('catalog-hint').classList.toggle('hidden', connected);
}

async function installFromCatalog(app: CatalogApp): Promise<void> {
  if (!device?.connected) throw new Error('Chưa kết nối band');
  catalogBusy = true;
  renderCatalog();
  const label = $('progress-label');
  $('file-info').classList.remove('hidden');
  $('progress').classList.remove('hidden');
  $('f-name').textContent = app.name;
  $('f-sub').textContent = app.id;
  try {
    label.textContent = 'Đang tải app…';
    const r = await fetch(app.file);
    if (!r.ok) throw new Error(`Không tải được ${app.file} (${r.status})`);
    const parsed = parseFile(new Uint8Array(await r.arrayBuffer()));
    if (parsed.kind !== 'rpk') throw new Error(parsed.kind === 'unsupported' ? parsed.reason : 'File không phải .rpk');
    pending = parsed;
    await device.install(parsed, (pct, stage) => {
      $('progress-bar').style.width = `${pct}%`;
      label.textContent = `${stage} ${pct}%`;
    });
    label.textContent = `✓ Đã cài ${app.name}`;
    log(`✓ đã cài ${app.name}`, 'ok');
    toast(`Đã cài ${app.name} lên band`);
  } catch (e) {
    label.textContent = `✗ ${(e as Error).message}`;
    throw e;
  } finally {
    catalogBusy = false;
    render();
  }
}

// ------------------------------------------------------- key from cloud ---

interface CloudDevice { server: string; name: string; model: string; did: string; mac?: string; key?: string }

let qrAbort: AbortController | null = null;

function stopQr(): void {
  qrAbort?.abort();
  qrAbort = null;
  $('qr-panel').classList.add('hidden');
  $('btn-qr').classList.remove('hidden');
}

async function api<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error || `Lỗi máy chủ (${r.status})`);
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
  status.textContent = 'Đang tạo mã QR…';
  try {
    const qr = await api<{ qr: string; loginUrl: string; lp: string; timeout: number }>('/api/xiaomi/qr', {}, ctl.signal);
    $<HTMLImageElement>('qr-img').src = qr.qr;
    $<HTMLAnchorElement>('qr-link').href = qr.loginUrl;
    status.textContent = 'Đang chờ quét mã…';
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
    status.textContent = 'Mã QR đã hết hạn.';
    throw new Error('Mã QR hết hạn — bấm lại để tạo mã mới');
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
  log(`Tài khoản có ${devices.length} thiết bị, ${withKey.length} thiết bị Bluetooth có key`);
  if (withKey.length === 0) {
    ul.appendChild(emptyItem(devices.length
      ? `Tìm thấy ${devices.length} thiết bị nhưng không có thiết bị Bluetooth nào có key. Band có thể chỉ được ghép trong Mi Fitness mà không hiện ở đây — dùng "Cách khác" bên dưới.`
      : 'Không tìm thấy thiết bị nào. Thử chọn đúng khu vực tài khoản rồi quét lại.'));
    return;
  }
  for (const d of withKey) {
    const li = document.createElement('li');
    const valid = /^[0-9a-f]{32}$/i.test(d.key!);
    const sub = `${d.model} · ${d.mac ?? d.did} · ${d.server}${valid ? '' : ` · ⚠ key ${d.key!.length} ký tự, có thể không dùng được cho band`}`;
    li.append(nameCell(d.name || d.model, sub), button('Dùng key này', async () => {
      $<HTMLInputElement>('authkey').value = d.key!;
      toast(`Đã điền key của ${d.name || d.model}`);
      log(`Đã điền key của ${d.name || d.model} (${d.model})`, 'ok');
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

renderSupport();
render();
void loadCatalog();
log('Sẵn sàng. Nhập auth key rồi bấm kết nối.');
