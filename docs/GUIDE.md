# MiBand Hack user guide

Install apps and watchfaces on a **Xiaomi Smart Band 8 / 9 / 10** right from your computer, with no software to install.

👉 **Open: <https://miband.trinh.uk>**

> ⚠️ A community project, not made by Xiaomi. Sideloaded apps may make the band behave erratically. If something goes wrong, remove that app or restart the band.

---

## What you need

| | |
|---|---|
| 💻 Computer | Windows, macOS or Linux, with Bluetooth |
| 🌐 Browser | **Google Chrome** or **Microsoft Edge** (Safari and Firefox do **not** work) |
| ⌚ Band | Mi Band 8, 9, 9 Pro, 9 Active, 10, 10 Pro, **already paired with the Mi Fitness app** on your phone |
| 📱 Phone or iPad | To scan a QR code that gets the band's "key" (iPhone, iPad or Android) |

---

## Step 1: Get the band's key (auth key)

Every band has its own key issued by Xiaomi. Without it, the computer cannot talk to the band.

1. On the website, press the orange button **"No key yet? Get it automatically with your Xiaomi account"**.
2. A QR code appears. Scan it with the camera of your phone or iPad, and sign in with **the same Xiaomi account the band is paired with in Mi Fitness** (in Mi Fitness: *Profile* shows the account). Can't scan? Press *"Open the Xiaomi login page"* and sign in on the computer instead.
3. Confirm the login (Xiaomi may ask for a verification code).
4. A few seconds later, your band appears in a list (marked *Mi Fitness*). Press **"Use this key"** on its row.
   If a band has two rows with different keys (*from "encrypt_key"* / *from "token"*), try the first one; if the band says "Wrong auth key", use the other.
5. Tick **"Remember on this browser"** so you don't have to do this again next time.

The page first reads the band list of **Mi Fitness** (Mi Band 7 Pro, 8, 9, 10, Xiaomi watches), then the Bluetooth devices of **Mi Home**, with one login.

**Band not in the list?** The page says what it checked:
- *"Mi Fitness lists no band on this account"*: you signed in with another Xiaomi account than the one in Mi Fitness, or try another **Account region** (for Vietnam it is usually *Singapore*).
- *"Xiaomi did not hand out the Mi Fitness device list"*: this cloud route is new and Xiaomi may change it. Use one of the ways below.

### Other ways to get the key

**iPhone / iPad (easiest, no Android needed)**: the key is in one small file of the Mi Fitness app.

