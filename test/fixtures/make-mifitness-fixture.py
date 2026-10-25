#!/usr/bin/env python3
"""Builds synthetic Mi Fitness (iOS) folder fixtures for test/mifitness-files.test.ts.

Mimics MHWCahe/<uid>/VirtualDevice_registerList/manifest.sqlite as described by
artyomxx/xiaomi-band-ios-export: a YYCache `manifest` table whose registerList_<region> value is
an NSKeyedArchiver binary plist with a list of devices carrying `encryptKey`.
All values are made up. Run: python3 test/fixtures/make-mifitness-fixture.py
"""
import os, plistlib, shutil, sqlite3, tempfile, zipfile
from plistlib import UID

HERE = os.path.dirname(os.path.abspath(__file__))


def archive(devices, pad=0):
    objs = ["$null"]
    def add(o):
        objs.append(o)
        return UID(len(objs) - 1)
    dev_cls = add({"$classname": "MHWVirtualDevice", "$classes": ["MHWVirtualDevice", "NSObject"]})
    arr_cls = add({"$classname": "NSArray", "$classes": ["NSArray", "NSObject"]})
    wrap_cls = add({"$classname": "MHWRegisterList", "$classes": ["MHWRegisterList", "NSObject"]})
    refs = []
    for d in devices:
        o = {"$class": dev_cls}
        for k, v in d.items():
            o[k] = add(v) if v is not None else UID(0)
        if pad:
            o["note"] = add("x" * pad)
        refs.append(add(o))
    arr = add({"NS.objects": refs, "$class": arr_cls})
    top = add({"list": arr, "$class": wrap_cls})
    return plistlib.dumps({"$version": 100000, "$archiver": "NSKeyedArchiver", "$top": {"root": top}, "$objects": objs}, fmt=plistlib.FMT_BINARY)


SCHEMA = "CREATE TABLE manifest (key text, filename text, size integer, inline_data blob, modification_time integer, last_access_time integer, extended_data blob, primary key(key))"
BAND = {"name": "Xiaomi Smart Band 9", "model": "miwear.watch.n67cn", "mac": "AA:BB:CC:DD:EE:01", "did": "1001", "encryptKey": "00112233445566778899AABBCCDDEEFF", "randomMac": None}
OLD = {"name": "Xiaomi Smart Band 8", "model": "hlth.band.m8", "mac": "AA:BB:CC:DD:EE:02", "did": "1002", "encryptKey": "0xffeeddccbbaa99887766554433221100"}
NOKEY = {"name": "Phone", "model": "phone", "did": "1003", "encryptKey": "short"}


def build(path, wal):
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    con.execute("PRAGMA page_size=1024")
    if wal:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA wal_autocheckpoint=0")
    con.execute(SCHEMA)
    con.execute("insert into manifest values (?,?,?,?,?,?,?)", ("other", None, 3, b"abc", 0, 0, None))
    con.commit()
    # Large value (> page) to exercise overflow pages; sg region suffix.
    blob = archive([BAND, NOKEY], pad=3000)
    con.execute("insert into manifest values (?,?,?,?,?,?,?)", ("registerList_sg", None, len(blob), blob, 0, 0, None))
    # Value kept in a YYCache data/ file instead of inline.
    con.execute("insert into manifest values (?,?,?,?,?,?,?)", ("registerList_de", "abc123", 0, None, 0, 0, None))
    for i in range(60):  # enough rows for an interior b-tree page
        con.execute("insert into manifest values (?,?,?,?,?,?,?)", (f"k{i:03}", None, 8, os.urandom(0) + b"v" * 40, i, i, None))
    con.commit()
    files = {"manifest.sqlite": open(path, "rb").read()}
    if wal:
        files["manifest.sqlite-wal"] = open(path + "-wal", "rb").read()
    con.close()
    return files


def main():
    tmp = tempfile.mkdtemp()
    base = "Mi Fitness/MHWCahe/123456/VirtualDevice_registerList/"
    with zipfile.ZipFile(os.path.join(HERE, "mifitness-folder.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in build(os.path.join(tmp, "m.sqlite"), wal=True).items():
            z.writestr(base + name, data)
        z.writestr(base + "data/abc123", archive([OLD]))
        z.writestr("Mi Fitness/DataBase/123456/de/123456.db", b"not needed")
        z.writestr("__MACOSX/Mi Fitness/MHWCahe/123456/VirtualDevice_registerList/._manifest.sqlite", b"junk")
    # Same content without WAL (checkpointed), as a lone manifest.sqlite.
    with open(os.path.join(HERE, "mifitness-manifest.sqlite"), "wb") as f:
        f.write(build(os.path.join(tmp, "p.sqlite"), wal=False)["manifest.sqlite"])
    shutil.rmtree(tmp)


if __name__ == "__main__":
    main()
