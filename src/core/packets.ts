import { concat, readU16le, u16le } from './bytes';
import { crc16arc } from './checksum';

// Ported from Gadgetbridge XiaomiSppPacketV1 / XiaomiSppPacketV2 (AGPL-3.0).

export type Channel = 'version' | 'proto' | 'auth' | 'activity' | 'data' | 'unknown';

export type Parse<T> =
  | { status: 'incomplete' }
  | { status: 'invalid' }
  | { status: 'complete'; size: number; packet: T | null };

// ---------------------------------------------------------------- SPP V2 ----

export const V2_PREAMBLE = [0xa5, 0xa5];
export const V2_NACK = 0;
export const V2_ACK = 1;
export const V2_SESSION_CONFIG = 2;
export const V2_DATA = 3;

export const V2_OPCODE_PLAIN = 1;
export const V2_OPCODE_ENCRYPTED = 2;

export interface V2Packet {
  type: number;
  seq: number;
  payload: Uint8Array;
}

export function encodeV2Frame(type: number, seq: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  header[0] = 0xa5;
  header[1] = 0xa5;
  header[2] = type & 0x0f;
  header[3] = seq & 0xff;
  header.set(u16le(payload.length), 4);
  header.set(u16le(crc16arc(payload)), 6);
  return concat(header, payload);
}

export function parseV2(buf: Uint8Array): Parse<V2Packet> {
  if (buf.length < 8) return { status: 'incomplete' };
  if (buf[0] !== 0xa5 || buf[1] !== 0xa5) return { status: 'invalid' };
  const len = readU16le(buf, 4);
  const size = 8 + len;
  if (buf.length < size) return { status: 'incomplete' };
  const payload = buf.slice(8, size);
  if (crc16arc(payload) !== readU16le(buf, 6)) return { status: 'complete', size, packet: null };
  return { status: 'complete', size, packet: { type: buf[2] & 0x0f, seq: buf[3], payload } };
}

/** Session config the official app sends: version 1.0.0, max frame 0xfc00, tx window 32, timeout 10 s. */
export function v2SessionConfigPayload(opCode = 1): Uint8Array {
  return new Uint8Array([
    opCode,
    0x01, 0x03, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x00, 0x00, 0xfc,
    0x03, 0x02, 0x00, 0x20, 0x00,
    0x04, 0x02, 0x00, 0x10, 0x27,
  ]);
}

export interface V2SessionConfig {
  opCode: number;
  maxPacketSize?: number;
  txWindow?: number;
  sendTimeout?: number;
}

export function parseV2SessionConfig(p: Uint8Array): V2SessionConfig {
  const cfg: V2SessionConfig = { opCode: p[0] ?? -1 };
  let off = 1;
  while (p.length - off >= 3) {
    const key = p[off];
    const size = readU16le(p, off + 1);
    off += 3;
    if (p.length - off < size) break;
    if (size === 2) {
      const v = readU16le(p, off);
      if (key === 2) cfg.maxPacketSize = v;
      if (key === 3) cfg.txWindow = v;
      if (key === 4) cfg.sendTimeout = v;
    }
    off += size;
  }
  return cfg;
}

const V2_RAW_CHANNEL: Record<string, number> = { auth: 1, proto: 1, data: 2, activity: 5 };

export function v2DataPayload(channel: Channel, body: Uint8Array): Uint8Array {
  const opCode = channel === 'proto' || channel === 'activity' ? V2_OPCODE_ENCRYPTED : V2_OPCODE_PLAIN;
  return concat(new Uint8Array([V2_RAW_CHANNEL[channel] & 0x0f, opCode]), body);
}

export function v2DecodeData(p: Uint8Array): { channel: Channel; opCode: number; body: Uint8Array } | null {
  if (p.length < 2) return null;
  const raw = p[0] & 0x0f;
  const channel: Channel = raw === 1 ? 'proto' : raw === 2 ? 'data' : raw === 5 ? 'activity' : 'unknown';
  return { channel, opCode: p[1], body: p.slice(2) };
}

// ---------------------------------------------------------------- SPP V1 ----

export const V1_PREAMBLE = [0xba, 0xdc, 0xfe];
export const V1_EPILOGUE = 0xef;
export const V1_DATA_PLAIN = 0;
export const V1_DATA_ENCRYPTED = 1;
export const V1_DATA_AUTH = 2;
export const V1_OPCODE_READ = 0;
export const V1_OPCODE_SEND = 2;

export interface V1Packet {
  channel: Channel;
  flag: boolean;
  needsResponse: boolean;
  opCode: number;
  frameSerial: number;
  dataType: number;
  payload: Uint8Array;
}

export function v1RawChannel(channel: Channel): number {
  switch (channel) {
    case 'version': return 0;
    case 'auth':
    case 'proto': return 2; // PROTO_TX
    case 'activity': return 3;
    case 'data': return 5;
    default: return 0x0f;
  }
}

function v1ChannelFromRaw(raw: number): Channel {
  switch (raw) {
    case 0: return 'version';
    case 1:
    case 2: return 'proto';
    case 3: return 'activity';
    case 5: return 'data';
    default: return 'unknown';
  }
}

export function encodeV1(p: Omit<V1Packet, 'channel'> & { channel: Channel }): Uint8Array {
  const out = new Uint8Array(11 + p.payload.length);
  out.set(V1_PREAMBLE, 0);
  out[3] = v1RawChannel(p.channel) & 0x0f;
  out[4] = (p.flag ? 0x80 : 0) | (p.needsResponse ? 0x40 : 0);
  out.set(u16le(p.payload.length + 3), 5);
  out[7] = p.opCode & 0xff;
  out[8] = p.frameSerial & 0xff;
  out[9] = p.dataType & 0xff;
  out.set(p.payload, 10);
  out[out.length - 1] = V1_EPILOGUE;
  return out;
}

export function parseV1(buf: Uint8Array): Parse<V1Packet> {
  if (buf.length < 11) return { status: 'incomplete' };
  if (buf[0] !== 0xba || buf[1] !== 0xdc || buf[2] !== 0xfe) return { status: 'invalid' };
  const size = readU16le(buf, 5) + 8;
  if (buf.length < size) return { status: 'incomplete' };
  if (buf[size - 1] !== V1_EPILOGUE) return { status: 'invalid' };
  const flags = buf[4];
  return {
    status: 'complete',
    size,
    packet: {
      channel: v1ChannelFromRaw(buf[3] & 0x0f),
      flag: (flags & 0x80) !== 0,
      needsResponse: (flags & 0x40) !== 0,
      opCode: buf[7],
      frameSerial: buf[8],
      dataType: buf[9],
      payload: buf.slice(10, size - 1),
    },
  };
}

/** The very first packet sent over SPP: asks which SPP protocol version the band speaks. */
export function v1VersionRequest(): Uint8Array {
  return encodeV1({
    channel: 'version',
    flag: true,
    needsResponse: true,
    opCode: V1_OPCODE_READ,
    frameSerial: 0,
    dataType: V1_DATA_PLAIN,
    payload: new Uint8Array(0),
  });
}
