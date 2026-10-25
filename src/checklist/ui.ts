import { bindImport, downloadJson, loadStored, saveStored } from '../custom-editor';
import { t } from '../i18n';
import {
  type Checklist,
  cleanChecklists,
  MAX_ITEM_LENGTH,
  MAX_ITEMS,
  MAX_LISTS,
  MAX_TITLE_LENGTH,
  moveItem,
  newId,
  normalizeChecklists,
} from '../rpk/checklist';

// Checklist editor (opened from the Checklist entry in the demo apps catalog): several lists, each
// with a title and items. Saved in this browser's localStorage only; on Add the browser packs the
// lists into the rpk (src/rpk/checklist.ts). Values typed by the user or read from an imported
// file reach the DOM through .value / textContent only.

export interface ChecklistUiDeps {
  toast: (msg: string, err?: boolean) => void;
  fail: (e: unknown) => void;
}

const STORAGE = 'miband-hack.checklists';

const TEMPLATE = `
  <p class="hint" data-i18n="checklistHint"></p>
  <div id="cl-lists"></div>
  <div class="row notes-actions">
    <button class="small" id="btn-cl-add-list" data-i18n="checklistAddList"></button>
    <button class="small ghost" id="btn-cl-export" data-i18n="notesExport"></button>
    <button class="small ghost" id="btn-cl-import" data-i18n="notesImport"></button>
    <input type="file" id="cl-file" accept=".json,application/json" class="hidden" />
    <span class="progress-label" id="cl-saved" style="margin:0 0 0 auto"></span>
  </div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let deps: ChecklistUiDeps;
let lists: Checklist[] = [];
let saveOk = true;

function sampleLists(): Checklist[] {
  return [{ id: newId(), title: t('checklistSampleTitle'), items: t('checklistSampleItems').split('|').map((text) => ({ id: newId(), text })) }];
}

function load(): Checklist[] {
  const stored = loadStored(STORAGE);
  return (stored !== undefined && normalizeChecklists(stored)) || sampleLists();
}

function save(): void {
  saveOk = saveStored(STORAGE, lists);
  renderStatus();
}

function renderStatus(): void {
  $('cl-saved').textContent = saveOk ? t('notesSaved') : t('checklistSaveFailed');
}

/** The lists as they go into the rpk (blank items and empty lists left out). */
export function checklistsForBand(): Checklist[] {
  return cleanChecklists(lists);
}

function iconButton(label: string, text: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'small ghost cl-icon';
  b.textContent = text;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.disabled = disabled;
  b.onclick = onClick;
  return b;
}

/** Re-renders after a structural change, then focuses `selector` (e.g. the moved row's button). */
function rerender(selector?: string): void {
  renderChecklistEditor();
  if (!selector) return;
  const el = document.querySelector<HTMLElement>(`#cl-lists ${selector}`);
  // A move button that just got disabled (row now first/last) cannot take focus: use its row's input.
  (el instanceof HTMLButtonElement && el.disabled ? el.parentElement?.querySelector('input') : el)?.focus();
}

function addItem(list: Checklist, at: number): void {
  if (list.items.length >= MAX_ITEMS) return deps.toast(t('checklistTooManyItems', { n: MAX_ITEMS }), true);
  const item = { id: newId(), text: '' };
  list.items.splice(at, 0, item);
  save();
  rerender(`[data-item="${item.id}"] input`);
}

