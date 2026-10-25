import { bindImport, downloadJson, loadStored, saveStored } from '../custom-editor';
import { t } from '../i18n';
import {
  type Card, type Deck, type Problem, countCards, exportJson, isBlank, LIMITS, loadSaved, newDeckId,
  parseDelimited, parseJsonImport, QUIZ_MIN_CARDS, uniqueIds, validateDecks,
} from './model';

// Editor for the Flashcards app's decks, shown under the catalog like the Notes editor.
// Decks are kept in this browser only (localStorage) and go to the band inside the re-packed rpk.
// Everything typed or imported reaches the DOM through textContent / input.value only.

export interface DecksUiDeps {
  toast: (msg: string, err?: boolean) => void;
  fail: (e: unknown) => void;
}

const STORAGE = 'miband-hack.decks';
const MAX_SHOWN_PROBLEMS = 8;

const TEMPLATE = `
  <p class="hint" data-i18n="decksHint"></p>
  <p class="hint" id="dk-limits"></p>
  <div class="row deck-bar">
    <select id="dk-select"></select>
    <button class="small" id="dk-new" data-i18n="decksNew"></button>
    <button class="small ghost danger" id="dk-delete" data-i18n="decksDelete"></button>
  </div>
  <input type="text" id="dk-name" class="deck-name" data-i18n-placeholder="decksNamePh" />
  <p class="progress-label" id="dk-count"></p>
  <div id="dk-problems" class="deck-problems hidden" role="status">
    <b data-i18n="decksProblems"></b>
    <ul id="dk-problem-list"></ul>
  </div>
  <div id="dk-cards" class="deck-cards"></div>
  <div class="row notes-actions">
    <button class="small" id="dk-add-card" data-i18n="decksAddCard"></button>
  </div>
  <details class="deck-import">
    <summary data-i18n="decksPasteTitle"></summary>
    <label for="dk-paste" class="deck-paste-label" data-i18n="decksPasteLabel"></label>
    <textarea id="dk-paste" rows="5" spellcheck="false" data-i18n-placeholder="decksPastePh"></textarea>
    <div class="row notes-actions">
      <button class="small" id="dk-paste-append" data-i18n="decksPasteAppend"></button>
      <button class="small ghost" id="dk-paste-replace" data-i18n="decksPasteReplace"></button>
    </div>
  </details>
  <div class="row notes-actions">
    <button class="small ghost" id="dk-import" data-i18n="decksImportFile"></button>
    <input type="file" id="dk-file" accept=".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values,text/plain,application/json" class="hidden" />
    <button class="small ghost" id="dk-export" data-i18n="decksExport"></button>
    <span class="progress-label" id="dk-saved" style="margin:0 0 0 auto"></span>
  </div>
`;

let deps: DecksUiDeps;
let root: HTMLElement;
let decks: Deck[] = [];
let current = 0;
let saveOk = true;
let problems: Problem[] = [];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

// -------------------------------------------------------------- state ---

function sampleDeck(): Deck {
  return { id: 'capitals', name: t('decksSampleName'), cards: parseDelimited(t('decksSampleCards')).cards };
}

function load(): Deck[] {
  const stored = loadStored(STORAGE);
  return (stored !== undefined && loadSaved(JSON.stringify(stored))) || [sampleDeck()];
}

function save(): void {
  saveOk = saveStored(STORAGE, decks);
  $('dk-saved').textContent = saveOk ? t('decksSaved') : t('decksSaveFailed');
}

const deck = (): Deck | undefined => decks[current];

// ------------------------------------------------------------- render ---

function problemText(p: Problem): string {
  const msg = t(p.code, p.vars);
  if (p.deck === undefined) return msg;
  const name = decks[p.deck]?.name.trim() || t('decksUntitled');
  return p.card === undefined ? t('decksProblemDeck', { deck: name, msg }) : t('decksProblemCard', { deck: name, card: p.card + 1, msg });
}

/** Re-validates and updates the counts, the problem list and the invalid-field marks. Cheap enough per keystroke. */
function renderStatus(): void {
  problems = validateDecks(decks);
  const d = deck();
  $('dk-count').textContent = d
    ? t('decksCount', { n: d.cards.filter((c) => !isBlank(c)).length, total: countCards(decks), max: LIMITS.totalCards })
      + (d.cards.filter((c) => !isBlank(c)).length < QUIZ_MIN_CARDS ? ` · ${t('decksQuizOff', { min: QUIZ_MIN_CARDS })}` : '')
    : '';
  const list = $('dk-problem-list');
  list.replaceChildren(
    ...problems.slice(0, MAX_SHOWN_PROBLEMS).map((p) => Object.assign(document.createElement('li'), { textContent: problemText(p) })),
  );
  if (problems.length > MAX_SHOWN_PROBLEMS) list.appendChild(Object.assign(document.createElement('li'), { textContent: t('decksMore', { n: problems.length - MAX_SHOWN_PROBLEMS }) }));
  $('dk-problems').classList.toggle('hidden', problems.length === 0);
  // Mark fields of the deck on screen.
  root.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
  for (const p of problems) {
    if (p.deck !== current || !p.field) continue;
    const el = p.field === 'name' ? $('dk-name') : root.querySelector(`[data-card="${p.card}"][data-field="${p.field}"]`);
    el?.setAttribute('aria-invalid', 'true');
  }
}

