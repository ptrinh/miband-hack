import type { Key } from '../i18n';

// Custom flashcard decks: data model, limits, validation, import/export and the files the band app
// reads (demo-apps/flashcards). Pure: no DOM, no storage, so it is unit-tested in node.
// Decks live only in the browser (localStorage) and inside the re-packed .rpk.

export interface Card {
  front: string;
  back: string;
  note?: string;
}

export interface Deck {
  /** Stable id (a-z0-9): progress on the band is stored per deck id. */
  id: string;
  name: string;
  cards: Card[];
}

/**
 * Limits, chosen for the band:
 *  - text lengths: the back of a card (back + note) must be readable on a 192 x 471 design px screen
 *    at 14-22 px, a quiz choice in a quarter of the screen (it is cut with an ellipsis beyond that);
 *  - per deck: the study page parses one deck file into memory (SAT Flashcards holds 1355 entries,
 *    about 99 KB of JS, in the same way), and the scheduler loops over the deck on every tap;
 *  - in total: every deck is a file in the .rpk that goes over Bluetooth on each install.
 */
export const LIMITS = {
  decks: 30,
  cardsPerDeck: 500,
  totalCards: 2000,
  name: 30,
  front: 60,
  back: 120,
  note: 120,
  deckBytes: 96 * 1024,
  totalBytes: 512 * 1024,
} as const;

export const QUIZ_MIN_CARDS = 4; // demo-apps/flashcards/src/common/quiz.js MIN_CARDS

export const INDEX_PATH = 'common/decks.json';
export const deckPath = (i: number) => `common/deck${i}.json`;
export const FLASHCARDS_PACKAGE_ID = 'uk.trinh.miband.flashcards';

// ---------------------------------------------------------------- text ---

/** NFC (macOS and some sheets give decomposed Vietnamese), no control chars, single spaces. */
export function cleanText(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Length in characters as the user sees them (code points, so an emoji or a rare CJK ideograph counts 1). */
export const charCount = (s: string) => Array.from(s).length;

/** FNV-1a 32-bit over UTF-8, base36. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Card id = hash of its cleaned front and back: unchanged cards keep their progress on the band. */
export function cardId(front: string, back: string): string {
  return fnv(`${cleanText(front)}\u0000${cleanText(back)}`);
}

export function newDeckId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

export const isDeckId = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9]{1,16}$/.test(s);

/** A card the editor keeps but does not install: both sides empty. */
export const isBlank = (c: Card) => !cleanText(c.front) && !cleanText(c.back) && !cleanText(c.note);

// ---------------------------------------------------------- validation ---

export interface Problem {
  /** i18n key of the message. */
  code: Key;
  vars?: Record<string, string | number>;
  /** 0-based deck index. */
  deck?: number;
  /** 0-based card index in the deck. */
  card?: number;
  field?: 'name' | 'front' | 'back' | 'note';
}

const kb = (bytes: number) => Math.ceil(bytes / 1024);

/** Everything that stops the decks from being installed; an empty list means OK. */
export function validateDecks(decks: Deck[]): Problem[] {
  const out: Problem[] = [];
  if (decks.length > LIMITS.decks) out.push({ code: 'decksErrTooManyDecks', vars: { n: decks.length, max: LIMITS.decks } });
  let total = 0;
  let bytes = 0;
  decks.forEach((deck, d) => {
    const name = cleanText(deck.name);
    if (!name) out.push({ code: 'decksErrNameEmpty', deck: d, field: 'name' });
    else if (charCount(name) > LIMITS.name) out.push({ code: 'decksErrNameLong', vars: { max: LIMITS.name }, deck: d, field: 'name' });
    const seen = new Map<string, number>();
    let n = 0;
    deck.cards.forEach((card, c) => {
      if (isBlank(card)) return;
      n++;
      const f = cleanText(card.front);
      const b = cleanText(card.back);
      const note = cleanText(card.note);
      const at = { deck: d, card: c };
      if (!f) out.push({ code: 'decksErrFrontEmpty', ...at, field: 'front' });
      else if (charCount(f) > LIMITS.front) out.push({ code: 'decksErrFrontLong', vars: { n: charCount(f), max: LIMITS.front }, ...at, field: 'front' });
      if (!b) out.push({ code: 'decksErrBackEmpty', ...at, field: 'back' });
      else if (charCount(b) > LIMITS.back) out.push({ code: 'decksErrBackLong', vars: { n: charCount(b), max: LIMITS.back }, ...at, field: 'back' });
      if (charCount(note) > LIMITS.note) out.push({ code: 'decksErrNoteLong', vars: { n: charCount(note), max: LIMITS.note }, ...at, field: 'note' });
      if (f && b) {
        const key = `${f}\u0000${b}`.toLowerCase();
        const other = seen.get(key);
        if (other !== undefined) out.push({ code: 'decksErrDuplicate', vars: { other: other + 1 }, ...at, field: 'front' });
        else seen.set(key, c);
      }
    });
    total += n;
    if (n > LIMITS.cardsPerDeck) out.push({ code: 'decksErrDeckCards', vars: { n, max: LIMITS.cardsPerDeck }, deck: d });
    const size = deckFileBytes(deck);
    bytes += size;
    if (size > LIMITS.deckBytes) out.push({ code: 'decksErrDeckBytes', vars: { kb: kb(size), max: kb(LIMITS.deckBytes) }, deck: d });
  });
  if (total > LIMITS.totalCards) out.push({ code: 'decksErrTotalCards', vars: { n: total, max: LIMITS.totalCards } });
  if (bytes > LIMITS.totalBytes) out.push({ code: 'decksErrTotalBytes', vars: { kb: kb(bytes), max: kb(LIMITS.totalBytes) } });
  return out;
}

