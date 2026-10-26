# Emulator preflight

Before a quick app goes near a real band, `preflight.sh` installs it in **Xiaomi's Vela emulator** (QEMU running real
NuttX/Vela with the miwear quick app runtime), starts it, watches the system console and uninstalls it again. It exits
with code 1 when an app does not install, does not start, logs a JS error, or makes the system assert / reboot.

```bash
tools/emulator/preflight.sh                                  # every public/apps/*.rpk, Band 9 and Band 10
tools/emulator/preflight.sh demo-apps/snake/dist/*.rpk       # one build
tools/emulator/preflight.sh --avd Vela_Band10 --watch 20 --out /tmp/pf public/apps/sat.rpk
```

Per app it runs `adb push` → `pm install` → `am start` (wait for `Start App loop`, then `--watch` seconds, default 10)
→ screenshot over gRPC → `pm uninstall` (which closes the app), then prints a table and the offending log lines. The
guest is rebooted between apps (`--no-reboot` to skip), see the limits below. Screenshots,
per-app logs and the full console log go to `--out` (default `$TMPDIR/miband-preflight/<avd>/`). It boots the AVD
headless and shuts it down at the end; an emulator that was already running is reused and left running.

## Setup (once, about 2.2 GB on disk)

```bash
mkdir -p ~/.vela/toolkit && cd ~/.vela/toolkit && npm init -y && npm i aiot-toolkit@2.0.5
~/.vela/toolkit/node_modules/.bin/aiot initEmulatorEnv      # downloads emulator, image, skins into ~/.vela/sdk
```

- `~/.vela/sdk`: emulator 32.1.15 for `darwin-aarch64` (~800 MB), image `vela-miwear-watch-5.0` 20250716 (~1.3 GB),
  skins, quick app fonts. Downloads come from Xiaomi's public `vela-ide.cnbj3-fusion.mi-fds.com` bucket.
- `~/.vela/vvd`: the AVDs. `preflight.mjs` creates them on first run: `Vela_Band9` (skin `xiaomi_band`, 192 x 490) and
  `Vela_Band10` (skin `xiaomi_band_10`, 212 x 520). `aiot createVVD` makes others interactively.
- `VELA_TOOLKIT=/path` if aiot-toolkit is installed elsewhere. A cold boot takes ~10 s, each app ~40 s including the reboot.

## What it catches

Checked against deliberately broken builds: a JS exception in `onInit` (`ReferenceError ... is not defined`,
`PageCallHook error`), an rpk that is not a zip, and a tampered signed rpk, which makes the installer try to allocate
2.8 GB, assert and **reboot the whole system** (`cpu_soft_reset(assert)`). The last one is the kind of failure we want
to see here and not on a band.

## Known limits

- **Not the band's firmware.** The image is Xiaomi's generic watch build (it calls itself "Xiaomi Watch S4"), not Mi
  Band 9 / 10 retail firmware. Passing here is necessary, not sufficient.
- **Layout is not to scale.** The band skins only set the framebuffer size; the runtime still scales `designWidth: 192`
  for a larger watch, so screenshots show the left part of the app enlarged. Use them to see that *something* rendered,
  not to check layout (`tools/screenshots/` renders the real layout).
- Apps build with `logLevel: off`, so `console.log` from the app does not show; runtime errors still do.
- No watchfaces (only `.rpk` quick apps), no BLE, no phone companion, no real sensors.
- Storage limits and the band's ~free-space rules are not modelled; an app that fits here can still not fit on a band.
- Only the first page is opened; nothing is tapped. A crash behind a button press will not be found.
- **The image crashes on repeated app closes.** Closing the 2nd or 3rd quick app since boot panics the `miwear`
  process (data abort in `pagemanager on_ui_destroy`) and reboots the guest, with any app, our counter included, so the
  tool reboots before every app. A crash while closing an app that was the first one on a fresh boot is still reported.
- QEMU emulates the 32-bit ARM guest without hardware acceleration ("hvf is not enabled"), so it is slow; give big apps
  more time with `--launch-timeout`.
