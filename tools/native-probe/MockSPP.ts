import { createInterface } from 'node:readline';
import { FakeBand } from 'miband-test/fake-band';
const mode = process.env.MOCK_MODE ?? 'success';
const band: any = new FakeBand(Buffer.alloc(16, mode === 'wrong-key' ? 1 : 0), {
    txWindow: 3, chunkSize: 128, ackDelayMs: 0,
    ...(mode === 'no-bound' ? { bound: { deviceId: 'not-sent' } } : {}),
});
const emit = (event: string, rest = {}) => console.log(JSON.stringify({ event, ...rest }));
const originalSend = band.sendCommand.bind(band);
band.sendCommand = (cmd: any, encrypted: boolean) => {
    if (cmd.type === 1 && cmd.subtype === 27) cmd.auth = { authStep4: { unknown1: true } };
    originalSend(cmd, encrypted);
};
const received: string[] = [];
const originalCommand = band.onCommand.bind(band);
band.onCommand = (cmd: any) => {
    const id = `${cmd.type}/${cmd.subtype}`;
    if (!['1/26', '1/27', '2/2', '20/0'].includes(id)) process.exit(11);
    received.push(id);
    originalCommand(cmd);
};
band.transport.onData = (data: Uint8Array) => emit('data', { base64: Buffer.from(data).toString('base64') });
createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.op === 'connect') {
        if (mode === 'no-spp') emit('sdp_result', { sppPresent: false, serviceCount: 1 });
        else emit('ready', { maxWrite: 40, paired: true });
    } else if (msg.op === 'write') {
        if (mode === 'no-spp') process.exit(12);
        void band.transport.write(Buffer.from(msg.base64, 'base64'));
        emit('written');
    } else if (msg.op === 'close') {
        const expected = mode === 'success' ? ['1/26', '1/27', '2/2', '20/0'] : mode === 'no-spp' ? [] : ['1/26'];
        if (JSON.stringify(received) !== JSON.stringify(expected)) process.exit(13);
        process.exit(0);
    } else process.exit(14);
});
