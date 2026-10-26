import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import subprocess
import tempfile

base=Path(__file__).parent
with tempfile.TemporaryDirectory(prefix='miband-spp-smoke-') as tmp:
    root=Path(tmp)
    for src,dst in [('spp-probe.mjs','spp-probe.mjs'),('extract-key.py','extract-key.py'),('mock-spp','native-spp')]:
        shutil.copy2(base/src,root/dst)
    (root/'native-spp').chmod(0o700)
    db=sqlite3.connect(root/'manifest.sqlite')
    db.execute('pragma journal_mode=wal')
    db.execute('create table manifest(key text, inline_data blob)')
    db.commit(); db.execute('pragma wal_checkpoint(truncate)')
    archive={'$objects':[], '$top':{'root':{'model':'miwear.watch.o66gl','encryptKey':'00'*16,'mac':'00:00:00:00:00:01'}}}
    db.execute('insert into manifest values(?,?)',('registerList_test',plistlib.dumps(archive,fmt=plistlib.FMT_BINARY)))
    db.commit()
    for mode,code,expected in [('success',0,'AUTH_SUCCESS; encrypted device info and app list received'),('no-bound',2,'SPP NO_BOUND (4)'),('wrong-key',2,'Protocol error:'),('no-spp',2,'no SPP service advertised')]:
        result=subprocess.run(['node',str(root/'spp-probe.mjs'),str(root/'manifest.sqlite-wal')],env={**os.environ,'MOCK_MODE':mode},capture_output=True,text=True,timeout=10)
        assert result.returncode==code, (mode,result.returncode,result.stdout,result.stderr)
        assert expected in result.stdout, (mode,result.stdout)
        assert '00:00:00:00:00:01' not in result.stdout
        assert '0'*32 not in result.stdout
        print(mode+': passed')
    db.close()