export function countCards(decks: Deck[]): number {
  return decks.reduce((n, d) => n + d.cards.filter((c) => !isBlank(c)).length, 0);
}

// -------------------------------------------------------- band files ---

/** The deck's cards as the band app reads them: "id\tfront\tback\tnote", ids unique in the deck. */
export function bandCards(deck: Deck): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (const card of deck.cards) {
    if (isBlank(card)) continue;
    const front = cleanText(card.front);
    const back = cleanText(card.back);
    const note = cleanText(card.note);
    let id = cardId(front, back);
    // Same front and back twice is a validation error; this only guards against a hash collision.
    for (let k = 2; used.has(id); k++) id = `${cardId(front, back)}x${k}`;
    used.add(id);
    out.push(note ? `${id}\t${front}\t${back}\t${note}` : `${id}\t${front}\t${back}`);
  }
  return out;
}

function deckJson(deck: Deck): string {
  return JSON.stringify({ v: 1, id: deck.id, name: cleanText(deck.name), cards: bandCards(deck) });
}

function deckFileBytes(deck: Deck): number {
  return new TextEncoder().encode(deckJson(deck)).length;
}

/**
 * The files to put into the Flashcards rpk: common/decks.json (the list) and common/deck<N>.json
 * (one per deck). Throws the first validation problem's code if the decks cannot be installed.
 */
export function bandFiles(decks: Deck[]): Record<string, Uint8Array> {
  const problems = validateDecks(decks);
  if (problems.length) throw Object.assign(new Error(problems[0].code), { problems });
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  const index = decks.map((deck, i) => {
    files[deckPath(i)] = enc.encode(deckJson(deck));
    return { id: deck.id, name: cleanText(deck.name), n: bandCards(deck).length, file: `/${deckPath(i)}` };
  });
  files[INDEX_PATH] = enc.encode(JSON.stringify({ v: 1, decks: index }));
  return files;
}

// ------------------------------------------------- CSV / TSV import ---

export interface RowProblem {
  /** 1-based line number in the pasted text or file. */
  line: number;
  code: Key;
}

export interface ParsedRows {
  cards: Card[];
  problems: RowProblem[];
  /** Delimiter that was detected. */
  delimiter: '\t' | ',' | ';';
}

const HEADERS = new Set([
  'front', 'back', 'note', 'notes', 'question', 'answer', 'term', 'definition', 'word', 'meaning', 'example',
  'mặt trước', 'mặt sau', 'ghi chú', 'câu hỏi', 'đáp án', 'từ', 'nghĩa', 'ví dụ',
  '正面', '背面', '备注', '问题', '答案', '单词', '词语', '释义', '例句',
]);

function detectDelimiter(text: string): '\t' | ',' | ';' {
  // First non-empty line, ignoring quoted parts.
  const first = text.split(/\r\n|\n|\r/).find((l) => l.trim()) ?? '';
  const bare = first.replace(/"[^"]*"/g, '');
  if (bare.includes('\t')) return '\t';
  const semi = bare.split(';').length - 1;
  const comma = bare.split(',').length - 1;
  return semi > comma ? ';' : ',';
}

