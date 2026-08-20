/* SecureClip — personal clipboard vault synced via the GitHub Contents API. */

// ---------- tiny helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
const nowIso = () => new Date().toISOString();
const esc = (s) => (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), 1800);
}

async function copyText(str) {
  try {
    await navigator.clipboard.writeText(str);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  toast("Copied");
}

// ---------- settings ----------
const SETTINGS_KEY = "secureclip_settings";
function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || null; } catch { return null; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
function settingsComplete(s) { return !!(s && s.token && s.owner && s.repo && s.path); }

// ---------- crypto (AES-GCM, PBKDF2-derived key; only used for entries you lock) ----------
function bytesToB64(bytes) { let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); }
function b64ToBytes(b64) { const bin = atob(b64); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); }
function utf8ToB64(str) { return bytesToB64(new TextEncoder().encode(str)); }
function b64ToUtf8(b64) { return new TextDecoder().decode(b64ToBytes(b64.replace(/\s/g, ""))); }
function utf8ToB64Url(str) { return utf8ToB64(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64UrlToUtf8(str) {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return b64ToUtf8(b64);
}

async function deriveKey(passphrase, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 150000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(text, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return { salt: bytesToB64(salt), iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
}

async function decryptText(enc, passphrase) {
  const salt = b64ToBytes(enc.salt);
  const iv = b64ToBytes(enc.iv);
  const key = await deriveKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, b64ToBytes(enc.ct));
  return new TextDecoder().decode(pt);
}

// ---------- GitHub Contents API ----------
function ghHeaders(s) {
  return { Authorization: `token ${s.token}`, Accept: "application/vnd.github+json" };
}
function ghPathEncoded(path) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
function ghUrl(s) {
  return `https://api.github.com/repos/${s.owner}/${s.repo}/contents/${ghPathEncoded(s.path)}`;
}

async function ghGetFile() {
  const s = getSettings();
  const res = await fetch(`${ghUrl(s)}?ref=${encodeURIComponent(s.branch || "main")}&_=${Date.now()}`, {
    headers: ghHeaders(s),
    cache: "no-store",
  });
  if (res.status === 404) return { entries: [], sha: null };
  if (res.status === 401 || res.status === 403) throw new Error("Check your GitHub token / repo access");
  if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
  const data = await res.json();
  let entries = [];
  try { entries = JSON.parse(b64ToUtf8(data.content)); } catch { entries = []; }
  return { entries, sha: data.sha };
}

async function ghSaveFile(entries, sha, message) {
  const s = getSettings();
  const body = {
    message: message || `SecureClip update — ${nowIso()}`,
    content: utf8ToB64(JSON.stringify(entries, null, 2)),
    branch: s.branch || "main",
  };
  if (sha) body.sha = sha;
  const res = await fetch(ghUrl(s), {
    method: "PUT",
    headers: { ...ghHeaders(s), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409) throw new Error("CONFLICT");
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`GitHub PUT ${res.status} ${t}`); }
  return res.json();
}

// ---------- state ----------
const state = {
  entries: [],
  sha: null,
  unlockedText: {},   // id -> decrypted plaintext, session-only (never persisted)
  sessionPass: {},    // id -> passphrase used to unlock, session-only
  defaultPass: null,  // optional shared passphrase, session-only, never saved or synced
};
const ui = {
  openId: null,
  unlockError: {},
  modal: null, // {mode:'settings'} | {mode:'editor', entry|null}
};

function getEntry(id) { return state.entries.find((e) => e.id === id); }

// ---------- sync ----------
function setSyncState(text) { $("#syncState").textContent = text; }

async function loadFromGithub(showToastOnFail = true) {
  const s = getSettings();
  if (!settingsComplete(s)) { render(); return; }
  const btn = $("#btnRefresh");
  btn.classList.add("spinning");
  setSyncState("syncing…");
  try {
    const { entries, sha } = await ghGetFile();
    state.entries = entries;
    state.sha = sha;
    setSyncState("synced " + new Date().toLocaleTimeString());
  } catch (e) {
    setSyncState("offline / error");
    if (showToastOnFail) toast(e.message || "Sync failed");
  } finally {
    btn.classList.remove("spinning");
    render();
  }
}

async function persist(message) {
  setSyncState("saving…");
  try {
    const res = await ghSaveFile(state.entries, state.sha, message);
    state.sha = res.content.sha;
    setSyncState("synced " + new Date().toLocaleTimeString());
  } catch (e) {
    if (e.message === "CONFLICT") {
      toast("Data changed elsewhere — reloaded latest, please retry");
      await loadFromGithub();
      return;
    }
    toast("Save failed: " + e.message);
    setSyncState("error");
  }
  render();
}

// ---------- actions ----------
async function openCard(id) {
  const opening = ui.openId !== id;
  ui.openId = opening ? id : null;
  render();
  if (opening) {
    const entry = getEntry(id);
    if (entry && entry.locked && !(id in state.unlockedText) && state.defaultPass) {
      await handleUnlock(id, state.defaultPass, true); // try the default silently, no error shown if it's not this item's passphrase
    }
  }
}

async function handleUnlock(id, passphrase, silent = false) {
  const entry = getEntry(id);
  try {
    const text = await decryptText(entry.encrypted, passphrase);
    state.unlockedText[id] = text;
    state.sessionPass[id] = passphrase;
    ui.unlockError[id] = null;
  } catch {
    if (!silent) ui.unlockError[id] = "Wrong passphrase";
  }
  render();
}

function relock(id) {
  delete state.unlockedText[id];
  delete state.sessionPass[id];
  render();
}

function requestEdit(id) {
  const entry = getEntry(id);
  if (entry.locked && !(id in state.unlockedText)) {
    ui.openId = id;
    toast("Unlock this entry first to edit it");
    render();
    return;
  }
  openEditor(entry);
}

async function deleteEntry(id) {
  const entry = getEntry(id);
  if (!confirm(`Delete "${entry.title}"? This can't be undone.`)) return;
  state.entries = state.entries.filter((e) => e.id !== id);
  delete state.unlockedText[id];
  delete state.sessionPass[id];
  if (ui.openId === id) ui.openId = null;
  await persist(`Delete "${entry.title}"`);
}

// ---------- rendering ----------
function render() {
  const s = getSettings();
  const list = $("#list");

  if (!settingsComplete(s)) {
    list.innerHTML = `
      <div class="setup-nudge">
        Connect a GitHub repo to start syncing.
        <div><button class="btn accent" id="nudgeSettings">Open settings</button></div>
      </div>`;
    $("#nudgeSettings").onclick = () => openSettings();
    return;
  }

  if (state.entries.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="big">🗒️</div>Nothing saved yet.<br>Tap ＋ to add your first item.</div>`;
    return;
  }

  const sorted = [...state.entries].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  list.innerHTML = sorted.map(cardHtml).join("");

  sorted.forEach((entry) => {
    const head = list.querySelector(`.card[data-id="${entry.id}"] .card-head`);
    if (head) head.onclick = () => openCard(entry.id);

    if (ui.openId === entry.id) {
      const unlockForm = list.querySelector(`.card[data-id="${entry.id}"] .unlock-form`);
      if (unlockForm) {
        unlockForm.onsubmit = (e) => {
          e.preventDefault();
          handleUnlock(entry.id, $("input[name=pass]", unlockForm).value);
        };
      }
      const body = list.querySelector(`.card[data-id="${entry.id}"] .card-body`);
      if (body && !unlockForm) {
        body.querySelectorAll(".line-row").forEach((row) => {
          row.onclick = () => copyText(row.dataset.full);
        });
        const copyAll = $(".btn-copy-all", body);
        if (copyAll) copyAll.onclick = () => copyText(getEntryText(entry));
        const editBtn = $(".btn-edit", body);
        if (editBtn) editBtn.onclick = () => requestEdit(entry.id);
        const delBtn = $(".btn-delete", body);
        if (delBtn) delBtn.onclick = () => deleteEntry(entry.id);
        const relockBtn = $(".btn-relock", body);
        if (relockBtn) relockBtn.onclick = () => relock(entry.id);
      }
    }
  });
}

function getEntryText(entry) {
  if (entry.locked) return state.unlockedText[entry.id] ?? "";
  return entry.text ?? "";
}

function cardHtml(entry) {
  const isOpen = ui.openId === entry.id;
  const locked = !!entry.locked;
  const isUnlocked = locked && entry.id in state.unlockedText;
  const previewText = locked && !isUnlocked ? "🔒 tap to unlock" : (getEntryText(entry).split("\n")[0] || "(empty)");

  return `
    <div class="card ${isOpen ? "open" : ""}" data-id="${entry.id}">
      <div class="card-head">
        ${locked ? '<span class="lock-badge">🔒</span>' : ""}
        <div style="flex:1;min-width:0">
          <span class="title">${esc(entry.title || "Untitled")}</span>
          <span class="preview">${esc(previewText)}</span>
        </div>
        <span class="chev">›</span>
      </div>
      ${isOpen ? `<div class="card-body">${locked && !isUnlocked ? unlockHtml(entry) : bodyHtml(entry)}</div>` : ""}
    </div>`;
}

function unlockHtml(entry) {
  const err = ui.unlockError[entry.id];
  const prefill = state.defaultPass || "";
  return `
    <form class="unlock-form">
      <div class="unlock-row">
        <input type="password" name="pass" placeholder="Passphrase" autocomplete="off" value="${esc(prefill)}" ${prefill ? "" : "autofocus"}>
        <button type="submit" class="btn accent">Unlock</button>
      </div>
      ${err ? `<div class="err-text">${esc(err)}</div>` : ""}
    </form>`;
}

function bodyHtml(entry) {
  const text = getEntryText(entry);
  const lines = text.split("\n");
  const lineRows = lines
    .map((line) => {
      if (line.trim() === "") return "";
      return `<div class="line-row" data-full="${esc(line)}"><span class="txt">${esc(line)}</span><span class="copy-ico">⧉</span></div>`;
    })
    .join("");

  return `
    <div class="lines">${lineRows || '<div class="line-row" data-full=""><span class="txt" style="color:var(--text-dim)">(empty)</span></div>'}</div>
    <div class="actions-row">
      <button class="btn accent btn-copy-all">⧉ Copy all</button>
      <button class="btn btn-edit">✎ Edit</button>
      ${entry.locked ? '<button class="btn ghost btn-relock">🔒 Lock again</button>' : ""}
      <button class="btn danger btn-delete">Delete</button>
    </div>
    <div class="meta-row">updated ${new Date(entry.updatedAt).toLocaleString()}</div>`;
}

// ---------- editor modal (add / edit) ----------
function openEditor(entry) {
  ui.modal = { mode: "editor", entry: entry || null };
  renderModal();
}

function renderEditorModal() {
  const entry = ui.modal.entry;
  const isNew = !entry;
  const title = entry ? entry.title : "";
  const text = entry ? getEntryText(entry) : "";
  const locked = entry ? !!entry.locked : false;
  const cachedPass = entry ? state.sessionPass[entry.id] : null;

  return `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <h2>${isNew ? "Add item" : "Edit item"}</h2>
        <div class="editor">
          <input type="text" class="title-input" id="edTitle" placeholder="Title (e.g. Bank login)" value="${esc(title)}">
          <textarea id="edText" placeholder="username&#10;password&#10;anything else…">${esc(text)}</textarea>
          <label class="lock-toggle">
            <input type="checkbox" id="edLock" ${locked ? "checked" : ""}>
            🔒 Lock this item with a passphrase
          </label>
          <div id="passFields"></div>
          <div class="err-text" id="edErr" style="display:none"></div>
        </div>
        <div class="sheet-actions">
          <button class="btn ghost" id="edCancel">Cancel</button>
          <button class="btn accent" id="edSave">Save</button>
        </div>
      </div>
    </div>`;

  // (passFields populated by renderPassFields, called after mount)
}

function renderPassFields() {
  const container = $("#passFields");
  const entry = ui.modal.entry;
  const cachedPass = entry ? state.sessionPass[entry.id] : null;
  const prefill = cachedPass || state.defaultPass || "";
  const locked = $("#edLock").checked;
  if (!locked) { container.innerHTML = ""; return; }

  if (prefill) {
    container.innerHTML = `
      <div class="field pass-field">
        <label>Passphrase ${cachedPass ? "(change to rotate it)" : "(from your default — edit to use a different one for just this item)"}</label>
        <input type="password" id="edPass" value="${esc(prefill)}" autocomplete="off">
      </div>`;
  } else {
    container.innerHTML = `
      <div class="field pass-field">
        <label>Set a passphrase</label>
        <input type="password" id="edPass" autocomplete="off">
      </div>
      <div class="field pass-field">
        <label>Confirm passphrase</label>
        <input type="password" id="edPassConfirm" autocomplete="off">
      </div>`;
  }
}

async function handleEditorSave() {
  const entry = ui.modal.entry;
  const title = $("#edTitle").value.trim() || "Untitled";
  const text = $("#edText").value;
  const locked = $("#edLock").checked;
  const errEl = $("#edErr");
  errEl.style.display = "none";

  const record = entry ? { ...entry } : { id: uid(), createdAt: nowIso() };
  record.title = title;
  record.updatedAt = nowIso();

  if (locked) {
    const passInput = $("#edPass");
    const pass = passInput ? passInput.value : "";
    const confirmInput = $("#edPassConfirm");
    if (confirmInput) {
      if (!pass) { errEl.textContent = "Enter a passphrase."; errEl.style.display = "block"; return; }
      if (pass !== confirmInput.value) { errEl.textContent = "Passphrases don't match."; errEl.style.display = "block"; return; }
    } else if (!pass) {
      errEl.textContent = "Passphrase required to keep this item locked.";
      errEl.style.display = "block";
      return;
    }
    record.encrypted = await encryptText(text, pass);
    record.locked = true;
    delete record.text;
    state.sessionPass[record.id] = pass;
    state.unlockedText[record.id] = text;
  } else {
    record.text = text;
    record.locked = false;
    delete record.encrypted;
    delete state.sessionPass[record.id];
    delete state.unlockedText[record.id];
  }

  const idx = state.entries.findIndex((e) => e.id === record.id);
  if (idx >= 0) state.entries[idx] = record; else state.entries.unshift(record);

  closeModal();
  ui.openId = record.id;
  await persist(`${entry ? "Update" : "Add"} "${title}"`);
}

// ---------- settings modal ----------
function openSettings() { ui.modal = { mode: "settings" }; renderModal(); }

function renderSettingsModal() {
  const s = getSettings() || {};
  return `
    <div class="overlay" id="overlay">
      <div class="sheet">
        <h2>GitHub sync settings</h2>
        <div class="field">
          <label>Personal access token</label>
          <input type="password" id="stToken" value="${esc(s.token || "")}" autocomplete="off" placeholder="ghp_… (fine-grained, contents read/write)">
        </div>
        <div class="field">
          <label>Repo owner</label>
          <input type="text" id="stOwner" value="${esc(s.owner || "")}" placeholder="your-username">
        </div>
        <div class="field">
          <label>Repo name</label>
          <input type="text" id="stRepo" value="${esc(s.repo || "")}" placeholder="secureclip-data">
        </div>
        <div class="field">
          <label>File path</label>
          <input type="text" id="stPath" value="${esc(s.path || "secureclip-data.json")}">
        </div>
        <div class="field">
          <label>Branch</label>
          <input type="text" id="stBranch" value="${esc(s.branch || "main")}">
          <div class="hint">Use a <strong>private</strong> repo — only locked items are encrypted; unlocked items are stored as plain text in the file.</div>
        </div>
        <div class="err-text" id="stErr" style="display:none"></div>
        <div class="sheet-actions">
          <button class="btn ghost" id="stCancel">Cancel</button>
          <button class="btn accent" id="stSave">Save & connect</button>
        </div>

        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">

        <h2>Default passphrase</h2>
        <div class="field">
          <label>Used to auto-unlock locked items and pre-fill new locks</label>
          <input type="password" id="stDefaultPass" value="${esc(state.defaultPass || "")}" autocomplete="off" placeholder="Leave blank to keep using separate passphrases">
          <div class="hint">Kept in memory for this session only — never saved to this device or synced to GitHub. Any item can still use its own different passphrase.</div>
        </div>
        <div class="sheet-actions" style="justify-content:flex-start">
          <button class="btn ghost" id="stClearDefault">Clear</button>
        </div>

        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0">

        <h2>Connect a new device</h2>
        <div class="hint" style="margin-bottom:10px">Generates a one-time link containing these settings (including your token). Open it once on the other device, or scan the QR — it's removed from the address bar automatically after import. Treat it like a password: only share it over a channel you trust.</div>
        <div class="sheet-actions" style="justify-content:flex-start">
          <button class="btn" id="stCopyLink">🔗 Copy setup link</button>
          <button class="btn" id="stShowQr">▦ Show QR code</button>
        </div>
        <div id="qrBox" style="margin-top:12px;display:flex;justify-content:center"></div>
      </div>
    </div>`;
}

let qrLibLoading = null;
function loadQrLib() {
  if (window.QRCode) return Promise.resolve();
  if (qrLibLoading) return qrLibLoading;
  qrLibLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js";
    script.onload = resolve;
    script.onerror = () => { qrLibLoading = null; reject(new Error("load failed")); };
    document.head.appendChild(script);
  });
  return qrLibLoading;
}

function buildSetupUrl() {
  const s = getSettings();
  if (!settingsComplete(s)) { toast("Save settings first"); return null; }
  const payload = utf8ToB64Url(JSON.stringify(s));
  return `${location.origin}${location.pathname}#setup=${payload}`;
}

async function copySetupLink() {
  const url = buildSetupUrl();
  if (url) await copyText(url);
}

async function showSetupQr() {
  const url = buildSetupUrl();
  if (!url) return;
  const box = $("#qrBox");
  box.textContent = "Loading…";
  try {
    await loadQrLib();
    box.innerHTML = "";
    new QRCode(box, { text: url, width: 200, height: 200, colorDark: "#0d0f13", colorLight: "#e6e8ec" });
  } catch {
    box.textContent = "Couldn't load the QR generator — check your connection.";
  }
}

function tryImportSetupFromHash() {
  const m = location.hash.match(/^#setup=(.+)$/);
  if (!m) return;
  try {
    const s = JSON.parse(b64UrlToUtf8(m[1]));
    if (s && s.token && s.owner && s.repo) {
      if (confirm(`Connect this device to ${s.owner}/${s.repo} on GitHub?`)) {
        saveSettings({
          token: s.token, owner: s.owner, repo: s.repo,
          path: s.path || "secureclip-data.json", branch: s.branch || "main",
        });
        toast("Connected");
      }
    }
  } catch { /* malformed link, ignore */ }
  history.replaceState(null, "", location.pathname + location.search);
}

async function handleSettingsSave() {
  const s = {
    token: $("#stToken").value.trim(),
    owner: $("#stOwner").value.trim(),
    repo: $("#stRepo").value.trim(),
    path: $("#stPath").value.trim() || "secureclip-data.json",
    branch: $("#stBranch").value.trim() || "main",
  };
  const errEl = $("#stErr");
  if (!s.token || !s.owner || !s.repo) {
    errEl.textContent = "Token, owner, and repo are required.";
    errEl.style.display = "block";
    return;
  }
  saveSettings(s);
  closeModal();
  await loadFromGithub();
}

// ---------- modal plumbing ----------
function renderModal() {
  const root = $("#modalRoot");
  if (!ui.modal) { root.innerHTML = ""; return; }

  if (ui.modal.mode === "settings") {
    root.innerHTML = renderSettingsModal();
    $("#overlay").addEventListener("mousedown", (e) => { if (e.target.id === "overlay") closeModal(); });
    $("#stCancel").onclick = closeModal;
    $("#stSave").onclick = handleSettingsSave;
    $("#stDefaultPass").oninput = (e) => { state.defaultPass = e.target.value || null; };
    $("#stClearDefault").onclick = () => { state.defaultPass = null; $("#stDefaultPass").value = ""; toast("Default cleared"); };
    $("#stCopyLink").onclick = copySetupLink;
    $("#stShowQr").onclick = showSetupQr;
  } else if (ui.modal.mode === "editor") {
    root.innerHTML = renderEditorModal();
    $("#overlay").addEventListener("mousedown", (e) => { if (e.target.id === "overlay") closeModal(); });
    $("#edCancel").onclick = closeModal;
    $("#edSave").onclick = handleEditorSave;
    $("#edLock").onchange = renderPassFields;
    renderPassFields();
    $("#edTitle").focus();
  }
}

function closeModal() { ui.modal = null; $("#modalRoot").innerHTML = ""; }

// ---------- wire up top bar ----------
$("#btnAdd").onclick = () => openEditor(null);
$("#btnSettings").onclick = () => openSettings();
$("#btnRefresh").onclick = () => loadFromGithub();

// ---------- boot ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

tryImportSetupFromHash();
loadFromGithub();

// gentle auto-refresh while the tab is visible and no modal is open (keeps devices in sync)
setInterval(() => {
  if (document.visibilityState === "visible" && !ui.modal) loadFromGithub(false);
}, 20000);
