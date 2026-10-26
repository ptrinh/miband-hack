import { describe, expect, it } from 'vitest';
import { decodeCommand, encodeCommand } from '../src/core/proto';

describe('storage info', () => {
  it('decodes System.storage_info (field 44) from a GET_STORAGE_INFO (62) reply', () => {
    const big = 3 * 2 ** 30; // above 2^31: uint64 must not wrap
    const bytes = encodeCommand({ type: 2, subtype: 62, system: { storageInfo: { used: big, total: 4 * 2 ** 30 } } });
    const s = decodeCommand(bytes).system?.storageInfo;
    expect(Number(String(s?.used))).toBe(big);
    expect(Number(String(s?.total))).toBe(4 * 2 ** 30);
  });
});
