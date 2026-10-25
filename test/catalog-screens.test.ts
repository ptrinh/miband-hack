import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Preview screenshots of the demo apps, rendered by tools/screenshots/render.mjs.
const root = resolve(__dirname, '..');
const screensSrc = resolve(root, 'tools/screenshots/screens');
const screensOut = resolve(root, 'public/apps/screens');

interface Shot { src: string; alt: Record<string, string> }
const catalog = JSON.parse(readFileSync(resolve(root, 'public/apps/catalog.json'), 'utf8')) as {
  apps: { id: string; screenshots?: Shot[] }[];
};

function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe('demo app screenshots', () => {
  it.each(catalog.apps.map((a) => [a.id, a] as const))('%s has 1-3 existing screenshots with alt text in en/zh/vi', (_, app) => {
    const shots = app.screenshots ?? [];
    expect(shots.length).toBeGreaterThanOrEqual(1);
    expect(shots.length).toBeLessThanOrEqual(3);
    for (const s of shots) {
      expect(s.src).toMatch(/^apps\/screens\/[a-z0-9-]+\.png$/);
      const file = resolve(root, 'public', s.src);
      expect(existsSync(file)).toBe(true);
      expect(pngSize(file)).toEqual({ width: 420, height: 978 }); // 2x the Mi Band 10 frame
      for (const lang of ['en', 'zh', 'vi']) expect(s.alt[lang]?.length).toBeGreaterThan(5);
    }
  });

  it('every rendered PNG has a source page and is used by the catalog', () => {
    const used = new Set(catalog.apps.flatMap((a) => (a.screenshots ?? []).map((s) => s.src)));
    const pngs = readdirSync(screensOut).filter((f) => f.endsWith('.png'));
    const sources = readdirSync(screensSrc).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '.png'));
    expect(pngs.sort()).toEqual(sources.sort());
    expect([...used].sort()).toEqual(pngs.map((f) => `apps/screens/${f}`).sort());
  });

  it('every source page names an existing .ux file', () => {
    for (const f of readdirSync(screensSrc).filter((n) => n.endsWith('.html'))) {
      const m = readFileSync(resolve(screensSrc, f), 'utf8').match(/^<!--\s*ux:\s*(\S+)\s*-->/);
      expect(m, f).not.toBeNull();
      expect(existsSync(resolve(root, m![1])), f).toBe(true);
    }
  });
});
