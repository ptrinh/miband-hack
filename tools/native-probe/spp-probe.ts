import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthSession, parseAuthKey, accountErrorName } from 'miband-source/core/auth';
import { encodeCommand, decodeCommand } from 'miband-source/core/proto';
import { StreamLink } from 'miband-source/protocol/stream-link';

const here = dirname(fileURLToPath(import.meta.url));
const wal = process.argv[2];
if (!wal) throw new Error('Usage: spp-probe.mjs /path/to/manifest.sqlite-wal');
const { authKey, mac } = JSON.parse(execFileSync('python3', [join(here, 'extract-key.py'), wal], { encoding: 'utf8' }));
const start = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] ${message}`);
const auth = new AuthSession(parseAuthKey(authKey)); // Default Android companion profile for SPP.
const child = spawn(join(here, 'native-spp'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
let phase = 'SDP';
let result = '';
let maxWrite = 128;
let queue = Promise.resolve();
let pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
let commands = Promise.resolve();
let infoReceived = false;
let appsReceived = false;
const timer = setTimeout(() => finish(`TIMEOUT during ${phase}`), 80000);
const transport = {
    label: 'Native SPP',
    onData: (_data: Uint8Array) => {},
    onClose: () => {},
    write(data: Uint8Array) {
        const next = queue.then(async () => {
            for (let offset = 0; offset < data.length; offset += maxWrite) {
                if (result) return;
                await new Promise<void>((resolve, reject) => {
                    pending = { resolve, reject };
                    child.stdin.write(JSON.stringify({ op: 'write', base64: Buffer.from(data.subarray(offset, offset + maxWrite)).toString('base64') }) + '\n');
                });
            }
        });
        queue = next.catch(() => {});
        return next;
    },
    async close() {
        if (pending) { pending.reject(new Error('Probe closed')); pending = null; }
        if (child.stdin.writable) child.stdin.end(JSON.stringify({ op: 'close' }) + '\n');
    },
};
const link = new StreamLink(transport, 'detect');
link.auth = auth;
link.log = log;
function finish(message: string) {
    if (result) return;
    result = message;
    log(`RESULT: ${message}`);
    clearTimeout(timer);
    void link.close();
    const kill = setTimeout(() => child.kill('SIGTERM'), 3000); kill.unref();
}
async function send(cmd: any) {
    const authCommand = cmd.type === 1 && [26, 27].includes(cmd.subtype);
    const allowedRead = auth.encryptionInitialized && ((cmd.type === 2 && cmd.subtype === 2) || (cmd.type === 20 && cmd.subtype === 0));
    if (!authCommand && !allowedRead) throw new Error('Command outside probe scope');
    log(`TX command ${cmd.type}/${cmd.subtype}`);
    await link.sendCommand(encodeCommand(cmd), authCommand);
}
link.onReadyForAuth = () => {
    if (phase !== 'negotiating') return;
    phase = 'AUTH_VERIFY';
    void send(auth.buildNonceCommand({ id: 'nonce' })).catch(() => finish('AUTH write failed'));
};
link.onCommand = (bytes: Uint8Array) => {
    commands = commands.then(async () => {
        if (result) return;
        const cmd = decodeCommand(bytes);
        log(`RX command ${cmd.type}/${cmd.subtype}`);
        if (cmd.type === 1) {
            if (cmd.auth?.errorCode !== undefined && cmd.auth.errorCode !== 0) { finish(`SPP ${accountErrorName(cmd.auth.errorCode)}`); return; }
            if (cmd.subtype === 26 && phase === 'AUTH_VERIFY' && cmd.auth?.deviceVerify) {
                const d = cmd.auth.deviceVerify;
                if (d.nonce.length !== 16 || d.hmac.length !== 32) throw new Error('Invalid challenge lengths');
                const reply = auth.handleWatchNonce(d.nonce, d.hmac);
                log('Device HMAC verified with existing key.');
                phase = 'AUTH_CONFIRM';
                await send(reply);
            } else if (cmd.subtype === 27 && phase === 'AUTH_CONFIRM') {
                if (cmd.auth?.authStep4?.unknown1 !== true) { finish('AUTH_CONFIRM missing positive result'); return; }
                log('AUTH_SUCCESS over SPP; checking read-only device/app queries.');
                auth.encryptionInitialized = true;
                link.onAuthSuccess();
                phase = 'post-auth reads';
                await send({ type: 2, subtype: 2 });
                await send({ type: 20, subtype: 0 });
            }
        } else if (auth.encryptionInitialized) {
            if (cmd.type === 2 && cmd.subtype === 2 && cmd.system?.deviceInfo) {
                infoReceived = true;
                log(`Device info received; model=${cmd.system.deviceInfo.model ?? '?'}, firmware=${cmd.system.deviceInfo.firmware ?? '?'}`);
            } else if (cmd.type === 20 && cmd.subtype === 0 && cmd.rpk?.rpkList) {
                appsReceived = true;
                log(`App list received: ${cmd.rpk.rpkList.rpkInfo?.length ?? 0} entries`);
            }
            if (infoReceived && appsReceived) finish('AUTH_SUCCESS; encrypted device info and app list received');
        }
    }).catch((e) => finish(`Protocol error: ${e.message}`));
};
link.onClose = () => finish(`Disconnected during ${phase}`);
createInterface({ input: child.stdout }).on('line', (line) => {
    let e: any;
    try { e = JSON.parse(line); } catch { finish('Invalid native helper response'); return; }
    if (e.event === 'data') { transport.onData(new Uint8Array(Buffer.from(e.base64, 'base64'))); return; }
    if (e.event === 'written') { const p = pending; pending = null; p?.resolve(); return; }
    log(JSON.stringify(e));
    if (e.event === 'ready') {
        if (!Number.isInteger(e.maxWrite) || e.maxWrite <= 0) { finish('Invalid RFCOMM MTU'); return; }
        maxWrite = e.maxWrite;
        phase = 'negotiating';
        void link.start().catch(() => finish('Version negotiation write failed'));
    } else if (e.event === 'sdp_result' && !e.sppPresent) finish('Fresh SDP query completed; no SPP service advertised');
    else if (e.event === 'opening_rfcomm') phase = 'RFCOMM open';
    else if (e.event === 'error') finish(`Native error during ${e.phase}: ${e.code}`);
    else if (e.event === 'timeout') finish(`Native timeout during ${phase}`);
    else if (e.event === 'disconnected') transport.onClose();
});
child.stderr.on('data', () => log('Native system diagnostic suppressed.'));
child.on('error', () => finish('Could not launch native SPP helper'));
child.on('exit', (code) => {
    if (!result) finish(`Helper exited during ${phase} (code ${code})`);
    process.exitCode = result.startsWith('AUTH_SUCCESS') && code === 0 ? 0 : 2;
});
process.on('SIGINT', () => finish('Interrupted'));
log('Existing key loaded privately. Fresh SDP -> RFCOMM -> SPP negotiation -> AUTH -> read-only queries.');
child.stdin.write(JSON.stringify({ op: 'connect', address: mac }) + '\n');
