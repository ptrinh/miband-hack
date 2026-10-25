import type { XiaomiDevice } from '../device';
import { t } from '../i18n';
import { buildHealthData, CSV_KINDS, type CsvKind, csvZip, rawZip, toCsv } from './export';
import type { HealthFile } from './files';
import type { HealthData } from './schema';

// "Health data" section: fetch recorded files from the band and download them (JSON / CSV / raw zip).
// Nothing is sent to or stored on any server. Values from the band reach the DOM through textContent only.

export interface HealthUiDeps {
  device: () => XiaomiDevice | null;
  log: (msg: string, cls?: 'e' | 'ok') => void;
  toast: (msg: string, err?: boolean) => void;
  fail: (e: unknown) => void;
}

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
}

/** Re-renders state and translated option labels; called on every app render and language switch. */
export function renderHealth(): void {
  const connected = !!deps.device()?.connected;
  $<HTMLButtonElement>('btn-h-fetch').disabled = !connected || fetching;
  $('h-result').classList.toggle('hidden', !data);
  if (!fetching) $('h-progress').classList.add('hidden');
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
