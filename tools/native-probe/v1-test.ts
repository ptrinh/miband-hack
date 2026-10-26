// Drives a BLE band (V1: Mi Band 8; V2: Mi Band 9 and later) from the terminal with the web app's own BleV1Link and XiaomiDevice,
// over NativeBLEV1.swift instead of Web Bluetooth.
//   MIBAND_AUTH_KEY=<32 hex> [MIBAND_DEVICE_ID=...] node v1-test.mjs [--match "band 8"] [--install file.rpk|file.bin]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAuthKey } from 'miband-source/core/auth';
import { parseFile } from 'miband-source/core/files';
import { BleV1Link } from 'miband-source/protocol/ble-v1-link';
import { type Link } from 'miband-source/protocol/link';
import { StreamLink } from 'miband-source/protocol/stream-link';
import { BleV2Transport } from 'miband-source/transport/ble';
import { XiaomiDevice } from 'miband-source/device';
import { uuid16 } from 'miband-source/transport/types';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const key = process.env.MIBAND_AUTH_KEY;
if (!key) throw new Error('Set MIBAND_AUTH_KEY');
const started = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

const child = spawn(join(here, 'native-ble-v1'), [arg('--match') ?? 'band 8'], { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
const call = (o: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ ...o, id }) + '\n');
  });

// Web Bluetooth stand-ins: only what GattWriter and XiaomiCharacteristic use.
class Characteristic extends EventTarget {
  value: DataView | null = null;
  readonly properties: { write: boolean; writeWithoutResponse: boolean; notify: boolean; read: boolean };
  constructor(readonly short: string, props: number) {
    super();
    this.properties = { read: !!(props & 0x02), writeWithoutResponse: !!(props & 0x04), write: !!(props & 0x08), notify: !!(props & 0x10) };
    // --no-response: let GattWriter pick write-without-response, as it does for characteristics without plain write.
    if (process.argv.includes('--no-response') && this.properties.writeWithoutResponse) this.properties.write = false;
  }
  get uuid() { return uuid16(parseInt(this.short, 16)); }
  startNotifications() { return call({ op: 'notify', uuid: this.short }).then(() => this); }
  writeValueWithResponse(b: ArrayBuffer) {
    if (process.env.V1_TRACE) log(`  tx ${this.short} ${Buffer.from(b).subarray(0, 12).toString('hex')}… (${b.byteLength} B)`); return call({ op: 'write', uuid: this.short, response: true, base64: Buffer.from(b).toString('base64') }); }
  writeValueWithoutResponse(b: ArrayBuffer) { return call({ op: 'write', uuid: this.short, response: false, base64: Buffer.from(b).toString('base64') }); }
  push(bytes: Buffer) {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}
class Device extends EventTarget {
  name = '';
  readonly id = 'native';
  readonly gatt = { disconnect: () => void child.stdin.write(JSON.stringify({ op: 'close' }) + '\n') };
}

const device = new Device();
const chars = new Map<string, Characteristic>();
let dev: XiaomiDevice | null = null;
let exitCode = 1;
let writeSize = Number(arg('--write-size') ?? 180);

async function run(): Promise<void> {
  const c = (s: string) => {
    const ch = chars.get(s);
    if (!ch) throw new Error(`band has no characteristic ${s}`);
    return ch as unknown as BluetoothRemoteGATTCharacteristic;
  };
  let link: Link;
  if (chars.has('005e') && chars.has('005f')) {
    // BLE V2 (Mi Band 9 and later): SPP V2 frames over 005e / 005f, as main.ts does.
    const transport = new BleV2Transport(device as unknown as BluetoothDevice, c('005e'), c('005f'), writeSize);
    await transport.start();
    link = new StreamLink(transport, 'v2');
  } else {
    link = new BleV1Link(device as unknown as BluetoothDevice, {
      commandRead: c('0051'),
      commandWrite: c('0052'),
      activity: c('0053'),
      upload: chars.has('0055') ? c('0055') : null,
    }, writeSize);
  }
  dev = new XiaomiDevice(link, parseAuthKey(key!), process.env.MIBAND_DEVICE_ID ?? '');
  dev.onLog = (m) => log(m);
  await dev.connect();
  await new Promise((r) => setTimeout(r, 1500));
  log(`info: ${JSON.stringify(dev.info)}`);
  log(`apps (${dev.apps.length}): ${dev.apps.map((a) => a.name).join(', ')}`);
  log(`faces (${dev.faces.length}): ${dev.faces.map((f) => `${f.name}${f.active ? '*' : ''}`).join(', ')}`);
  const file = arg('--install');
  if (file) {
    const parsed = parseFile(new Uint8Array(readFileSync(file)));
    log(`install ${file}: ${parsed.kind}${parsed.kind === 'unsupported' ? ` (${parsed.reason})` : ` id ${parsed.id}`}`);
    let last = -1;
    await dev.install(parsed, (pct, stage) => {
      if (pct !== last) { last = pct; log(`  ${stage} ${pct}%`); }
    });
    log('✓ install complete');
  }
  exitCode = 0;
}

createInterface({ input: child.stdout }).on('line', (line) => {
  const e = JSON.parse(line);
  if (e.event === 'done') {
    const p = pending.get(e.id);
    pending.delete(e.id);
    if (e.error) p?.reject(new Error(e.error));
    else p?.resolve();
  } else if (e.event === 'data') {
    const b = Buffer.from(e.base64, 'base64');
    if (process.env.V1_TRACE) log(`  rx ${e.uuid.slice(-4)} ${b.subarray(0, 12).toString('hex')}${b.length > 12 ? '…' : ''} (${b.length} B)`);
    chars.get(e.uuid.slice(-4))?.push(b);
  } else if (e.event === 'characteristics') {
    for (const it of e.items) chars.set(it.uuid.slice(-4), new Characteristic(it.uuid.slice(-4), it.properties));
    log(`characteristics: ${[...chars.keys()].join(', ')}`);
  } else if (e.event === 'ready') {
    device.name = e.name;
    log(`ready: "${e.name}", max write ${e.maxWrite} / ${e.maxWriteNoResponse} without response`);
    run()
      .catch((err) => log(`✗ ${(err as Error).message}`))
      .finally(() => device.gatt.disconnect());
  } else if (e.event === 'disconnected') {
    log(`disconnected ${e.message}`);
    device.dispatchEvent(new Event('gattserverdisconnected'));
  } else {
    log(JSON.stringify(e));
  }
});
child.on('exit', () => process.exit(exitCode));
process.on('SIGINT', () => device.gatt.disconnect());
