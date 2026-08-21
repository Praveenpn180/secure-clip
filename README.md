# SecureClip

A tiny installable PWA for copying/pasting snippets between your own devices.
No backend — it reads and writes a single JSON file in a GitHub repo you own,
using the GitHub Contents API directly from the browser.

## 1. Create a private repo

Make a **private** GitHub repo (e.g. `secureclip-data`) to hold the data file.
Private matters: only *locked* items are encrypted — unlocked items are stored
as plain text in the JSON file, so the repo itself is your first line of defense.

## 2. Create a token

GitHub → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → New token.
- Repository access: **only** the repo you made above.
- Permissions: **Contents: Read and write**.

## 3. Host the app

These are static files — host them anywhere over HTTPS (GitHub Pages, Netlify,
Vercel, Cloudflare Pages all work free). E.g. for GitHub Pages: push this
folder to a repo and enable Pages on it. It doesn't need to be the same repo
as your data — keep the app repo public/whatever, keep the data repo private.

## 4. Open the app, connect

Open the hosted URL → tap ⚙ Settings → enter your token, repo owner, repo
name, and (optionally) file path/branch → Save & connect. On mobile, use
"Add to Home Screen" / the browser's install prompt to make it a real app icon.

## Using it

- **＋** adds an item: just multi-line text (e.g. username on line 1,
  password on line 2). The list shows each item by its first line or two,
  no separate title to manage.
- Tap an item to expand it, then **Copy** to grab the whole thing.
- Check **Lock this item with a passphrase** to encrypt it (AES-GCM, key
  derived from your passphrase via PBKDF2). A locked item asks for the
  passphrase before it'll show its contents on any device — the passphrase
  itself is never stored or synced anywhere.
- **✎ Edit** to clean up/retitle/re-lock an item; **Delete** to remove it.
- **⟳** pulls the latest from GitHub; it also auto-refreshes quietly every
  20s while the tab is open, so a save on one device shows up on the other
  without extra taps.

## Passphrases

- Every locked item can have its own passphrase, **or**
- Open Settings and set a **default passphrase** — it's kept in memory for
  that browser tab only (never saved or synced), auto-unlocks any item locked
  with it, and pre-fills the lock field on new items. Any individual item can
  still be given a different passphrase by typing over the pre-filled value.

## Connecting a second device

Settings → **Copy setup link** or **Show QR code**. Both encode your token
and repo details into a one-time link. On the new device, either:
- open Settings → **📷 Scan QR** and point the camera at the code, or
- paste the link into the **"Or paste the setup link here"** box, or
- just open the link directly (e.g. AirDrop it to the other device).

Any of these fills in Settings for you and strips the link out of the
address bar/history right after. Treat that link like a password: only
share it over a channel you trust (AirDrop, scanning it in person — not a
public chat). Scanning needs camera permission and only works over HTTPS
(or on localhost); if the camera isn't available, use the paste box instead.

The QR/camera code is self-contained in this app (`vendor/qrcode.min.js` and
`vendor/jsqr.min.js`, both MIT/Apache-2.0 licensed, bundled from the `qrcode`
and `jsqr` npm packages) — no third-party CDN is contacted at runtime, so
your token never leaves the device while generating or reading a code.

## Notes

- If you edit the same item on two devices at nearly the same moment, the
  second save will detect the conflict, reload the latest version, and ask
  you to redo your change — there's no merge logic, by design (keeps this
  simple).
- Forgetting a passphrase means that item's contents are unrecoverable —
  there's no reset.