/** RFC 4180 rows (quoted fields, "" escapes, line breaks inside quotes), each with its first line number. */
export function splitRows(text: string, delimiter: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let atStart = true; // at the start of a cell (a quote here opens a quoted cell)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
      atStart = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      rows.push({ line: rowLine, cells });
      cells = [];
      cell = '';
      atStart = true;
      line++;
      rowLine = line;
    } else {
      cell += ch;
      atStart = false;
    }
  }
  if (cell !== '' || cells.length) {
    cells.push(cell);
    rows.push({ line: rowLine, cells });
  }
  return rows;
}

/**
 * Parses pasted spreadsheet cells, TSV or CSV (comma or semicolon) into cards: column 1 = front,
 * 2 = back, 3 = note (optional); further columns are ignored. A header row is skipped.
 */
export function parseDelimited(text: string): ParsedRows {
  const clean = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(clean);
  const cards: Card[] = [];
  const problems: RowProblem[] = [];
  if (clean.includes('\uFFFD')) problems.push({ line: 0, code: 'decksImportNotUtf8' });
  let first = true;
  for (const row of splitRows(clean, delimiter)) {
    const cells = row.cells.map(cleanText);
    if (cells.every((c) => !c)) continue;
    const header = first && HEADERS.has(cells[0].toLowerCase()) && HEADERS.has((cells[1] ?? '').toLowerCase());
    first = false;
    if (header) continue;
    if (cells.length < 2 || !cells[0] || !cells[1]) {
      problems.push({ line: row.line, code: 'decksImportRowCols' });
      continue;
    }
    cards.push(cells[2] ? { front: cells[0], back: cells[1], note: cells[2] } : { front: cells[0], back: cells[1] });
  }
  return { cards, problems, delimiter };
}

// ------------------------------------------------------- JSON import/export ---

export const EXPORT_APP = 'miband-hack-flashcards';

export function exportJson(decks: Deck[], now = new Date()): string {
  return JSON.stringify(
    {
      app: EXPORT_APP,
      version: 1,
      exported: now.toISOString(),
      decks: decks.map((d) => ({ id: d.id, name: d.name, cards: d.cards.filter((c) => !isBlank(c)) })),
    },
    null,
    2,
  );
}

function toCard(o: unknown): Card | null {
  if (Array.isArray(o)) {
    if (typeof o[0] !== 'string' || typeof o[1] !== 'string') return null;
    return typeof o[2] === 'string' && o[2] ? { front: o[0], back: o[1], note: o[2] } : { front: o[0], back: o[1] };
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const front = r.front ?? r.question ?? r.term;
  const back = r.back ?? r.answer ?? r.definition;
  const note = r.note ?? r.example;
  if (typeof front !== 'string' || typeof back !== 'string') return null;
  return typeof note === 'string' && note ? { front, back, note } : { front, back };
}

function toDeck(o: unknown, fallbackName: string): Deck | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (!Array.isArray(r.cards)) return null;
  const cards = r.cards.map(toCard);
  if (cards.some((c) => !c)) return null;
  return {
    id: isDeckId(r.id) ? r.id : newDeckId(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name : fallbackName,
    cards: cards as Card[],
  };
}

/**
 * Accepts our export ({decks:[…]}), one deck ({name, cards}), or a bare card list
 * ([{front, back, note}] or [[front, back, note]]). Returns null if it is none of these.
 */
export function parseJsonImport(text: string, fallbackName: string): Deck[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (Array.isArray(data)) {
    const cards = data.map(toCard);
    if (cards.some((c) => !c)) return null;
    return [{ id: newDeckId(), name: fallbackName, cards: cards as Card[] }];
  }
  const r = data as Record<string, unknown> | null;
  if (r && Array.isArray(r.decks)) {
    const decks = r.decks.map((d, i) => toDeck(d, `${fallbackName} ${i + 1}`));
    return decks.some((d) => !d) ? null : (decks as Deck[]);
  }
  const one = toDeck(r, fallbackName);
  return one ? [one] : null;
}

/** Gives every deck a unique id (imported decks may repeat an id already in use). */
export function uniqueIds(decks: Deck[]): Deck[] {
  const used = new Set<string>();
  return decks.map((d) => {
    let id = isDeckId(d.id) ? d.id : newDeckId();
    while (used.has(id)) id = newDeckId();
    used.add(id);
    return id === d.id ? d : { ...d, id };
  });
}

/** Restores decks saved by the editor; anything malformed is dropped. */
export function loadSaved(raw: string | null): Deck[] | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return null;
    return uniqueIds(data.map((d, i) => toDeck(d, `Deck ${i + 1}`)).filter((d): d is Deck => !!d));
  } catch {
    return null;
  }
}
