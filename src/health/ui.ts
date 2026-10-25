import type { XiaomiDevice } from '../device';
import { t } from '../i18n';
import { buildHealthData, CSV_KINDS, type CsvKind, csvZip, rawZip, toCsv } from './export';
import type { HealthFile } from './files';
import { toChunks } from './query';
import type { HealthData } from './schema';

// "Health data" section: fetch recorded files from the band, download them (JSON / CSV / raw zip),
// and optionally upload the decoded records to the cloud API for an AI agent. Values from the band
// and from the server reach the DOM through textContent only.

export interface HealthUiDeps {
  device: () => XiaomiDevice | null;
  log: (msg: string, cls?: 'e' | 'ok') => void;
  toast: (msg: string, err?: boolean) => void;
  fail: (e: unknown) => void;
}

const OWNER_KEY_STORAGE = 'miband-hack.health-owner-key';
const UPLOAD_BATCH = 40; // chunks per request, the Worker's limit

const TEMPLATE = `
  <h2><span data-i18n="healthTitle"></span></h2>
  <p class="hint" data-i18n="healthIntro"></p>
  <div class="row health-range">
    <label for="h-from" data-i18n="healthFrom"></label><input type="date" id="h-from" />
    <label for="h-to" data-i18n="healthTo"></label><input type="date" id="h-to" />
    <button class="primary" id="btn-h-fetch" disabled data-i18n="healthFetch"></button>
  </div>
  <label class="check"><input type="checkbox" id="h-ack" /> <span data-i18n="healthAck"></span></label>
  <div class="progress hidden" id="h-progress"><div id="h-progress-bar"></div></div>
  <div class="progress-label" id="h-status"></div>
  <div id="h-result" class="hidden">
    <ul class="list" id="h-summary"></ul>
    <div class="row health-downloads">
      <button class="small primary" id="btn-h-json" data-i18n="healthJson"></button>
      <select id="h-csv-kind" aria-label="CSV"></select>
      <button class="small" id="btn-h-csv" data-i18n="healthCsv"></button>
      <button class="small" id="btn-h-csv-all" data-i18n="healthCsvAll"></button>
      <button class="small" id="btn-h-raw" data-i18n="healthRaw"></button>
    </div>
    <p class="hint" data-i18n-html="healthMcpHint"></p>
  </div>

  <details id="h-cloud">
    <summary data-i18n="cloudTitle"></summary>
    <div class="cloud-explain" data-i18n-html="cloudExplain"></div>
    <div id="cloud-off">
      <label class="check"><input type="checkbox" id="cloud-consent" /> <span data-i18n="cloudConsent"></span></label>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="btn-cloud-create" disabled data-i18n="cloudCreate"></button>
      </div>
      <details>
        <summary data-i18n="cloudHaveKey"></summary>
        <div class="row" style="margin-top:8px">
          <input type="password" id="cloud-owner-key" autocomplete="off" spellcheck="false" placeholder="mbh_…" style="flex:1;min-width:200px" />
          <button class="small" id="btn-cloud-use-key" data-i18n="cloudUseKey"></button>
        </div>
      </details>
    </div>
    <div id="cloud-on" class="hidden">
      <div id="cloud-secret" class="secret hidden">
        <p id="cloud-secret-label"></p>
        <code id="cloud-secret-value"></code>
        <div class="row"><button class="small" id="btn-cloud-copy" data-i18n="cloudCopy"></button></div>
        <pre class="log hidden" id="cloud-snippet"></pre>
      </div>
      <p class="progress-label" id="cloud-account"></p>
      <div class="row">
        <button class="small primary" id="btn-cloud-upload" disabled data-i18n="cloudUpload"></button>
        <span class="progress-label" id="cloud-upload-status" style="margin:0"></span>
      </div>
      <div class="row" style="margin-top:10px">
        <label for="cloud-retention" style="margin:0;font-weight:400;color:var(--muted)" data-i18n="cloudRetention"></label>
        <select id="cloud-retention">
          <option value="7">7</option><option value="30">30</option><option value="90">90</option><option value="365">365</option>
        </select>
      </div>
      <h3 data-i18n="cloudKeys"></h3>
      <ul class="list" id="cloud-keys"></ul>
      <div class="row" style="margin-top:8px">
        <input type="text" id="cloud-key-label" maxlength="60" data-i18n-placeholder="cloudKeyLabelPh" style="flex:1;min-width:160px" />
        <button class="small" id="btn-cloud-new-key" data-i18n="cloudNewKey"></button>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="small ghost" id="btn-cloud-forget" data-i18n="cloudForget"></button>
        <button class="small danger" id="btn-cloud-delete" data-i18n="cloudDelete"></button>
      </div>
    </div>
  </details>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let deps: HealthUiDeps;
let files: HealthFile[] = [];
let data: HealthData | null = null;
let fetching = false;

// ------------------------------------------------------------- helpers ---

function localDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The chosen local days as [from, to) in unix ms. */
function rangeMs(): { from: number; to: number } {
  const from = new Date(`${$<HTMLInputElement>('h-from').value}T00:00:00`).getTime();
  const to = new Date(`${$<HTMLInputElement>('h-to').value}T00:00:00`).getTime() + 86_400_000;
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw new Error(t('healthBadRange'));
  return { from, to };
}

function download(name: string, bytes: Uint8Array | string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = (): string => new Date().toISOString().slice(0, 10);

function storedOwnerKey(): string | null {
  try { return localStorage.getItem(OWNER_KEY_STORAGE); } catch { return null; }
}

function storeOwnerKey(v: string | null): void {
  try { v ? localStorage.setItem(OWNER_KEY_STORAGE, v) : localStorage.removeItem(OWNER_KEY_STORAGE); } catch { /* storage blocked */ }
}

async function api<T>(method: string, path: string, body?: unknown, key = storedOwnerKey()): Promise<T> {
  const r = await fetch(`/api/health${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(res.error || t('serverError', { status: r.status }));
  return res;
}

