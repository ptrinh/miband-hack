import { buildCustomRpk, type CustomRpkOptions } from './custom';
import type { RpkSigner } from './sign';

// Checklist demo app: lists written in the webapp, ticked off on the band. The lists travel in
// common/lists.json inside the rpk; the band keeps the tick state itself (@system.storage), keyed
// by list id and item id, so re-installing an edited list keeps the ticks of items that still exist.

export interface ChecklistItem {
  id: string;
  text: string;
}

export interface Checklist {
  id: string;
  title: string;
  items: ChecklistItem[];
}

/** Path of the lists file inside the Checklist rpk (read on the band with @system.file). */
export const CHECKLIST_PATH = 'common/lists.json';
export const CHECKLIST_PACKAGE_ID = 'uk.trinh.miband.checklist';
export const MAX_LISTS = 30;
export const MAX_ITEMS = 100;
export const MAX_TITLE_LENGTH = 40;
export const MAX_ITEM_LENGTH = 100;
/** Upper bound for the serialized lists.json (the band reads it into memory in one go). */
export const MAX_CHECKLIST_BYTES = 100 * 1024;

/** Ids are short [a-z0-9] strings; the band joins them into its storage value. */
export const ID_PATTERN = /^[a-z0-9]{1,16}$/;

/** A random 8-character id (about 41 bits), unique enough for one person's lists. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/**
 * Turns anything list-shaped into valid checklists: our export ({lists}), the app's own
 * lists.json, or a bare array of lists. Items may be strings or {id?, text}. Missing, invalid or
 * duplicate ids get fresh ones; text is cut to the length limits; extra lists/items are dropped.
 * Empty items are kept (the editor shows them). Returns null when `data` holds no lists at all.
 */
export function normalizeChecklists(data: unknown, makeId: () => string = newId): Checklist[] | null {
  const raw = Array.isArray(data) ? data : (data as { lists?: unknown } | null)?.lists;
  if (!Array.isArray(raw)) return null;
  const used = new Set<string>();
  const id = (v: unknown): string => {
    let s = str(v).toLowerCase();
    while (!ID_PATTERN.test(s) || used.has(s)) s = makeId();
    used.add(s);
    return s;
  };
  const lists: Checklist[] = [];
  for (const l of raw.slice(0, MAX_LISTS)) {
    if (!l || typeof l !== 'object') return null;
    const o = l as { id?: unknown; title?: unknown; items?: unknown };
    if (o.items !== undefined && !Array.isArray(o.items)) return null;
    const items: ChecklistItem[] = [];
    for (const it of ((o.items as unknown[]) ?? []).slice(0, MAX_ITEMS)) {
      const io = (typeof it === 'string' ? { text: it } : it) as { id?: unknown; text?: unknown } | null;
      if (!io || typeof io !== 'object') return null;
      items.push({ id: id(io.id), text: str(io.text).slice(0, MAX_ITEM_LENGTH) });
    }
    lists.push({ id: id(o.id), title: str(o.title).slice(0, MAX_TITLE_LENGTH), items });
  }
  return lists;
}

/** The lists as the band gets them: blank items dropped, lists with no title and no items dropped. */
export function cleanChecklists(lists: Checklist[]): Checklist[] {
  return lists
    .map((l) => ({ id: l.id, title: l.title.trim(), items: l.items.map((i) => ({ id: i.id, text: i.text.trim() })).filter((i) => i.text) }))
    .filter((l) => l.title || l.items.length);
}

export function serializeChecklists(lists: Checklist[]): Uint8Array {
  if (lists.length > MAX_LISTS) throw new Error(`too many lists: ${lists.length} (max ${MAX_LISTS})`);
  const ids = new Set<string>();
  const checkId = (id: string, where: string) => {
    if (!ID_PATTERN.test(id) || ids.has(id)) throw new Error(`${where}: id must be unique [a-z0-9]{1,16}`);
    ids.add(id);
  };
  lists.forEach((l, i) => {
    if (!l || typeof l.title !== 'string' || !Array.isArray(l.items)) throw new Error(`lists[${i}]: title and items required`);
    checkId(l.id, `lists[${i}]`);
    if (l.title.length > MAX_TITLE_LENGTH) throw new Error(`lists[${i}]: title longer than ${MAX_TITLE_LENGTH}`);
    if (l.items.length > MAX_ITEMS) throw new Error(`lists[${i}]: more than ${MAX_ITEMS} items`);
    l.items.forEach((it, j) => {
      if (!it || typeof it.text !== 'string') throw new Error(`lists[${i}].items[${j}]: text must be a string`);
      checkId(it.id, `lists[${i}].items[${j}]`);
      if (it.text.length > MAX_ITEM_LENGTH) throw new Error(`lists[${i}].items[${j}]: longer than ${MAX_ITEM_LENGTH}`);
    });
  });
  const clean = lists.map((l) => ({ id: l.id, title: l.title, items: l.items.map((it) => ({ id: it.id, text: it.text })) }));
  const bytes = new TextEncoder().encode(JSON.stringify({ lists: clean }));
  if (bytes.length > MAX_CHECKLIST_BYTES) throw new Error(`lists too large: ${bytes.length} bytes (max ${MAX_CHECKLIST_BYTES})`);
  return bytes;
}

/**
 * Returns a signed Checklist rpk whose common/lists.json holds `lists` (cleaned first).
 * `template` is public/apps/checklist.rpk. Signs with the public demo key unless another signer is given.
 */
export async function buildChecklistRpk(template: Uint8Array, lists: Checklist[], signer?: RpkSigner, options?: CustomRpkOptions): Promise<Uint8Array> {
  return buildCustomRpk(template, CHECKLIST_PATH, serializeChecklists(cleanChecklists(lists)), signer, options);
}

/** Moves element `i` of `arr` by `delta` (in place); returns false when it would leave the array. */
export function moveItem<T>(arr: T[], i: number, delta: number): boolean {
  const j = i + delta;
  if (i < 0 || i >= arr.length || j < 0 || j >= arr.length) return false;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return true;
}
