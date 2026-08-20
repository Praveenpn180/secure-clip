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

- **＋** adds an item: a title + multi-line text (e.g. username on line 1,
  password on line 2).
- Tap an item to expand it. Tap any **line** to copy just that line, or
  **Copy all** for the whole thing.
- Check **Lock this item with a passphrase** to encrypt it (AES-GCM, key
  derived from your passphrase via PBKDF2). A locked item asks for the
  passphrase before it'll show its contents on any device — the passphrase
  itself is never stored or synced anywhere.
- **✎ Edit** to clean up/retitle/re-lock an item; **Delete** to remove it.
- **⟳** pulls the latest from GitHub; it also auto-refreshes quietly every
  20s while the tab is open, so a save on one device shows up on the other
  without extra taps.

## Notes

- If you edit the same item on two devices at nearly the same moment, the
  second save will detect the conflict, reload the latest version, and ask
  you to redo your change — there's no merge logic, by design (keeps this
  simple).
- Forgetting a passphrase means that item's contents are unrecoverable —
  there's no reset.
