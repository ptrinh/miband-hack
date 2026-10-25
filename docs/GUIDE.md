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
| 📱 Phone | To scan a QR code that gets the band's "key" |

---

## Step 1: Get the band's key (auth key)

Every band has its own key issued by Xiaomi. Without it, the computer cannot talk to the band.

1. On the website, press the orange button **"No key yet? Get it automatically with your Xiaomi account"**.
2. A QR code appears. Scan it with a phone **signed in to the same Xiaomi account the band is paired with** (e.g. the Xiaomi Home / Mi Home app).
3. Confirm the login on your phone.
4. A few seconds later, a list of devices appears. Press **"Use this key"** on your band's row.
5. Tick **"Remember on this browser"** so you don't have to do this again next time.

**Band not in the list?**
- Pick the correct **Account region** (for Vietnam it is usually *Singapore*) and press the button again.
- If that still doesn't work: open *"Other ways to get the auth key"* on the page, or ask someone tech-savvy to help following the [Gadgetbridge guide](https://gadgetbridge.org/basics/pairing/huami-xiaomi-server/).

> 🔒 The page never asks for your Xiaomi password. The login session is used once to read the key and then discarded, never stored.

**Don't** unpair the band in Mi Fitness, and don't reset the band: doing either changes the key and you'll have to get it again.

---

## Step 2: Connect the band

1. **Turn off Bluetooth on your phone**: the band can only talk to one device at a time.
2. Press the button that matches your band:

| Your band | Press | Prepare first |
|---|---|---|
| Mi Band **9, 10, 9 Pro, 10 Pro** | **Mi Band 9 / 10 / 9 Pro / 10 Pro** | In your computer's Bluetooth settings, **pair with the band** first |
| Mi Band **8**, **9 Active** | **Mi Band 8 / 9 Active…** | Nothing |

3. The browser shows a dialog:
   - Mi Band 9/10: pick the row that says **"Bluetooth SPP"** or the band's name → **Connect**.
   - Mi Band 8: pick the band's name (e.g. *Xiaomi Smart Band 8 XXXX*) → **Pair**.
4. You're done when you see the green dot **"Connected"** together with the model name and battery %.

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
| "Band rejected the app" | The app isn't compatible with this band model |
| The band behaves oddly after installing | Remove the app you just installed from the "Apps on band" list, or restart the band |

Still stuck? Open the **"Connection log"** section at the bottom of the page, take a screenshot and [open an issue on GitHub](https://github.com/ptrinh/miband-hack/issues).
