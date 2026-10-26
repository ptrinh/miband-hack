import { randomBytes } from 'node:crypto';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { hex } from '../src/core/bytes';
import { parseFile } from '../src/core/files';
import { XiaomiDevice } from '../src/device';
import { StreamLink } from '../src/protocol/stream-link';
import { FakeBand } from './fake-band';

function makeRpk(size: number): Uint8Array {
  return zipSync(
    {
      'manifest.json': new TextEncoder().encode(JSON.stringify({ package: 'com.example.hello', name: 'Hello', versionName: '1.0.0', versionCode: 1 })),
      'blob.bin': new Uint8Array(randomBytes(size)),
    },
    { level: 0 },
  );
}

describe('end-to-end against a simulated SPP band', () => {
  it('detects SPP V2, authenticates, reads info and installs an rpk', async () => {
    const secret = randomBytes(16);
    const band = new FakeBand(secret, { txWindow: 4, chunkSize: 1024, ackDelayMs: 3 });
    const link = new StreamLink(band.transport, 'detect');
    const dev = new XiaomiDevice(link, new Uint8Array(secret));
    const logs: string[] = [];
    dev.onLog = (m) => logs.push(m);

    await dev.connect();
    expect(link.name).toContain('V2');
    expect(dev.info).toMatchObject({ model: 'Xiaomi Smart Band 9', firmware: '2.3.93', battery: 77 });
    expect(dev.faces[0]?.name).toBe('Default');

    const rpk = makeRpk(20_000);
    const file = parseFile(rpk);
    const progress: number[] = [];
    await dev.install(file, (p) => progress.push(p));

    expect(hex(band.received.rpk!, 9999)).toBe(hex(rpk, 9999));
    expect(band.received.type).toBe(64);
    expect(band.dataFrames).toBe(Math.ceil((rpk.length + 26) / 1020));
    expect(band.maxInFlight).toBeLessThanOrEqual(4); // respected the band's tx window
    expect(progress.at(-1)).toBe(100);
    expect(dev.apps.map((a) => a.id)).toEqual(['com.example.hello']);
  });

  it('refuses an install that would leave less than a fifth of the storage free', async () => {
    const secret = randomBytes(16);
    // 90 KB free of 400 KB: a 20 KB app would leave about 70 KB, under the 80 KB (20 %) reserve.
    const band = new FakeBand(secret, { txWindow: 4, chunkSize: 1024, ackDelayMs: 1, storage: { used: 310_000, total: 400_000 } });
    const dev = new XiaomiDevice(new StreamLink(band.transport, 'detect'), new Uint8Array(secret));
    await dev.connect();
    await expect(dev.install(parseFile(makeRpk(20_000)), () => {})).rejects.toThrow(/storage|room/i);
    expect(band.received.rpk).toBeUndefined();
  });

  it('fails cleanly with a wrong auth key', async () => {
    const band = new FakeBand(randomBytes(16), { txWindow: 32, chunkSize: 2048, ackDelayMs: 1 });
    const dev = new XiaomiDevice(new StreamLink(band.transport, 'detect'), new Uint8Array(randomBytes(16)));
    await expect(dev.connect()).rejects.toThrow(/auth key/i);
  });
});
