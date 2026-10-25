import { describe, expect, it } from 'vitest';
import {
  bandCards, bandFiles, cardId, cleanText, type Deck, exportJson, INDEX_PATH, LIMITS, loadSaved, parseDelimited,
  parseJsonImport, splitRows, uniqueIds, validateDecks,
} from '../src/decks/model';
import { setLang, t } from '../src/i18n';

const td = new TextDecoder();
const deck = (cards: [string, string, string?][], name = 'Deck', id = 'd1'): Deck => ({
  id,
  name,
  cards: cards.map(([front, back, note]) => (note ? { front, back, note } : { front, back })),
});
const codes = (d: Deck[]) => validateDecks(d).map((p) => p.code);

describe('deck text', () => {
  it('normalizes to NFC, single spaces, no control characters', () => {
    expect(cleanText('  Hà Nội \t\n x\u0000y ')).toBe('Hà Nội x y');
    expect(cleanText('Hà Nội')).toBe('Hà Nội'.normalize('NFC'));
    expect(cleanText(undefined)).toBe('');
  });

  it('card ids depend only on the cleaned front and back', () => {
    expect(cardId('France', 'Paris')).toBe(cardId(' France ', 'Paris'));
    expect(cardId('Hanoi', 'Hà Nội')).toBe(cardId('Hanoi', 'Hà Nội'));
    expect(cardId('France', 'Paris')).not.toBe(cardId('France', 'paris'));
    expect(cardId('a', 'b')).toMatch(/^[a-z0-9]+$/);
  });
});

describe('validation', () => {
  it('accepts the sample deck in every language', () => {
    for (const lang of ['en', 'zh', 'vi'] as const) {
      setLang(lang);
      const cards = parseDelimited(t('decksSampleCards'));
      expect(cards.problems).toEqual([]);
      expect(cards.cards.length).toBeGreaterThanOrEqual(4);
      expect(validateDecks([{ id: 'capitals', name: t('decksSampleName'), cards: cards.cards }])).toEqual([]);
    }
    setLang('en');
  });

  it('reports empty and too long fields, counted in characters (CJK = 1)', () => {
    const d = deck([['', 'x'], ['x', ''], ['字'.repeat(LIMITS.front), 'ok'], ['字'.repeat(LIMITS.front + 1), 'b'.repeat(LIMITS.back + 1), 'n'.repeat(LIMITS.note + 1)]]);
    const p = validateDecks([d]);
    expect(p.map((x) => [x.code, x.card, x.field])).toEqual([
      ['decksErrFrontEmpty', 0, 'front'],
      ['decksErrBackEmpty', 1, 'back'],
      ['decksErrFrontLong', 3, 'front'],
      ['decksErrBackLong', 3, 'back'],
      ['decksErrNoteLong', 3, 'note'],
    ]);
    expect(p[2].vars).toEqual({ n: LIMITS.front + 1, max: LIMITS.front });
  });

  it('ignores blank rows, flags names and duplicates', () => {
    expect(codes([deck([['', ''], ['a', 'b']])])).toEqual([]);
    expect(codes([deck([['a', 'b']], ' ')])).toEqual(['decksErrNameEmpty']);
    expect(codes([deck([['a', 'b']], 'x'.repeat(LIMITS.name + 1))])).toEqual(['decksErrNameLong']);
    const dup = validateDecks([deck([['a', 'b'], ['c', 'd'], ['A ', 'b']])]);
    expect(dup.map((x) => x.code)).toEqual(['decksErrDuplicate']);
    expect(dup[0].vars).toEqual({ other: 1 });
    expect(dup[0].card).toBe(2);
  });

  it('enforces the per-deck, total and size limits', () => {
    const many = (n: number, id: string) => deck(Array.from({ length: n }, (_, i) => [`w${i}`, `m${i}`] as [string, string]), id, id);
    expect(codes([many(LIMITS.cardsPerDeck, 'a')])).toEqual([]);
    expect(codes([many(LIMITS.cardsPerDeck + 1, 'a')])).toEqual(['decksErrDeckCards']);
    const four = Array.from({ length: 4 }, (_, i) => many(LIMITS.cardsPerDeck, `d${i}`));
    expect(codes(four)).toEqual([]);
    expect(codes([...four, many(1, 'e')])).toEqual(['decksErrTotalCards']);
    expect(codes(Array.from({ length: LIMITS.decks + 1 }, (_, i) => many(1, `x${i}`)))).toEqual(['decksErrTooManyDecks']);
    // 500 long CJK cards: within the card limits but too many bytes for one deck file
    const big = deck(Array.from({ length: 500 }, (_, i) => [`${i}字`.padEnd(40, '字'), '词'.repeat(100)] as [string, string]));
    expect(codes([big])).toEqual(['decksErrDeckBytes']);
  });
});

