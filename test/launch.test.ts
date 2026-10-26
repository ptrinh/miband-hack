import { describe, expect, it } from 'vitest';
import { hex } from '../src/core/bytes';
import { encodeCommand } from '../src/core/proto';

describe('launch app command', () => {
  it('matches AstroBox: ThirdpartyApp id 4, launch_info(6){basic_info(1){package_name, fingerprint}, uri(2)}', () => {
    const cmd = { type: 20, subtype: 4, rpk: { rpkLaunch: { app: { id: 'a.b', sha: new Uint8Array([1, 2]) }, uri: '' } } };
    // 08 14 | 10 04 | b2 01 (field 22) len 0f | 32 (field 6) len 0d | 0a len 09 { 0a 03 "a.b" 12 02 01 02 } | 12 00
    expect(hex(encodeCommand(cmd), 99)).toBe('08141004b2010f320d0a090a03612e62120201021200');
  });
});
