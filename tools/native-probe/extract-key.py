"""Read one Mi Band 10 key from an NSKeyedArchiver cache; stdout is a private pipe."""
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import sqlite3
import sys
import tempfile

def extract(wal):
    wal = Path(wal)
    if not str(wal).endswith('.sqlite-wal'):
        raise ValueError('Expected manifest.sqlite-wal and its companion manifest.sqlite')
    base = Path(str(wal)[:-4])
    with tempfile.TemporaryDirectory(prefix='miband-key-') as tmp:
        target = Path(tmp) / 'manifest.sqlite'
        for suffix in ['', '-wal']:
            shutil.copyfile(str(base) + suffix, str(target) + suffix)
            os.chmod(str(target) + suffix, 0o600)
        c = sqlite3.connect(target)
        rows = c.execute("SELECT inline_data FROM manifest WHERE key LIKE 'registerList_%'").fetchall()
        c.close()
        keys = set()
        addresses = set()
        for (blob,) in rows:
            archive = plistlib.loads(blob)
            objects = archive['$objects']
            def resolve(x):
                if isinstance(x, plistlib.UID): return resolve(objects[x.data])
                if isinstance(x, list): return [resolve(v) for v in x]
                if isinstance(x, dict):
                    if 'NS.keys' in x: return dict(zip(resolve(x['NS.keys']), resolve(x['NS.objects'])))
                    if 'NS.objects' in x: return resolve(x['NS.objects'])
                    return {k: resolve(v) for k, v in x.items() if k != '$class'}
                return x
            def visit(x):
                if isinstance(x, dict):
                    if x.get('model') == 'miwear.watch.o66gl':
                        key = x.get('encryptKey')
                        if isinstance(key, str) and re.fullmatch(r'[0-9a-fA-F]{32}', key): keys.add(key.lower())
                        address = x.get('mac')
                        if isinstance(address, str) and re.fullmatch(r'(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}', address): addresses.add(address.lower())
                    for v in x.values(): visit(v)
                elif isinstance(x, list):
                    for v in x: visit(v)
            visit(resolve(archive['$top']))
        if len(keys) != 1:
            raise ValueError(f'Expected one Mi Band 10 key, found {len(keys)}')
        if len(addresses) != 1: raise ValueError('Ambiguous band address')
        return {'authKey': keys.pop(), 'mac': addresses.pop()}

if __name__ == '__main__':
    try:
        print(json.dumps(extract(sys.argv[1])))
    except Exception as exc:
        print(f'Key extraction failed: {type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
