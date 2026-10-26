import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthSession, parseAuthKey, accountErrorName, COMPANION_IOS } from 'miband-source/core/auth';
import { encodeCommand, decodeCommand } from 'miband-source/core/proto';
import { encodeV2Frame, parseV2, v2SessionConfigPayloadIos } from 'miband-source/core/packets';

const here = dirname(fileURLToPath(import.meta.url));
const wal = process.argv[2];
if (!wal) throw new Error('Usage: node probe.mjs /path/to/manifest.sqlite-wal');
const { authKey, mac } = JSON.parse(execFileSync('python3', [join(here, 'extract-key.py'), wal], { encoding: 'utf8' }));
const auth = new AuthSession(parseAuthKey(authKey));
auth.companionType = COMPANION_IOS;
const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
log('Loaded one Mi Band 10 key from cache (value hidden).');
log('Native CoreBluetooth probe; OS bond state is unknown. Only session setup and AUTH 26/27 are sent.');
let closeClassic = false;
if (process.argv.includes('--classic-first')) {
    const state = () => {
        const value = JSON.parse(execFileSync('/opt/homebrew/bin/blueutil', ['--format', 'json', '--info', mac], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }));
        return Array.isArray(value) ? value[0] : value;
    };
    const before = state();
    if (!before.connected) {
        closeClassic = true;
        try {
            execFileSync('/opt/homebrew/bin/blueutil', ['--connect', mac], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
        } catch { log('Classic connect command did not report success.'); }
    }
    const after = state();
    log(`Classic state: paired=${after.paired}, connected=${after.connected}`);
}
const child = spawn(join(here, 'native-ble'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
let phase = 'adapter';
let outcome = '';
let maxWrite = 180;
let written: { resolve: () => void; reject: (e: Error) => void } | null = null;
let sendQueue = Promise.resolve();
let receiveQueue = Promise.resolve();
let buffer = new Uint8Array();
let seq = 0;
const seen = new Set<number>();
const timer = setTimeout(() => finish(`TIMEOUT during ${phase}; authentication and bonding not established`), 80000);
function finish(result: string) {
    if (outcome) return;
    outcome = result;
    log(`RESULT: ${result}`);
    clearTimeout(timer);
    if (written) { written.reject(new Error('Probe finished')); written = null; }
    if (child.stdin.writable) child.stdin.end(JSON.stringify({ op: 'close' }) + '\n');
    const kill = setTimeout(() => child.kill('SIGTERM'), 3000);
    kill.unref();
}
function send(type: number, sequence: number, payload: Uint8Array) {
    const frame = encodeV2Frame(type, sequence, payload);
    const result = sendQueue.then(async () => {
        for (let offset = 0; offset < frame.length; offset += maxWrite) {
            if (outcome) return;
            const part = frame.subarray(offset, offset + maxWrite);
            await new Promise<void>((resolve, reject) => {
                written = { resolve, reject };
                child.stdin.write(JSON.stringify({ op: 'write', base64: Buffer.from(part).toString('base64') }) + '\n');
            });
        }
    });
    sendQueue = result.catch(() => {});
    return result;
}
async function command(cmd: any) {
    if (cmd.type !== 1 || ![26, 27].includes(cmd.subtype)) throw new Error('Only AUTH commands permitted');
    const bytes = encodeCommand(cmd);
    const payload = new Uint8Array(bytes.length + 2);
    payload.set([1, 1]); payload.set(bytes, 2);
    log(`TX AUTH subtype ${cmd.subtype}`);
    await send(3, seq++, payload);
}
async function packet(p: any) {
    if (outcome) return;
    log(`RX frame type=${p.type}, sequence=${p.seq}, payload=${p.payload.length} bytes`);
    if (p.type === 2) {
        if (phase !== 'session' || p.payload[0] !== 2) return;
        phase = 'AUTH_VERIFY';
        await command(auth.buildNonceCommand({ id: 'nonce' }));
    } else if (p.type === 3) {
        await send(1, p.seq, new Uint8Array());
        if (seen.has(p.seq)) return;
        seen.add(p.seq);
        if (p.payload[0] !== 1 || p.payload[1] !== 1) return;
        const cmd = decodeCommand(p.payload.slice(2));
        if (cmd.type !== 1) return;
        log(`RX Account subtype ${cmd.subtype}`);
        if (cmd.auth?.errorCode !== undefined && cmd.auth.errorCode !== 0) {
            finish(`${accountErrorName(cmd.auth.errorCode)}; native GATT works, OS bond remains unverified`);
        } else if (cmd.subtype === 26 && phase === 'AUTH_VERIFY' && cmd.auth?.deviceVerify) {
            const d = cmd.auth.deviceVerify;
            if (d.nonce.length !== 16 || d.hmac.length !== 32) throw new Error('Invalid device challenge length');
            const reply = auth.handleWatchNonce(d.nonce, d.hmac);
            log('Device challenge verified using the existing key.');
            phase = 'AUTH_CONFIRM';
            await command(reply);
        } else if (cmd.subtype === 27 && phase === 'AUTH_CONFIRM') {
            finish(cmd.auth?.authStep4?.unknown1 === true ? 'AUTH_SUCCESS with existing key; native connection authenticated' : 'AUTH_CONFIRM did not report success');
        }
    } else if (p.type === 0) finish('Native link received NACK');
}
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
    let e: any;
    try { e = JSON.parse(line); } catch { finish('Invalid native helper response'); return; }
    if (e.event === 'written') { const w = written; written = null; w?.resolve(); return; }
    if (e.event === 'data') {
        const chunk = Buffer.from(e.base64, 'base64');
        const combined = new Uint8Array(buffer.length + chunk.length);
        combined.set(buffer); combined.set(chunk, buffer.length); buffer = combined;
        while (buffer.length) {
            const parsed = parseV2(buffer);
            if (parsed.status === 'incomplete') break;
            if (parsed.status === 'invalid' || !parsed.packet) { finish('Invalid frame or CRC from native transport'); break; }
            buffer = buffer.slice(parsed.size);
            receiveQueue = receiveQueue.then(() => packet(parsed.packet)).catch((error) => finish(`Protocol error: ${error.message}`));
        }
        return;
    }
    if (e.event === 'ready') {
        phase = 'session'; maxWrite = Math.min(180, e.maxWrite);
        log('GATT notifications active. CoreBluetooth does not expose bond status.');
        send(2, 0, v2SessionConfigPayloadIos(1, { name: 'iPhone 13 mini', os: [27, 0, 1] })).catch(() => finish('Session write failed'));
    } else if (e.event === 'error') finish(`Native error during ${e.phase}: ${e.domain} code ${e.code}`);
    else if (e.event === 'selection') finish(`Discovered ${e.candidates} matching bands; no connection attempted`);
    else if (e.event === 'timeout') finish(`Native timeout during ${phase}`);
    else if (e.event === 'disconnected') finish(`Disconnected during ${phase} (${e.domain} code ${e.code})`);
    else {
        if (['scanning', 'connecting', 'connected', 'discovering_services', 'discovering_characteristics', 'reading', 'subscribing'].includes(e.event)) phase = e.event;
        log(JSON.stringify(e));
    }
});
child.stderr.on('data', () => log('Native helper emitted a system diagnostic (content suppressed).'));
child.on('error', () => finish('Could not launch native helper'));
child.on('exit', (code) => {
    if (!outcome) finish(`Native helper exited during ${phase} (code ${code})`);
    if (outcome.startsWith('AUTH_SUCCESS') && code !== 0) {
        outcome = `Native helper did not close cleanly after AUTH (code ${code})`;
        log(outcome);
    }
    if (closeClassic) {
        try {
            execFileSync('/opt/homebrew/bin/blueutil', ['--disconnect', mac], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
            log('Closed the Classic connection opened by this probe.');
        } catch { log('Could not confirm Classic disconnect.'); }
    }
    process.exitCode = outcome.startsWith('AUTH_SUCCESS') ? 0 : 2;
});
process.on('SIGINT', () => finish('Interrupted'));