function renderList(list: Checklist, li: number): HTMLElement {
  const box = document.createElement('div');
  box.className = 'cl-list';
  box.dataset.list = list.id;

  const head = document.createElement('div');
  head.className = 'cl-row cl-head';
  const title = document.createElement('input');
  title.type = 'text';
  title.className = 'cl-title';
  title.placeholder = t('checklistTitlePh');
  title.setAttribute('aria-label', t('checklistTitlePh'));
  title.maxLength = MAX_TITLE_LENGTH;
  title.value = list.title;
  title.oninput = () => {
    list.title = title.value;
    save();
  };
  title.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      // Enter in the title goes to the first item (making one if the list is empty).
      if (list.items.length) rerender(`[data-item="${list.items[0].id}"] input`);
      else addItem(list, 0);
    }
  };
  const moveList = (d: number, cls: string) => () => moveItem(lists, li, d) && (save(), rerender(`[data-list="${list.id}"] .cl-head .${cls}`));
  const up = iconButton(t('checklistListUp'), '↑', moveList(-1, 'cl-up'), li === 0);
  up.classList.add('cl-up');
  const down = iconButton(t('checklistListDown'), '↓', moveList(1, 'cl-down'), li === lists.length - 1);
  down.classList.add('cl-down');
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'small ghost';
  del.textContent = t('checklistRemoveList');
  del.onclick = () => {
    const filled = list.items.filter((i) => i.text.trim()).length;
    if (filled > 0 && !confirm(t('checklistRemoveListConfirm', { name: list.title.trim() || t('checklistUntitled'), n: filled }))) return;
    lists.splice(li, 1);
    save();
    rerender();
  };
  head.append(title, up, down, del);
  box.appendChild(head);

  const ul = document.createElement('ol');
  ul.className = 'cl-items';
  list.items.forEach((item, ii) => {
    const row = document.createElement('li');
    row.className = 'cl-row';
    row.dataset.item = item.id;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('checklistItemPh');
    input.setAttribute('aria-label', t('checklistItemLabel', { n: ii + 1 }));
    input.maxLength = MAX_ITEM_LENGTH;
    input.value = item.text;
    input.oninput = () => {
      item.text = input.value;
      save();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        addItem(list, ii + 1);
      } else if (e.key === 'Backspace' && input.value === '' && list.items.length > 1) {
        // Backspace in an empty item removes it and goes back to the one above.
        e.preventDefault();
        list.items.splice(ii, 1);
        save();
        const prev = list.items[Math.max(0, ii - 1)];
        rerender(`[data-item="${prev.id}"] input`);
      }
    };
    const moveRow = (d: number, cls: string) => () => moveItem(list.items, ii, d) && (save(), rerender(`[data-item="${item.id}"] .${cls}`));
    const iu = iconButton(t('checklistItemUp'), '↑', moveRow(-1, 'cl-up'), ii === 0);
    iu.classList.add('cl-up');
    const idn = iconButton(t('checklistItemDown'), '↓', moveRow(1, 'cl-down'), ii === list.items.length - 1);
    idn.classList.add('cl-down');
    const ix = iconButton(t('checklistItemRemove'), '✕', () => {
      list.items.splice(ii, 1);
      save();
      const next = list.items[Math.min(ii, list.items.length - 1)];
      rerender(next ? `[data-item="${next.id}"] input` : `[data-list="${list.id}"] .cl-add`);
    });
    row.append(input, iu, idn, ix);
    ul.appendChild(row);
  });
  box.appendChild(ul);

  const foot = document.createElement('div');
  foot.className = 'row cl-foot';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'small cl-add';
  add.textContent = t('checklistAddItem');
  add.disabled = list.items.length >= MAX_ITEMS;
  add.onclick = () => addItem(list, list.items.length);
  const count = document.createElement('span');
  count.className = 'progress-label';
  count.textContent = t('checklistItemCount', { n: list.items.filter((i) => i.text.trim()).length, max: MAX_ITEMS });
  foot.append(add, count);
  box.appendChild(foot);
  return box;
}

/** Re-renders all lists; only called on structural changes and language switches so typing keeps focus. */
export function renderChecklistEditor(): void {
  if (!deps) return;
  renderStatus();
  $('cl-lists').replaceChildren(...lists.map(renderList));
  $<HTMLButtonElement>('btn-cl-add-list').disabled = lists.length >= MAX_LISTS;
}

async function importFile(file: File): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(t('checklistImportBad'));
  }
  const imported = normalizeChecklists(data);
  if (!imported) throw new Error(t('checklistImportBad'));
  const current = cleanChecklists(lists).length;
  if (current > 0 && !confirm(t('checklistReplaceConfirm', { n: current, m: imported.length }))) return;
  lists = imported;
  save();
  renderChecklistEditor();
  deps.toast(t('checklistImported', { n: imported.length }));
}

export function mountChecklist(root: HTMLElement, d: ChecklistUiDeps): void {
  deps = d;
  root.innerHTML = TEMPLATE; // static markup; text filled in by applyI18n()
  lists = load();
  $('btn-cl-add-list').onclick = () => {
    if (lists.length >= MAX_LISTS) return;
    const list: Checklist = { id: newId(), title: '', items: [{ id: newId(), text: '' }] };
    lists.push(list);
    save();
    rerender(`[data-list="${list.id}"] .cl-title`);
  };
  $('btn-cl-export').onclick = () => downloadJson('miband-checklists', { app: 'miband-hack-checklist', version: 1, exported: new Date().toISOString(), lists });
  bindImport($('btn-cl-import'), $<HTMLInputElement>('cl-file'), importFile, d.fail);
}
