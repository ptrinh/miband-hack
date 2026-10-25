#!/usr/bin/env node
// Renders the demo-app preview screenshots: node tools/screenshots/render.mjs [name...]
//
// Each tools/screenshots/screens/<name>.html is the markup of one app page in a fixed, realistic
// state (the .ux <template> with its {{bindings}} filled in). Its first line names the .ux file,
// e.g. <!-- ux: demo-apps/calculator/src/pages/index/index.ux -->, whose <style> block is copied in
// unchanged, so style changes in an app show up on the next run. vela.css supplies Vela's layout
// defaults and the Mi Band 10 frame.
//
// Rendering: headless Chrome driven over the DevTools protocol (Node's built-in WebSocket, no
// Puppeteer), page served from a throwaway local HTTP server so screen scripts can import the apps'
// own engines (e.g. demo-apps/drawing/src/common/sketch.js). The #device element is captured
// with a clip at 2x, transparent outside the bezel, then re-compressed losslessly by png.mjs.
// Output: public/apps/screens/<name>.png. Warnings are printed for content that overflows the screen.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimizePng } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const screensDir = join(here, 'screens');
const outDir = join(root, 'public/apps/screens');
const SCALE = 2;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

function uxStyle(uxPath) {
  const src = readFileSync(resolve(root, uxPath), 'utf8');
  const m = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  if (!m) throw new Error(`${uxPath}: no <style> block`);
  return m[1];
}

function composePage(name) {
  const fragment = readFileSync(join(screensDir, `${name}.html`), 'utf8');
  const ux = fragment.match(/<!--\s*ux:\s*(\S+)\s*-->/);
  if (!ux) throw new Error(`${name}.html: first line must be <!-- ux: path/to/page.ux -->`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<link rel="stylesheet" href="/tools/screenshots/vela.css">
<style>${uxStyle(ux[1])}</style></head>
<body><div id="device"><div id="screen">${fragment}</div></div></body></html>`;
}

function serve() {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try {
      if (path.startsWith('/__screen/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(composePage(path.slice('/__screen/'.length)));
      }
      const file = resolve(root, `.${path}`);
      if (!file.startsWith(root + '/') || !existsSync(file)) throw new Error('not found');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch (e) {
      res.writeHead(404);
      res.end(String(e));
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'miband-shots-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
    '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(portFile)) throw new Error('Chrome did not start (set CHROME=/path/to/chrome)');
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const close = () => {
    proc.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
  };
  return { port, close };
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { ok, fail } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? fail(new Error(`${m.error.message} ${m.error.data ?? ''}`)) : ok(m.result);
    } else if (m.method) {
      for (const w of waiters.splice(0)) if (w.method === m.method) w.ok(m.params); else waiters.push(w);
    }
  };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const once = (method) => new Promise((ok) => waiters.push({ method, ok }));
  return new Promise((ok, fail) => {
    ws.onopen = () => ok({ send, once, close: () => ws.close() });
    ws.onerror = () => fail(new Error('DevTools WebSocket failed'));
  });
}

// Runs in the page: lists elements that stick out of the screen or whose text overflows its box.
// Elements inside a <list> are skipped (a list scrolls on the band).
const OVERFLOW_CHECK = `(() => {
  const scr = document.getElementById('screen').getBoundingClientRect();
  const out = [];
  const label = (el) => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().replace(/\\s+/g, '.') : '') + (el.textContent.trim() ? ' "' + el.textContent.trim().slice(0, 24) + '"' : '');
  for (const el of document.querySelectorAll('#screen *')) {
    if (el.parentElement.closest('list')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.left < scr.left - 0.5 || r.top < scr.top - 0.5 || r.right > scr.right + 0.5 || r.bottom > scr.bottom + 0.5)
      out.push('outside the screen: ' + label(el));
    // A <text>'s glyphs may poke a few px out of its line box; only an extra wrapped line counts.
    const slackY = el.tagName === 'TEXT' ? parseFloat(getComputedStyle(el).fontSize) * 0.5 : 1;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + slackY)
      out.push('content overflows its box: ' + label(el) + ' (' + el.scrollWidth + 'x' + el.scrollHeight + ' in ' + el.clientWidth + 'x' + el.clientHeight + ')');
  }
  return out;
})()`;

async function main() {
  const wanted = process.argv.slice(2);
  const names = readdirSync(screensDir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5))
    .filter((n) => wanted.length === 0 || wanted.includes(n)).sort();
  if (names.length === 0) throw new Error('no screens to render');
  mkdirSync(outDir, { recursive: true });

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const chrome = await launchChrome();
  let warnings = 0;
  try {
    const target = await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: 'PUT' })).json();
    const page = await cdp(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 600, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

    for (const name of names) {
      const loaded = page.once('Page.loadEventFired');
      await page.send('Page.navigate', { url: `${base}/__screen/${name}` });
      await loaded;
      await page.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true });
      const { result: rect } = await page.send('Runtime.evaluate', {
        expression: 'JSON.stringify(document.getElementById("device").getBoundingClientRect())', returnByValue: true,
      });
      const { x, y, width, height } = JSON.parse(rect.value);
      const { result: issues } = await page.send('Runtime.evaluate', { expression: OVERFLOW_CHECK, returnByValue: true });
      for (const w of issues.value) {
        console.warn(`  ⚠ ${name}: ${w}`);
        warnings++;
      }
      const shot = await page.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
        clip: { x, y, width, height, scale: SCALE },
      });
      const raw = Buffer.from(shot.data, 'base64');
      const png = optimizePng(raw);
      writeFileSync(join(outDir, `${name}.png`), png);
      console.log(`${name}.png  ${Math.round(width * SCALE)}x${Math.round(height * SCALE)}  ${(png.length / 1024).toFixed(1)} KB (Chrome: ${(raw.length / 1024).toFixed(1)} KB)`);
    }
    page.close();
  } finally {
    chrome.close();
    server.close();
  }
  if (warnings) {
    console.warn(`${warnings} overflow warning(s)`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
