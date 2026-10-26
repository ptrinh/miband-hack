// Offline transport smoke test; FakeBand validates crypto independently with node:crypto.
import { createInterface } from 'node:readline';
import { FakeBand } from 'miband-test/fake-band';
import { decodeCommand } from 'miband-source/core/proto';
import { parseV2 } from 'miband-source/core/packets';
const mode = process.env.MOCK_MODE ?? 'success';
const band: any = new FakeBand(Buffer.alloc(16, mode === 'wrong-key' ? 1 : 0), {
    txWindow: 3, chunkSize: 128, ackDelayMs: 0,
    ...(mode === 'no-bound' ? { bound: { deviceId: 'missing-device-id' } } : {}),
});
band.v2 = true;
const sendCommand = band.sendCommand.bind(band);
band.sendCommand = (cmd: any, encrypted: boolean) => {
    if (cmd.type === 1 && cmd.subtype === 27) cmd.auth = { authStep4: { unknown1: true } };
    sendCommand(cmd, encrypted);
};
const emit = (event: string, rest = {}) => console.log(JSON.stringify({ event, ...rest }));
band.transport.onData = (data: Uint8Array) => emit('data', { base64: Buffer.from(data).toString('base64') });
let count = 0;
let input = Buffer.alloc(0);
createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.op === 'close') {
        if (count !== (mode === 'success' ? 2 : 1)) process.exit(10);
        process.exit(0);
    }
    if (msg.op !== 'write') process.exit(11);
    const data = Buffer.from(msg.base64, 'base64');
    input = Buffer.concat([input, data]);
    while (input.length) {
        const result = parseV2(input);
        if (result.status === 'incomplete') break;
        if (result.status !== 'complete' || !result.packet) process.exit(12);
        input = input.subarray(result.size);
        if (result.packet.type === 3) {
            const cmd = decodeCommand(result.packet.payload.slice(2));
            if (cmd.type !== 1 || ![26, 27].includes(cmd.subtype ?? -1)) process.exit(13);
            count++;
        }
    }
    void band.transport.write(data);
    emit('written');
});
emit('ready', { maxWrite: 40, bond: 'unknown' });