// --------------------------------------------------------------- fetch ---

async function fetchFromBand(): Promise<void> {
  const dev = deps.device();
  if (!dev?.connected) throw new Error(t('notConnected'));
  const { from, to } = rangeMs();
  fetching = true;
  renderHealth();
  $('h-progress').classList.remove('hidden');
  const status = $('h-status');
  status.textContent = t('healthListing');
  try {
    const res = await dev.fetchHealth({ from: Math.floor(from / 1000), to: Math.floor(to / 1000), ack: $<HTMLInputElement>('h-ack').checked }, (done, total) => {
      $('h-progress-bar').style.width = `${total ? Math.round((done * 100) / total) : 100}%`;
      status.textContent = t('healthProgress', { done, total });
    });
    files = res.files;
    data = buildHealthData(files, { from, to, device: { model: dev.info.model, firmware: dev.info.firmware } });
    status.textContent = res.listed === 0 ? t('healthNothing') : t('healthDone', { n: files.length, failed: res.failed.length, listed: res.listed });
    deps.log(`✓ health: ${files.length} files fetched, ${res.failed.length} failed`, 'ok');
  } catch (e) {
    status.textContent = `✗ ${(e as Error).message}`;
    throw e;
  } finally {
    fetching = false;
    renderHealth();
  }
}

function renderSummary(): void {
  const ul = $('h-summary');
  ul.replaceChildren();
  if (!data) return;
  const d = data;
  const decoded = { full: 0, partial: 0, raw: 0 };
  for (const f of d.files) decoded[f.decoded]++;
  const rows: [string, number][] = [
    [t('healthRowMinutes'), d.activity.length],
    [t('healthRowHr'), d.heartRate.length],
    [t('healthRowSpo2'), d.spo2.length],
    [t('healthRowStress'), d.stress.length],
    [t('healthRowSleep'), d.sleep.length],
    [t('healthRowWorkouts'), d.workouts.length],
    [t('healthRowDaily'), d.daily.length],
  ];
  for (const [label, n] of rows) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = label;
    const v = document.createElement('b');
    v.textContent = String(n);
    li.append(name, v);
    ul.appendChild(li);
  }
  const li = document.createElement('li');
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = t('healthRowFiles', { full: decoded.full, partial: decoded.partial, raw: decoded.raw });
  const sub = document.createElement('small');
  sub.textContent = d.files.filter((f) => f.decoded !== 'full').map((f) => `${f.subtype}/${f.detail} v${f.version}${f.note ? `: ${f.note}` : ''}`).slice(0, 6).join(' · ');
  name.appendChild(sub);
  li.appendChild(name);
  ul.appendChild(li);
}

