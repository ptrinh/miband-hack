#!/usr/bin/env node
// Installs quick apps (.rpk) into Xiaomi's Vela emulator, starts each one, watches the console log and fails when an app
// does not install, does not start, or logs a JS error / crash. See README.md in this folder.
//
// node tools/emulator/preflight.mjs [--avd Vela_Band9] [--avd Vela_Band10] [--out DIR] [--watch 10] [--no-reboot] [app.rpk ...]
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const toolkitDir = process.env.VELA_TOOLKIT || path.join(os.homedir(), '.vela/toolkit')
const require = createRequire(path.join(toolkitDir, 'package.json'))
let E, AdmZip, adb
try {
  E = require('@aiot-toolkit/emulator')
  AdmZip = require('adm-zip')
  adb = require('@miwt/adb')
} catch (e) {
  console.error(`aiot-toolkit not found in ${toolkitDir} (set VELA_TOOLKIT). Setup: tools/emulator/README.md`)
  process.exit(69)
}

// AVD name -> emulator skin. Both use the vela-miwear-watch-5.0 system image.
const AVDS = { Vela_Band9: 'xiaomi_band', Vela_Band10: 'xiaomi_band_10' }
const IMAGE = E.VelaImageType.VELA_MIWEAR_WATCH_5

const args = process.argv.slice(2)
const opt = { avds: [], out: path.join(os.tmpdir(), 'miband-preflight'), watch: 10, launch: 40, rpks: [], reboot: true }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--avd') opt.avds.push(args[++i])
  else if (a === '--out') opt.out = path.resolve(args[++i])
  else if (a === '--watch') opt.watch = Number(args[++i])
  else if (a === '--launch-timeout') opt.launch = Number(args[++i])
  else if (a === '--no-reboot') opt.reboot = false
  else if (a === '-h' || a === '--help') {
    console.log('Usage: preflight.sh [--avd Vela_Band9|Vela_Band10 ...] [--out DIR] [--watch SECONDS] [--launch-timeout SECONDS] [--no-reboot] [app.rpk ...]')
    process.exit(0)
  } else if (a.startsWith('-')) {
    console.error(`unknown option ${a}`)
    process.exit(64)
  } else opt.rpks.push(path.resolve(a))
}
if (!opt.avds.length) opt.avds = Object.keys(AVDS)
if (!opt.rpks.length) {
  const dir = path.join(repoDir, 'public/apps')
  opt.rpks = fs.readdirSync(dir).filter((f) => f.endsWith('.rpk')).sort().map((f) => path.join(dir, f))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const manager = new E.VvdManager({ sdkHome: E.defaultSDKHome, vvdHome: E.defaultVvdHome })

// Lines that mean the app (or the system) broke. Checked only on lines logged after `am start`.
const APP_ERROR = [
  /\[AIOTJS\].*(error|exception|uncaught|abort)/i,
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|InternalError|EvalError|URIError)\b/,
  /\bJS_?(Exception|Error)\b/i,
  /\b(PANIC|up_assert|_assert|assertion failed|hard ?fault|segmentation fault|stack overflow|out of memory)\b/i,
  /mm_malloc: WARNING: Allocation failed/,
]
// The guest OS restarted: an assert/panic reset the CPU, or the boot banner showed up again.
const REBOOT = /cpu_soft_reset|\bNuttX\s+\d+\.\d+\.\d+ \w+ .* miwear\b/
// Known-harmless AIOTJS lines from the stock image (logged with every app, built-in ones included).
const IGNORE = [/get ide path failed/, /channel manager start failed/, /getMqttAddrFromFile/, /Error_on(Un)?[Rr]egister/, /opendir failed/]

function packageOf(rpk) {
  const zip = new AdmZip(rpk)
  const entry = zip.getEntry('manifest.json')
  if (!entry) throw new Error('no manifest.json in rpk')
  return JSON.parse(entry.getData().toString('utf8')).package
}