function renderSelect(): void {
  const sel = $<HTMLSelectElement>('dk-select');
  sel.replaceChildren(
    ...decks.map((d, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${d.name.trim() || t('decksUntitled')} (${d.cards.filter((c) => !isBlank(c)).length})`;
      return o;
    }),
  );
  sel.value = String(current);
  sel.disabled = decks.length === 0;
  $<HTMLButtonElement>('dk-delete').disabled = decks.length === 0;
  $<HTMLButtonElement>('dk-new').disabled = decks.length >= LIMITS.decks;
}

function input(card: Card, i: number, field: 'front' | 'back' | 'note'): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  el.value = card[field] ?? '';
  el.placeholder = t(field === 'front' ? 'decksFrontPh' : field === 'back' ? 'decksBackPh' : 'decksNotePh');
  el.setAttribute('aria-label', `${el.placeholder} ${i + 1}`);
  el.dataset.card = String(i);
  el.dataset.field = field;
  el.oninput = () => {
    card[field] = el.value;
    save();
    renderStatus();
  };
  el.onchange = () => renderSelect();
  return el;
}

/** Re-renders the card rows; only called on add/remove/import/deck switch so typing keeps focus. */
function renderCards(): void {
  const box = $('dk-cards');
  const d = deck();
  $<HTMLInputElement>('dk-name').value = d?.name ?? '';
  $<HTMLInputElement>('dk-name').disabled = !d;
  $<HTMLButtonElement>('dk-add-card').disabled = !d;
  if (!d) {
    box.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: t('decksNone') }));
    return;
  }
  box.replaceChildren(
    ...d.cards.map((card, i) => {
      const row = document.createElement('div');
      row.className = 'deck-card';
      const num = Object.assign(document.createElement('span'), { className: 'deck-num', textContent: String(i + 1) });
      const del = document.createElement('button');
      del.className = 'small ghost';
      del.textContent = '×';
      del.title = t('decksRemoveCard');
      del.setAttribute('aria-label', `${t('decksRemoveCard')} ${i + 1}`);
      del.onclick = () => {
        d.cards.splice(i, 1);
        save();
        renderAll();
      };
      row.append(num, input(card, i, 'front'), input(card, i, 'back'), input(card, i, 'note'), del);
      return row;
    }),
  );
}

function renderAll(): void {
  if (current >= decks.length) current = Math.max(0, decks.length - 1);
  renderSelect();
  renderCards();
  renderStatus();
}

/** Re-applies translated text (placeholders are set by applyI18n; dynamic parts here). */
export function renderDecksEditor(): void {
  if (!root) return;
  $('dk-limits').textContent = t('decksLimits', {
    front: LIMITS.front, back: LIMITS.back, note: LIMITS.note, perDeck: LIMITS.cardsPerDeck, total: LIMITS.totalCards, decks: LIMITS.decks,
  });
  $('dk-saved').textContent = saveOk ? t('decksSaved') : t('decksSaveFailed');
  $('dk-select').setAttribute('aria-label', t('decksDeckLabel'));
  renderAll();
}

// ------------------------------------------------------------ import ---

function addCards(cards: Card[], replace: boolean): boolean {
  let d = deck();
  if (!d) {
    d = { id: newDeckId(), name: t('decksImportedName'), cards: [] };
    decks.push(d);
    current = decks.length - 1;
  }
  const existing = d.cards.filter((c) => !isBlank(c)).length;
  if (replace && existing > 0 && !confirm(t('decksReplaceConfirm', { n: existing, m: cards.length }))) return false;
  d.cards = replace ? cards : [...d.cards.filter((c) => !isBlank(c)), ...cards];
  save();
  renderAll();
  return true;
}

function importRows(text: string, replace: boolean): void {
  const { cards, problems: rowProblems } = parseDelimited(text);
  if (rowProblems.some((p) => p.code === 'decksImportNotUtf8')) deps.toast(t('decksImportNotUtf8'), true);
  if (cards.length === 0) throw new Error(t('decksImportNone'));
  if (!addCards(cards, replace)) return;
  const skipped = rowProblems.filter((p) => p.line > 0).map((p) => p.line);
  const msg = t('decksImported', { n: cards.length });
  deps.toast(skipped.length ? `${msg}. ${t('decksImportSkipped', { lines: skipped.slice(0, 10).join(', ') + (skipped.length > 10 ? '…' : '') })}` : msg, skipped.length > 0);
}

function importDecks(imported: Deck[]): void {
  // A deck with the id of one we have replaces it (re-importing an export updates it); others are added.
  const byId = new Map(decks.map((d, i) => [d.id, i]));
  const replacing = imported.filter((d) => byId.has(d.id)).length;
  if (replacing > 0 && !confirm(t('decksReplaceDecksConfirm', { n: replacing }))) return;
  for (const d of imported) {
    const i = byId.get(d.id);
    if (i !== undefined) decks[i] = d;
    else decks.push(d);
  }
  decks = uniqueIds(decks);
  current = decks.findIndex((d) => d.id === imported[0]?.id);
  save();
  renderAll();
  deps.toast(t('decksImportedDecks', { n: imported.length }));
}

async function importFile(file: File): Promise<void> {
  const text = await file.text();
  if (/\.json$/i.test(file.name) || /^\s*[[{]/.test(text.replace(/^\uFEFF/, ''))) {
    const imported = parseJsonImport(text, file.name.replace(/\.[^.]+$/, '') || t('decksImportedName'));
    if (!imported) throw new Error(t('decksImportBad'));
    importDecks(imported);
    return;
  }
  // A spreadsheet export becomes a new deck named after the file, unless the open deck is empty.
  const d = deck();
  if (d && d.cards.some((c) => !isBlank(c))) {
    if (decks.length >= LIMITS.decks) throw new Error(t('decksErrTooManyDecks', { n: decks.length + 1, max: LIMITS.decks }));
    decks.push({ id: newDeckId(), name: file.name.replace(/\.[^.]+$/, '').slice(0, LIMITS.name), cards: [] });
    current = decks.length - 1;
  }
  importRows(text, false);
}

function exportAll(): void {
  downloadJson('miband-flashcards', JSON.parse(exportJson(decks)));
}

// ------------------------------------------------------------ public ---

/** The decks to install; throws a translated message if they cannot go on the band yet. */
export function decksForInstall(): Deck[] {
  const p = validateDecks(decks);
  if (p.length) {
    showDecksEditor();
    throw new Error(`${t('decksProblems')} ${problemText(p[0])}`);
  }
  return decks;
}

function showDecksEditor(): void {
  root.classList.remove('hidden');
  renderDecksEditor();
}

export function mountDecksEditor(el: HTMLElement, d: DecksUiDeps): void {
  deps = d;
  root = el;
  root.innerHTML = TEMPLATE; // static markup only
  decks = load();

  $<HTMLSelectElement>('dk-select').onchange = (e) => {
    current = Number((e.target as HTMLSelectElement).value) || 0;
    renderAll();
  };
  $('dk-new').onclick = () => {
    if (decks.length >= LIMITS.decks) return;
    decks.push({ id: newDeckId(), name: '', cards: [{ front: '', back: '' }] });
    current = decks.length - 1;
    save();
    renderAll();
    $<HTMLInputElement>('dk-name').focus();
  };
  $('dk-delete').onclick = () => {
    const dk = deck();
    if (!dk) return;
    const n = dk.cards.filter((c) => !isBlank(c)).length;
    if (n > 0 && !confirm(t('decksDeleteConfirm', { name: dk.name.trim() || t('decksUntitled'), n }))) return;
    decks.splice(current, 1);
    save();
    renderAll();
  };
  $<HTMLInputElement>('dk-name').oninput = (e) => {
    const dk = deck();
    if (!dk) return;
    dk.name = (e.target as HTMLInputElement).value;
    save();
    renderStatus();
  };
  $('dk-name').onchange = () => renderSelect();
  $('dk-add-card').onclick = () => {
    const dk = deck();
    if (!dk) return;
    dk.cards.push({ front: '', back: '' });
    save();
    renderAll();
    root.querySelector<HTMLInputElement>(`[data-card="${dk.cards.length - 1}"][data-field="front"]`)?.focus();
  };
  const paste = (replace: boolean) => {
    try {
      importRows($<HTMLTextAreaElement>('dk-paste').value, replace);
      $<HTMLTextAreaElement>('dk-paste').value = '';
    } catch (e) {
      deps.fail(e);
    }
  };
  $('dk-paste-append').onclick = () => paste(false);
  $('dk-paste-replace').onclick = () => paste(true);
  bindImport($('dk-import'), $<HTMLInputElement>('dk-file'), importFile, deps.fail);
  $('dk-export').onclick = () => exportAll();
}