describe('band files', () => {
  it('writes an index and one file per deck, cards as id\\tfront\\tback[\\tnote]', () => {
    const files = bandFiles([deck([['France', 'Paris', 'On the Seine'], ['', ''], ['日本', '东京']], 'Capitals', 'cap'), deck([['a', 'b']], 'Two', 'two')]);
    expect(Object.keys(files).sort()).toEqual(['common/deck0.json', 'common/deck1.json', INDEX_PATH]);
    expect(JSON.parse(td.decode(files[INDEX_PATH]))).toEqual({
      v: 1,
      decks: [
        { id: 'cap', name: 'Capitals', n: 2, file: '/common/deck0.json' },
        { id: 'two', name: 'Two', n: 1, file: '/common/deck1.json' },
      ],
    });
    const d0 = JSON.parse(td.decode(files['common/deck0.json']));
    expect(d0.cards).toEqual([`${cardId('France', 'Paris')}\tFrance\tParis\tOn the Seine`, `${cardId('日本', '东京')}\t日本\t东京`]);
  });

  it('keeps ids unique even if two cards hash alike', () => {
    const cards = bandCards(deck([['a', 'b'], ['c', 'd']]));
    expect(new Set(cards.map((c) => c.split('\t')[0])).size).toBe(2);
  });

  it('refuses decks that do not validate', () => {
    expect(() => bandFiles([deck([['', 'x']])])).toThrow('decksErrFrontEmpty');
  });
});

describe('CSV / TSV import', () => {
  it('reads cells pasted from a spreadsheet (tabs), with a header row and a note column', () => {
    const r = parseDelimited('Front\tBack\tNote\napple\tquả táo\tAn apple a day\n\n你好\tnǐ hǎo\n');
    expect(r.delimiter).toBe('\t');
    expect(r.cards).toEqual([
      { front: 'apple', back: 'quả táo', note: 'An apple a day' },
      { front: '你好', back: 'nǐ hǎo' },
    ]);
    expect(r.problems).toEqual([]);
  });

  it('handles CSV quotes, escaped quotes, commas and line breaks inside quotes, CRLF and a BOM', () => {
    const csv = '\uFEFFterm,definition\r\n"E = mc²","energy, mass and ""c"""\r\n"two\r\nlines",x,"note, with comma"\r\nlast,one';
    const r = parseDelimited(csv);
    expect(r.delimiter).toBe(',');
    expect(r.cards).toEqual([
      { front: 'E = mc²', back: 'energy, mass and "c"' },
      { front: 'two lines', back: 'x', note: 'note, with comma' },
      { front: 'last', back: 'one' },
    ]);
  });

  it('detects semicolons (European spreadsheets) and ignores extra columns', () => {
    const r = parseDelimited('Paris;France;capital;extra\nBerlin;Germany');
    expect(r.delimiter).toBe(';');
    expect(r.cards).toEqual([
      { front: 'Paris', back: 'France', note: 'capital' },
      { front: 'Berlin', back: 'Germany' },
    ]);
  });

  it('reports lines without a back with their line number, keeps going', () => {
    const r = parseDelimited('a,b\n"multi\nline",x\nonly-one\nc,d');
    expect(r.cards.map((c) => c.front)).toEqual(['a', 'multi line', 'c']);
    expect(r.problems).toEqual([{ line: 4, code: 'decksImportRowCols' }]);
  });

  it('flags text that was not UTF-8', () => {
    expect(parseDelimited('caf\uFFFD,coffee').problems[0].code).toBe('decksImportNotUtf8');
  });

  it('a header-looking row that is not the first one is a card', () => {
    expect(parseDelimited('a\tb\nword\tmeaning').cards).toHaveLength(2);
  });

  it('splitRows keeps empty cells', () => {
    expect(splitRows('a,,c\n,b', ',')).toEqual([{ line: 1, cells: ['a', '', 'c'] }, { line: 2, cells: ['', 'b'] }]);
  });
});

describe('JSON import / export', () => {
  const decks = [deck([['France', 'Paris', 'On the Seine'], ['日本', '东京']], 'Capitals', 'cap')];

  it('round-trips our export, keeping deck ids', () => {
    const back = parseJsonImport(exportJson(decks), 'x');
    expect(back).toEqual(decks);
  });

  it('accepts one deck, a list of card objects or of arrays', () => {
    expect(parseJsonImport('{"name":"N","cards":[{"front":"a","back":"b"}]}', 'x')![0]).toMatchObject({ name: 'N', cards: [{ front: 'a', back: 'b' }] });
    expect(parseJsonImport('[{"question":"q","answer":"a","example":"e"}]', 'File')![0]).toMatchObject({ name: 'File', cards: [{ front: 'q', back: 'a', note: 'e' }] });
    expect(parseJsonImport('[["a","b"],["c","d","n"]]', 'F')![0].cards).toEqual([{ front: 'a', back: 'b' }, { front: 'c', back: 'd', note: 'n' }]);
  });

  it('rejects anything else', () => {
    expect(parseJsonImport('not json', 'x')).toBeNull();
    expect(parseJsonImport('{"foo":1}', 'x')).toBeNull();
    expect(parseJsonImport('[{"front":1,"back":"b"}]', 'x')).toBeNull();
    expect(parseJsonImport('{"decks":[{"name":"a"}]}', 'x')).toBeNull();
  });

  it('gives every deck a unique valid id, and restores saved decks', () => {
    const ids = uniqueIds([deck([], 'a', 'same'), deck([], 'b', 'same'), deck([], 'c', 'BAD ID')]).map((d) => d.id);
    expect(ids[0]).toBe('same');
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+$/);
    expect(loadSaved(JSON.stringify(decks))).toEqual(decks);
    expect(loadSaved('{broken')).toBeNull();
    expect(loadSaved(null)).toBeNull();
  });
});