function ensureAvd(name) {
  try {
    manager.getVvdDir(name)
    return
  } catch {}
  const skinName = AVDS[name]
  if (!skinName) throw new Error(`no AVD ${name} (known: ${Object.keys(AVDS).join(', ')})`)
  return manager.getVelaSkinList().then((skins) => {
    const skin = skins.find((s) => s.name === skinName)
    if (!skin) throw new Error(`skin ${skinName} missing in ${E.defaultSDKHome}/skins`)
    manager.createVvd({
      name, skin: skin.name, 'skin.path': skin.path, width: '466', height: '466', arch: E.IVvdArchType.arm,
      imageDir: path.join(E.defaultSDKHome, 'system-images', IMAGE), imageType: IMAGE, customLcdRadius: '',
    })
    console.log(`created AVD ${name} (${skinName})`)
  })
}

async function runAvd(avd) {
  await ensureAvd(avd)
  const outDir = path.join(opt.out, avd)
  fs.mkdirSync(outDir, { recursive: true })
  const consoleLog = fs.createWriteStream(path.join(outDir, 'console.log'))
  const lines = [] // every log line with its arrival time
  let exited = false
  const onLine = (l) => {
    lines.push({ t: Date.now(), l })
    consoleLog.write(l + '\n')
  }
  console.log(`\n${avd}: booting (headless)…`)
  const grpcPort = await require('portfinder').getPortPromise({ port: 8554 })
  const boot = await manager.startVvd({
    vvdName: avd, qtHideWindow: true, grpcPort, stdoutCallback: onLine, stderrCallback: onLine,
    exitCallback: () => { exited = true }, customLogger: (m) => consoleLog.write(`# ${m}\n`),
  })
  const started = boot.coldBoot // only shut down an emulator this run started
  const inst = boot.emulatorInstance
  const agent = boot.getAgent()
  if (started) await sleep(5000) // let the launcher settle
  const shell = (cmd) => adb.execAdbCmdAsync(`adb -s ${inst.sn} shell ${cmd}`).catch((e) => String(e))
  const waitFor = async (re, since, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end && !exited) {
      const hit = lines.find((x) => x.t >= since && re.test(x.l))
      if (hit) return hit.l
      await sleep(250)
    }
    return null
  }
  const screenshot = (file) => new Promise((resolve) => {
    agent.client.getScreenshot({ format: 'PNG' }, agent.authMate, (err, res) => {
      if (err || !res?.image?.length) return resolve(false)
      fs.writeFileSync(file, res.image)
      resolve(true)
    })
  })

  // Error lines logged since `since`; a reboot counts as one.
  const problems = (since) => {
    const out = []
    for (const { t, l } of lines) {
      if (t < since || IGNORE.some((re) => re.test(l))) continue
      if (REBOOT.test(l)) out.push(`device rebooted: ${l}`)
      else if (APP_ERROR.some((re) => re.test(l))) out.push(l)
    }
    return out
  }
  // After a guest reboot, wait for the quick app installer to come back before the next app.
  const recover = async (since) => {
    const reboot = lines.find((x) => x.t >= since && REBOOT.test(x.l))
    if (!reboot) return false
    console.log(`${avd}: device rebooted, waiting for it to come back…`)
    await waitFor(/rpk installer init done/, reboot.t, 120000)
    await sleep(5000)
    return true
  }

  // This image panics (data abort in pagemanager on_ui_destroy, then reboots) when it closes the 2nd or 3rd quick app
  // since boot, whatever the app. So each app gets a freshly rebooted system and is the only one closed on it.
  let fresh = true
  const reboot = async () => {
    const t = Date.now()
    await shell('reboot')
    if (!(await waitFor(/rpk installer init done/, t, 120000))) throw new Error('emulator did not come back after reboot')
    await sleep(5000)
  }

  const results = []
  for (const rpk of opt.rpks) {
    if (!fresh && opt.reboot) await reboot()
    fresh = false
    const name = path.basename(rpk, '.rpk')
    const r = { avd, app: name, install: '-', launch: '-', errors: [], shot: '' }
    results.push(r)
    let pkg
    try {
      pkg = packageOf(rpk)
    } catch (e) {
      r.install = 'FAIL'
      r.errors.push(`bad rpk: ${e.message}`)
      continue
    }
    const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const t0 = Date.now()
    // Start clean: a copy left from an earlier run would turn this into an update.
    await shell(`pm uninstall ${pkg}`)
    await waitFor(new RegExp(`uninstalled app:\\s+${esc}`), t0, 3000)

    const tInstall = Date.now()
    const target = `/data/app/${pkg}.rpk`
    await adb.execAdbCmdAsync(`adb -s ${inst.sn} push "${rpk}" ${target}`).catch((e) => r.errors.push(`push: ${e}`))
    await shell(`pm install ${target}`)
    const inst1 = await waitFor(
      new RegExp(`rpk install: \\S+ ${esc} (success|fail)|install prepare failed|installation is running|InstallState_Finished|executeInstall.*(fail|error)|${REBOOT.source}`, 'i'),
      tInstall, 60000)
    if (inst1 && /success|InstallState_Finished/.test(inst1)) r.install = 'ok'
    else {
      r.install = 'FAIL'
      r.errors.push(inst1 && REBOOT.test(inst1) ? `device rebooted during install: ${inst1}`
        : inst1 || (exited ? 'emulator exited' : 'no install result within 60 s'))
      r.errors.push(...problems(tInstall))
      fresh = !!(await recover(tInstall))
      await shell(`pm uninstall ${pkg}`)
      continue
    }

    const tStart = Date.now()
    await shell(`rm /data/debugger_ip.cfg`)
    await shell(`am start ${pkg}`)
    const loop = await waitFor(/Start App loop/, tStart, opt.launch * 1000)
    r.launch = loop ? 'ok' : 'FAIL'
    if (!loop) r.errors.push(exited ? 'emulator exited' : `app loop did not start within ${opt.launch} s`)
    await sleep(opt.watch * 1000)
    const shotFile = path.join(outDir, `${name}.png`)
    if (await screenshot(shotFile)) r.shot = path.relative(process.cwd(), shotFile)

    r.errors.push(...problems(tStart))
    // the runtime dropped the app back to stopped while we were watching
    const stopped = new RegExp(`quickapp_state_trans: ${esc}: \\[\\w+\\]-->\\[(stopped|error)\\]`)
    r.errors.push(...lines.filter((x) => x.t >= tStart && stopped.test(x.l)).map((x) => x.l))
    if (exited) r.errors.push('emulator exited')
    await recover(tStart)

    // `pm uninstall` closes the running app first ("defered uninstall").
    const tUn = Date.now()
    await shell(`pm uninstall ${pkg}`)
    const gone = await waitFor(new RegExp(`uninstalled app:\\s+${esc}|${REBOOT.source}`), tUn, 20000)
    if (!gone || REBOOT.test(gone)) {
      r.errors.push(gone ? `device rebooted while closing/uninstalling: ${gone}` : 'uninstall not confirmed')
      r.errors.push(...problems(tUn))
      await recover(tUn)
      fresh = true
    }
    fs.writeFileSync(path.join(outDir, `${name}.log`), lines.filter((x) => x.t >= t0).map((x) => x.l).join('\n') + '\n')
    if (exited) break
  }

  if (started && !exited) {
    await inst.poweroff().catch(() => {})
    console.log(`${avd}: emulator shut down`)
  } else if (!started) console.log(`${avd}: was already running, left running`)
  try { agent.close() } catch {}
  inst.disposeReadlines?.()
  inst.logcatProcess?.kill?.()
  consoleLog.end()
  return results
}

const all = []
for (const avd of opt.avds) {
  try {
    all.push(...(await runAvd(avd)))
  } catch (e) {
    all.push({ avd, app: '(boot)', install: 'FAIL', launch: '-', errors: [String(e?.message || e)], shot: '' })
  }
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`\n${pad('AVD', 12)} ${pad('APP', 14)} ${pad('INSTALL', 8)} ${pad('LAUNCH', 7)} ${pad('ERRORS', 7)} RESULT`)
let failed = 0
for (const r of all) {
  const ok = r.install === 'ok' && r.launch === 'ok' && r.errors.length === 0
  if (!ok) failed++
  console.log(`${pad(r.avd, 12)} ${pad(r.app, 14)} ${pad(r.install, 8)} ${pad(r.launch, 7)} ${pad(r.errors.length, 7)} ${ok ? 'PASS' : 'FAIL'}`)
}
for (const r of all.filter((r) => r.errors.length)) {
  console.log(`\n${r.avd} ${r.app}:`)
  for (const e of [...new Set(r.errors)].slice(0, 12)) console.log(`  ${e.slice(0, 300)}`)
}
console.log(`\nScreenshots and logs: ${opt.out}`)
process.exit(failed ? 1 : 0)
