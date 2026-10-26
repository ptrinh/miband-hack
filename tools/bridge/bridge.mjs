#!/usr/bin/env node
// Local bridge: the webapp talks WebSocket to 127.0.0.1, this process talks RFCOMM to the band
// through the IOBluetooth helper (tools/native-probe/NativeSPP.m). Needed for a Mi Band 10 on macOS,
// whose SDP never answers Chrome, so Web Serial cannot open it; the helper opens channel 5 directly.
// No npm dependencies: a minimal RFC 6455 server (no extensions, no fragmentation from us).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PORT = Number(process.env.MIBAND_BRIDGE_PORT || 47851);
const CHANNEL = Number(process.env.MIBAND_RFCOMM_CHANNEL || 5);
const NATIVE = process.env.MIBAND_NATIVE_SPP || new URL('./build/native-spp', import.meta.url).pathname;
const ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.MIBAND_BRIDGE_ORIGINS || '').split(',').filter(Boolean),
]);
const log = (m) => console.log(`[bridge] ${m}`);

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** Pops complete client frames from `buf`; returns [frames, rest]. */
function parseFrames(buf) {
  const out = [];
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const maskOff = off;
    if (masked) off += 4;
    if (buf.length < off + len) break;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskOff + (i & 3)];
    out.push({ opcode, payload });
    buf = buf.subarray(off + len);
  }
  return [out, buf];
}

let busy = false;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' }).end('MiBand Hack bridge is running.\n');
});

server.on('upgrade', (req, socket) => {
  const origin = req.headers.origin || '';
  if (req.url !== '/band' || !ORIGINS.has(origin) || !req.headers['sec-websocket-key']) {
    log(`refused ${req.url} from origin "${origin}"`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  if (busy) {
    socket.end('HTTP/1.1 409 Conflict\r\n\r\n');
    return;
  }
  busy = true;
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  log(`session from ${origin}`);

  const sendText = (obj) => { if (!socket.destroyed) socket.write(frame(1, Buffer.from(JSON.stringify(obj)))); };
  const child = spawn(NATIVE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const tell = (obj) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + '\n'); };
  let maxWrite = 0;
  const outQueue = [];
  let writing = false;
  let ended = false;

  const pump = () => {
    if (writing || !maxWrite || !outQueue.length) return;
    let chunk = outQueue.shift();
    if (chunk.length > maxWrite) { outQueue.unshift(chunk.subarray(maxWrite)); chunk = chunk.subarray(0, maxWrite); }
    writing = true;
    tell({ op: 'write', base64: chunk.toString('base64') });
  };
  const end = (reason) => {
    if (ended) return;
    ended = true;
    busy = false;
    log(`session end: ${reason}`);
    sendText({ type: 'closed', reason });
    if (!socket.destroyed) socket.end(frame(8, Buffer.alloc(0)));
    tell({ op: 'close' });
  };

  createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    switch (ev.event) {
      case 'ready':
        maxWrite = ev.maxWrite;
        log(`RFCOMM open, MTU ${maxWrite}`);
        sendText({ type: 'ready', maxWrite, channel: CHANNEL });
        pump();
        break;
      case 'data':
        if (!socket.destroyed) socket.write(frame(2, Buffer.from(ev.base64, 'base64')));
        break;
      case 'written':
        writing = false;
        pump();
        break;
      case 'error':
        sendText({ type: 'error', phase: ev.phase, code: ev.code });
        end(`error ${ev.phase} ${ev.code}`);
        break;
      case 'disconnected':
      case 'timeout':
        end(ev.event);
        break;
      default:
        sendText({ type: 'status', ...ev });
    }
  });
  child.on('exit', () => end('helper exited'));
  child.on('error', (e) => { sendText({ type: 'error', phase: 'spawn', code: String(e.message) }); end('spawn failed'); });

  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    let frames;
    [frames, buf] = parseFrames(Buffer.concat([buf, d]));
    for (const f of frames) {
      if (f.opcode === 2) { outQueue.push(f.payload); pump(); }
      else if (f.opcode === 8) end('page closed');
      else if (f.opcode === 9) socket.write(frame(10, f.payload));
    }
  });
  socket.on('close', () => end('socket closed'));
  socket.on('error', () => end('socket error'));

  tell({ op: 'connect', channel: CHANNEL, ...(process.env.MIBAND_ADDRESS ? { address: process.env.MIBAND_ADDRESS } : {}) });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on ws://127.0.0.1:${PORT}/band (RFCOMM channel ${CHANNEL})`);
  log(`allowed pages: ${[...ORIGINS].join(', ')}`);
});