// --------------------------------------------------------------- cloud ---

function showSecret(label: string, key: string, snippet?: string): void {
  $('cloud-secret').classList.remove('hidden');
  $('cloud-secret-label').textContent = label;
  $('cloud-secret-value').textContent = key;
  const pre = $('cloud-snippet');
  pre.classList.toggle('hidden', !snippet);
  pre.textContent = snippet ?? '';
}

function agentSnippet(key: string): string {
  const base = `${location.origin}/api/health`;
  return [
    t('cloudSnippetMcp'),
    `claude mcp add --transport http miband-health ${base}/mcp --header "Authorization: Bearer ${key}"`,
    '',
    t('cloudSnippetRest'),
    `curl -H "Authorization: Bearer ${key}" "${base}/v1/summary?days=7"`,
  ].join('\n');
}

interface AccountInfo {
  accountId: string;
  createdAt: string;
  retentionDays: number;
  keys: { id: string; role: 'owner' | 'read'; label: string; createdAt: string; lastUsedAt: string | null; current: boolean }[];
  data: { coverage: Record<string, { firstDay: string; lastDay: string; days: number }> };
}

async function refreshCloud(): Promise<void> {
  const on = !!storedOwnerKey();
  $('cloud-off').classList.toggle('hidden', on);
  $('cloud-on').classList.toggle('hidden', !on);
  if (!on) return;
  const info = await api<AccountInfo>('GET', '/account');
  const days = Object.values(info.data.coverage).reduce((m, c) => Math.max(m, c.days), 0);
  $('cloud-account').textContent = t('cloudAccount', { id: info.accountId, days, retention: info.retentionDays });
  $<HTMLSelectElement>('cloud-retention').value = String(info.retentionDays);
  const ul = $('cloud-keys');
  ul.replaceChildren();
  for (const k of info.keys) {
    const li = document.createElement('li');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = k.role === 'owner' ? t('cloudOwnerKey') : k.label || k.id;
    const sub = document.createElement('small');
    sub.textContent = `${k.id} · ${t('cloudKeyCreated', { at: k.createdAt.slice(0, 10) })} · ${k.lastUsedAt ? t('cloudKeyUsed', { at: k.lastUsedAt.slice(0, 16).replace('T', ' ') }) : t('cloudKeyUnused')}`;
    name.appendChild(sub);
    li.appendChild(name);
    if (k.role === 'read') {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = t('cloudRevoke');
      b.onclick = async () => {
        if (!confirm(t('cloudRevokeConfirm', { name: k.label || k.id }))) return;
        b.disabled = true;
        try {
          await api('DELETE', `/keys/${k.id}`);
          await refreshCloud();
        } catch (e) {
          deps.fail(e);
          b.disabled = false;
        }
      };
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
}

async function createAccount(): Promise<void> {
  const res = await api<{ accountId: string; ownerKey: string }>('POST', '/account', {}, null);
  storeOwnerKey(res.ownerKey);
  showSecret(t('cloudOwnerShowOnce'), res.ownerKey);
  deps.log('✓ cloud account created', 'ok');
  await refreshCloud();
}

async function uploadAll(): Promise<void> {
  if (!data) throw new Error(t('cloudNothingToUpload'));
  const chunks = toChunks(data);
  const status = $('cloud-upload-status');
  let stored = 0;
  let skipped = 0;
  for (let i = 0; i < chunks.length; i += UPLOAD_BATCH) {
    status.textContent = t('cloudUploading', { done: i, total: chunks.length });
    const r = await api<{ stored: number; skippedOlderThanRetention: number }>('PUT', '/data', { chunks: chunks.slice(i, i + UPLOAD_BATCH) });
    stored += r.stored;
    skipped += r.skippedOlderThanRetention;
  }
  status.textContent = t('cloudUploaded', { n: stored, skipped });
  deps.toast(t('cloudUploaded', { n: stored, skipped }));
  await refreshCloud();
}

async function deleteEverything(): Promise<void> {
  if (!confirm(t('cloudDeleteConfirm'))) return;
  await api('DELETE', '/account');
  storeOwnerKey(null);
  $('cloud-secret').classList.add('hidden');
  deps.toast(t('cloudDeleted'));
  deps.log('✓ cloud account and all its data deleted', 'ok');
  await refreshCloud();
}

// --------------------------------------------------------------- mount ---

function wire(id: string, f: () => Promise<void> | void): void {
  const b = $<HTMLButtonElement>(id);
  b.onclick = async () => {
    b.disabled = true;
    try {
      await f();
    } catch (e) {
      deps.fail(e);
    } finally {
      b.disabled = false;
      renderHealth();
    }
  };
}

export function mountHealth(section: HTMLElement, d: HealthUiDeps): void {
  deps = d;
  section.innerHTML = TEMPLATE; // static markup only
  const today = new Date();
  $<HTMLInputElement>('h-to').value = localDateInput(today);
  $<HTMLInputElement>('h-from').value = localDateInput(new Date(today.getTime() - 6 * 86_400_000));

  wire('btn-h-fetch', fetchFromBand);
  wire('btn-h-json', () => download(`miband-health-${stamp()}.json`, JSON.stringify(data, null, 1), 'application/json'));
  wire('btn-h-csv', () => {
    const kind = $<HTMLSelectElement>('h-csv-kind').value as CsvKind;
    download(`miband-${kind}-${stamp()}.csv`, toCsv(data!, kind), 'text/csv');
  });
  wire('btn-h-csv-all', () => download(`miband-health-csv-${stamp()}.zip`, csvZip(data!), 'application/zip'));
  wire('btn-h-raw', () => download(`miband-health-raw-${stamp()}.zip`, rawZip(files, data!), 'application/zip'));

  $<HTMLInputElement>('cloud-consent').onchange = () => renderHealth();
  wire('btn-cloud-create', createAccount);
  wire('btn-cloud-use-key', async () => {
    const key = $<HTMLInputElement>('cloud-owner-key').value.trim();
    if (!/^mbh_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/.test(key)) throw new Error(t('cloudBadKey'));
    storeOwnerKey(key);
    try {
      await refreshCloud();
    } catch (e) {
      storeOwnerKey(null);
      await refreshCloud();
      throw e;
    }
    $<HTMLInputElement>('cloud-owner-key').value = '';
  });
  wire('btn-cloud-copy', async () => {
    await navigator.clipboard.writeText($('cloud-secret-value').textContent ?? '');
    deps.toast(t('cloudCopied'));
  });
  wire('btn-cloud-upload', uploadAll);
  wire('btn-cloud-new-key', async () => {
    const label = $<HTMLInputElement>('cloud-key-label').value.trim();
    const res = await api<{ id: string; key: string }>('POST', '/keys', { label });
    $<HTMLInputElement>('cloud-key-label').value = '';
    showSecret(t('cloudAgentShowOnce'), res.key, agentSnippet(res.key));
    await refreshCloud();
  });
  $<HTMLSelectElement>('cloud-retention').onchange = async (e) => {
    try {
      await api('PATCH', '/account', { retentionDays: Number((e.target as HTMLSelectElement).value) });
      await refreshCloud();
    } catch (err) {
      deps.fail(err);
    }
  };
  wire('btn-cloud-forget', async () => {
    if (!confirm(t('cloudForgetConfirm'))) return;
    storeOwnerKey(null);
    $('cloud-secret').classList.add('hidden');
    await refreshCloud();
  });
  wire('btn-cloud-delete', deleteEverything);
  $('h-cloud').addEventListener('toggle', () => {
    if (($('h-cloud') as HTMLDetailsElement).open) refreshCloud().catch(deps.fail);
  });
}

/** Re-renders state and translated option labels; called on every app render and language switch. */
export function renderHealth(): void {
  const connected = !!deps.device()?.connected;
  $<HTMLButtonElement>('btn-h-fetch').disabled = !connected || fetching;
  $('h-result').classList.toggle('hidden', !data);
  if (!fetching) $('h-progress').classList.add('hidden');
  $<HTMLButtonElement>('btn-cloud-create').disabled = !$<HTMLInputElement>('cloud-consent').checked;
  $<HTMLButtonElement>('btn-cloud-upload').disabled = !data;
  const sel = $<HTMLSelectElement>('h-csv-kind');
  const current = sel.value;
  sel.replaceChildren(
    ...CSV_KINDS.map((k) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = `${k}.csv`;
      return o;
    }),
  );
  if (current) sel.value = current;
  renderSummary();
}