1. In **Files**: **On My iPad** (or iPhone) → **Mi Fitness** → **MHWCahe** → the number folder → **VirtualDevice_registerList**.
2. AirDrop both **`manifest.sqlite`** and **`manifest.sqlite-wal`** to the computer (sometimes only one exists; that's fine).
3. On the website, open *"Other ways to get the auth key"* and pick both files together. The key can be in either file, depending on when Mi Fitness last saved its database. The page reads it in the browser (nothing is uploaded) and shows **"Use this key"**.
4. Delete the file afterwards.

The whole Mi Fitness folder compressed as a .zip works too, but it also holds your health data. Confirmed on a Mi Band 10 synced with Mi Fitness on an iPad (account region Singapore).

**Android**: Mi Fitness writes the key to its log files.

1. Open Mi Fitness with the band connected and let it sync.
2. Connect the phone to a computer over USB (file transfer) and copy the logs from `Android/data/com.mi.health/files/log/` (older versions: `Android/data/com.xiaomi.wearable/files/log/`), e.g. `XiaomiFit.device.log`, `Transfer.device.log` and their `.bak` copies.
3. Search them for `encryptKey=` or `token=` followed by 32 hex characters and use the **last** match, e.g.
   `grep -Eo '(encryptKey|token|authKey)[=:" ]+[0-9a-fA-F]{32}' *.log* | tail -1`
   (the line usually contains `createApiCall() called with: device DeviceInfo(`).

More background: the [Gadgetbridge guide](https://gadgetbridge.org/basics/pairing/huami-xiaomi-server/).

> 🔒 The page never asks for your Xiaomi password. The login session is used once to read the key and then discarded, never stored or logged.

**Don't** unpair the band in Mi Fitness, and don't reset the band: doing either changes the key and you'll have to get it again.

---

## Step 2: Connect the band

1. **Turn off Bluetooth on your phone / iPad** (in Settings, not just Control Center) and quit Mi Fitness: the band talks to one device at a time.
2. **First time on this computer only:**
   - If the band is listed in the computer's Bluetooth settings, remove it (**Forget This Device**). An old pairing record makes the band refuse the connection.
   - On the band, open **Settings → System → Connect to new phone** and leave that waiting screen open. Without it, a band already paired with a phone refuses a new computer (the log shows `NO_BOUND` or the link drops before authentication).
3. Pick a connection:
   - **Mac + Mi Band 10: Mac helper (tested).** Chrome on macOS cannot open the band's Bluetooth Classic port by itself, so a small helper opens it. It is a developer option, not shown on miband.trinh.uk: in a clone of this repo run `bash tools/bridge/run.sh` (needs Node and the Xcode command line tools) and keep it running, start the page locally with `npm run dev`, open http://localhost:5173 and press **Mac helper (Mi Band 10)**.
   - **Mi Band 8 / 9 / 10 / 11 / 9 Active** (Bluetooth Low Energy): pick the band in the dialog → **Pair**. Not yet confirmed to install apps on a Mi Band 9 or 10.
     - Mi Band 9/10: enter the **Device ID** as well as the auth key; without it the band accepts the handshake and then ignores every command.
     - Mi Band 8: watchfaces only; it does not run third-party apps (.rpk). A watchface goes over at about 2 KB/s (a 1 MB face takes about 10 minutes).
   - **Bluetooth Classic (SPP)**: for a band that shows up as a serial port after pairing it in the computer's Bluetooth settings (mostly Windows/Linux).
4. **Look at the band:** it asks to accept a pairing request (on a Mi Band 10 the text may show as `pair_request.setupwizard / accept_ble_request.system`). Press the **lower (blue) button**. The first attempt often times out even after accepting; press Connect again.
5. **After the band restarts** (for example after an app crashed it) it may have dropped the computer's pairing: the connection times out or fails. Repeat step 2. If the band was bound to Mi Fitness again in the meantime, get a new key (Step 1).

You're done when you see the green dot **"Connected"** together with the model name and battery %.

---

## Step 3: Install apps

**Quickest way:** in the **"Demo apps"** section, press **Add** next to the app you want (e.g. *Calculator*). Wait for the progress bar to finish and you're done; the app will show up in the band's app list.

**Notes app (your own notes):** press **Edit notes** next to the Notes app, type the title and content of each note (add as many as you like), then press **Add**. On the band: the note list → tap one to read it → the **Back** button to go back. To change the content, edit it on the page and press **Add** again. Notes are **saved automatically in the browser**: they're still there after reloading the page or reopening it the next day. Use **Export** to download a `.json` backup (recommended, since clearing browser data deletes your notes), and **Import** to load it back or move it to another computer.

**Checklist app (shopping, to-do, packing lists):** press **Edit lists** next to the Checklist app. Give each list a title and add items (Enter adds the next item; ↑ ↓ reorder, ✕ removes), then press **Add**. On the band: the lists with their progress (e.g. 3/8) → tap a list → tap an item to tick it off (tap again to untick) → **Uncheck all** asks for a second tap → **Back** returns. Ticks are saved on the band. When you edit the lists and press **Add** again, items you kept stay ticked and new items start unticked. Like notes, the lists are saved only in this browser: **Export** / **Import** move them between computers.

**Change the language:** the **EN · 中文 · VI** buttons in the top corner.

**Install your own file:** drag and drop a `.rpk` file (app) or `.bin` file (watchface) onto the **"Or install your own file"** box, then press **Install to band**.

**Remove apps / change watchfaces:** use the **"Apps on band"** and **"Watchfaces"** lists at the bottom of the page.

---

## Install as an app on your computer (optional)

Press the **"Install as app"** button in the top corner, or the install icon in Chrome's address bar. You'll get a MiBand Hack icon on your desktop, just like regular software.

---

## Having trouble?

| Symptom | Fix |
|---|---|
| The connect button is greyed out | You're using Safari/Firefox → open the page in Chrome or Edge |
| The band doesn't appear in the dialog | Turn off Bluetooth on your phone. Mi Band 9/10: check that it's paired in your computer's Bluetooth settings. Linux: enable `chrome://flags/#enable-experimental-web-platform-features` |
| "Wrong auth key" | Get the key again in Step 1, choosing your band's row |
| "Authentication timed out" | The phone is still holding the connection to the band → turn Bluetooth on the phone fully off and try again |
| `NO_BOUND` in the log, or the link drops before authentication | First time on this computer: do Step 2.2 (forget the band in Bluetooth settings, then *Connect to new phone* on the band) |
| "No reply from band" right after connecting, no battery or app list | The band is still on the *Connect to new phone* screen, or Mi Fitness is still connected → return the band to its watch face, turn off the phone's Bluetooth, connect again |
| "Band rejected the app" | The app isn't compatible with this band model |
| "contains plain JavaScript" | Mi Band 10 only runs compiled quick apps: rebuild with `aiot release --enable-jsc` (needs `@aiot-toolkit/jsc`) |
| The band restarts after opening an app and the app is gone | The firmware removes an app that crashed it. Open an app only once (don't press **Open** again while it runs); tell us which app it was |
| The band behaves oddly after installing | Remove the app you just installed from the "Apps on band" list, or restart the band |

Still stuck? Open the **"Connection log"** section at the bottom of the page, take a screenshot and [open an issue on GitHub](https://github.com/ptrinh/miband-hack/issues).
