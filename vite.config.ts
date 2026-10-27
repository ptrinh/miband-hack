import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

/** Writes the list of built files and a hash of them into dist/sw.js, so the service worker precaches the site. */
function precache(): Plugin {
  let outDir = 'dist';
  return {
    name: 'precache-sw',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const files = (readdirSync(outDir, { recursive: true, withFileTypes: true }))
        .filter((d) => d.isFile())
        .map((d) => relative(outDir, join(d.parentPath, d.name)).split('\\').join('/'))
        .filter((f) => f !== 'sw.js' && f !== 'index.html' && !f.split('/').some((s) => s.startsWith('.')))
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      hash.update(readFileSync(join(outDir, 'index.html')));
      const path = join(outDir, 'sw.js');
      const sw = readFileSync(path, 'utf8');
      const out = sw
        .replace("const VERSION = 'dev';", `const VERSION = '${hash.digest('hex').slice(0, 12)}';`)
        .replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(files)};`);
      if (out === sw || !out.includes('const PRECACHE = [')) throw new Error('sw.js placeholders not found');
      writeFileSync(path, out);
    },
  };
}

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  plugins: [precache()],
  test: { environment: 'node' },
});
