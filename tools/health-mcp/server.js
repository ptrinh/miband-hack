#!/usr/bin/env node
// MCP server for MiBand Hack health exports: lets an AI agent (Claude Code, Claude Desktop, any MCP
// client) query the JSON you downloaded from the "Health data" section of the webapp. Local only:
// the data never leaves this machine. Stdio, newline-delimited JSON-RPC, no dependencies, no build.
//
//   HEALTH_DATA   an export file (miband-health-*.json) or a folder of them; several are merged
//
// The tools and queries live in src/health/query.ts (shared with the webapp); Node ≥ 22.18
// loads that TypeScript file directly (type stripping), so run this from a checkout of the repo.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { handleMcp, KINDS } from "../../src/health/query.ts";

const VERSION = "1.0.0";
const SCHEMA = "miband-health/1";

/** Every miband-health/1 file at `path` (a file, or the .json files of a folder). */
function exportFiles(path) {
  const p = resolve(path);
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => join(p, n));
}

/** Merges several exports; later files win for records with the same time (and source). */
export function mergeExports(list) {
  const out = { ...list[0], files: [] };
  for (const k of KINDS) out[k] = [];
  const keyOf = (k, x) => (k === "daily" ? x.date : k === "sleep" || k === "workouts" ? x.start : x.t + "|" + (x.source ?? ""));
  for (const d of list) {
    out.files.push(...(d.files ?? []));
    if (d.timezone?.bandOffsetMinutes !== undefined) out.timezone = d.timezone;
  }
  for (const k of KINDS) {
    const m = new Map();
    for (const d of list) for (const x of d[k] ?? []) m.set(keyOf(k, x), x);
    const time = (x) => x.t ?? x.start ?? "";
    out[k] = [...m.values()].sort((a, b) => time(a).localeCompare(time(b)));
  }
  return out;
}

export function loadExports(path) {
  if (!path) throw new Error("Set HEALTH_DATA to an exported miband-health JSON file or a folder of them.");
  const list = [];
  for (const f of exportFiles(path)) {
    let d;
    try {
      d = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      throw new Error(f + ": not valid JSON (" + e.message + ")");
    }
    if (d && d.schema === SCHEMA) list.push(d);
  }
  if (list.length === 0) throw new Error("No " + SCHEMA + " export found at " + path);
  return mergeExports(list);
}

/** A HealthSource over the export files, re-read when they change so a fresh download is picked up. */
export function fileSource(path) {
  let cache = null;
  let stamp = "";
  const load = () => {
    const s = exportFiles(path).map((f) => f + ":" + statSync(f).mtimeMs).join(",");
    if (!cache || s !== stamp) {
      cache = loadExports(path);
      stamp = s;
    }
    return cache;
  };
  return {
    async load() {
      return load();
    },
    async info() {
      const d = load();
      const coverage = {};
      for (const k of KINDS) {
        const list = d[k] ?? [];
        const time = (x) => x.t ?? x.start ?? "";
        coverage[k] = list.length ? { count: list.length, first: time(list[0]), last: time(list[list.length - 1]) } : { count: 0 };
      }
      const decoded = { full: 0, partial: 0, raw: 0 };
      for (const f of d.files ?? []) decoded[f.decoded] = (decoded[f.decoded] ?? 0) + 1;
      return { schema: SCHEMA, timezone: d.timezone, device: d.device, units: d.units, coverage, bandFiles: decoded, rawOnly: (d.files ?? []).filter((f) => f.decoded !== "full").map((f) => ({ name: f.name, decoded: f.decoded, note: f.note })) };
    },
  };
}

function main() {
  const src = fileSource(process.env.HEALTH_DATA || process.argv[2] || "");
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  createInterface({ input: process.stdin }).on("line", async (line) => {
    if (!line.trim()) return;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    try {
      const res = await handleMcp(m, src, { name: "miband-health", version: VERSION });
      if (res) send(res);
    } catch (e) {
      send({ jsonrpc: "2.0", id: m.id ?? null, error: { code: -32603, message: e.message } });
    }
  });
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) main();
