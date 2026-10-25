#!/usr/bin/env python3
"""Decode the Xiaomi band traffic in an Apple Bluetooth HCI log (.pklg from an iOS sysdiagnose).

    python3 -I decode_pklg.py bluetoothd-hci-latest.pklg            # list BLE connections
    python3 -I decode_pklg.py bluetoothd-hci-latest.pklg 0x40       # decode one connection handle

For each connection handle it reassembles L2CAP/ATT, finds SPP V2 frames (a5 a5 ...) on GATT
writes and notifications, and prints session configs and the protobuf *structure* of plain
(opcode 1) data frames: field numbers, varints and byte lengths. Byte values are never printed,
so the output is safe to share; pass --show-strings to also print short UTF-8 strings (these
can include a serial number or other identifiers: check before publishing).
"""
import datetime
import struct
import sys

SHOW_STRINGS = '--show-strings' in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith('--')]


def records(path):
    """PacketLogger records: u32 BE length, u64 BE timestamp (secs << 32 | usecs), u8 type, payload."""
    b = open(path, 'rb').read()
    o = 0
    while o + 13 <= len(b):
        ln = struct.unpack('>I', b[o:o + 4])[0]
        ts = struct.unpack('>Q', b[o + 4:o + 12])[0]
        yield (ts >> 32) + (ts & 0xffffffff) / 1e6, b[o + 12], b[o + 13:o + 4 + ln]
        o += 4 + ln


def hhmmss(t):
    return datetime.datetime.fromtimestamp(t).strftime('%H:%M:%S.%f')[:-3]


def list_connections(path):
    for t, typ, p in records(path):
        if typ == 0x01 and len(p) > 13 and p[0] == 0x3e and p[2] in (0x01, 0x0a) and p[3] == 0:
            handle = struct.unpack('<H', p[4:6])[0] & 0xfff
            addr_type = ('public', 'random', 'public identity', 'random identity')[p[7] & 3]
            print(f'{hhmmss(t)} LE connection handle 0x{handle:x} ({addr_type} address)')
        if typ == 0x01 and len(p) > 5 and p[0] == 0x05:
            handle = struct.unpack('<H', p[3:5])[0] & 0xfff
            print(f'{hhmmss(t)} disconnect handle 0x{handle:x} reason 0x{p[5]:02x}')


def att_pdus(path, want):
    buf = {}
    for t, typ, p in records(path):
        if typ not in (2, 3) or len(p) < 4:
            continue
        hf = struct.unpack('<H', p[0:2])[0]
        if hf & 0xfff != want:
            continue
        key = typ
        if (hf >> 12) & 3 in (0, 2):
            buf[key] = bytearray(p[4:])
        else:
            buf.setdefault(key, bytearray()).extend(p[4:])
        b = buf[key]
        if len(b) >= 4:
            ln, cid = struct.unpack('<HH', b[0:4])
            if len(b) >= 4 + ln:
                buf[key] = bytearray()
                if cid == 4:
                    yield t, 'phone→band' if typ == 2 else 'band→phone', bytes(b[4:4 + ln])


def varint(b, i):
    v = s = 0
    while True:
        c = b[i]
        i += 1
        v |= (c & 0x7f) << s
        s += 7
        if not c & 0x80:
            return v, i


def proto(b, depth=0):
    out, i = [], 0
    while i < len(b):
        k, i = varint(b, i)
        f, w = k >> 3, k & 7
        pad = '  ' * depth
        if w == 0:
            v, i = varint(b, i)
            out.append(f'{pad}{f}: {v}')
        elif w == 2:
            ln, i = varint(b, i)
            v = b[i:i + ln]
            i += ln
            sub = None
            if depth < 5 and ln > 1:
                try:
                    sub = proto(v, depth + 1)
                except Exception:
                    sub = None
            if sub:
                out += [f'{pad}{f}: {{'] + sub + [f'{pad}}}']
            else:
                s = ''
                if SHOW_STRINGS:
                    try:
                        txt = v.decode('utf-8')
                        if txt.isprintable() and len(txt) <= 64:
                            s = f' "{txt}"'
                    except UnicodeDecodeError:
                        pass
                out.append(f'{pad}{f}: bytes[{ln}]{s}')
        elif w in (1, 5):
            i += 8 if w == 1 else 4
            out.append(f'{pad}{f}: fixed{64 if w == 1 else 32}')
        else:
            raise ValueError('wire type')
    return out


def decode(path, handle):
    for t, d, pdu in att_pdus(path, handle):
        if pdu[0] not in (0x52, 0x12, 0x1b):
            continue
        v = pdu[3:]
        if len(v) < 8 or v[:2] != b'\xa5\xa5':
            continue
        typ, seq = v[2] & 0x0f, v[3]
        pl = v[8:8 + struct.unpack('<H', v[4:6])[0]]
        if typ == 2:
            print(f'{hhmmss(t)} {d} SESSION_CONFIG seq {seq}: {pl.hex()}')
        elif typ == 3 and len(pl) >= 2:
            ch, op = pl[0], pl[1]
            if op != 1:
                print(f'{hhmmss(t)} {d} DATA ch{ch} encrypted, {len(pl)} B')
                continue
            try:
                lines = proto(pl[2:])
            except Exception:
                print(f'{hhmmss(t)} {d} DATA ch{ch} plain, undecodable, {len(pl)} B')
                continue
            print(f'{hhmmss(t)} {d} DATA ch{ch} plain:')
            print('\n'.join('    ' + l for l in lines))


if __name__ == '__main__':
    if len(args) == 1:
        list_connections(args[0])
    elif len(args) == 2:
        decode(args[0], int(args[1], 16))
    else:
        print(__doc__)
