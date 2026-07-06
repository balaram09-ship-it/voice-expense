/* Voice Expense — offline-first PWA client.
 *
 * Entries are written to IndexedDB immediately and pushed to the Apps Script
 * backend whenever connectivity allows. The server dedupes on entry ID, so
 * retries are always safe.
 */

'use strict';

// ---------------------------------------------------------------------------
// Config (localStorage) — set once at registration
// ---------------------------------------------------------------------------

const CFG_KEY = 've-config';

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)); } catch (_) { return null; }
}
function saveConfig(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

let config = loadConfig(); // {url, device, pin, role, companies}

// ---------------------------------------------------------------------------
// IndexedDB queue
// ---------------------------------------------------------------------------

const DB_NAME = 'voice-expense';
const STORE = 'entries';
let db;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const putEntry = (e) => tx('readwrite', (s) => s.put(e));
const deleteEntry = (id) => tx('readwrite', (s) => s.delete(id));

function allEntries() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Server calls — text/plain body avoids the CORS preflight Apps Script
// cannot answer.
// ---------------------------------------------------------------------------

async function post(body) {
  const resp = await fetch(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ pin: config.pin, device: config.device }, body)),
  });
  if (!resp.ok) throw new Error('http_' + resp.status);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Sync loop
// ---------------------------------------------------------------------------

let syncing = false;

async function syncNow() {
  if (syncing || !config || !navigator.onLine) { updateSyncChip(); return; }
  syncing = true;
  updateSyncChip('Syncing…');
  try {
    const entries = await allEntries();
    for (const e of entries) {
      if (e.state === 'pending') {
        const out = await post({
          action: 'log', id: e.id, transcript: e.transcript,
          captureTime: e.captureTime, company: e.company,
        });
        if (out.ok) {
          e.state = 'synced';
          if (out.parsed) e.parsed = out.parsed;
          if (out.status) e.status = out.status;
          await putEntry(e);
        }
      } else if (e.state === 'void_pending') {
        const out = await post({ action: 'void', id: e.id });
        if (out.ok || out.error === 'not_found') {
          e.state = 'voided';
          await putEntry(e);
        }
      }
    }
  } catch (_) {
    /* offline or server hiccup — entries stay queued, next pass retries */
  } finally {
    syncing = false;
    updateSyncChip();
    renderToday();
  }
}

window.addEventListener('online', syncNow);
setInterval(syncNow, 30000);

// ---------------------------------------------------------------------------
// UI references
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const setupScreen = $('setup-screen');
const mainScreen = $('main-screen');
const micBtn = $('mic-btn');
const micHint = $('mic-hint');
const confirmCard = $('confirm-card');
const transcriptBox = $('transcript-box');
const companySelect = $('company-select');

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

$('setup-go').addEventListener('click', async () => {
  const url = $('setup-url').value.trim();
  const device = $('setup-device').value.trim();
  const pin = $('setup-pin').value.trim();
  const errEl = $('setup-error');
  errEl.classList.add('hidden');
  if (!url || !device || !pin) return showSetupError('All three fields are required.');

  $('setup-go').textContent = 'Checking…';
  try {
    config = { url, device, pin };
    const out = await post({ action: 'register' });
    if (!out.ok) throw new Error(out.error);
    config.role = out.role;
    config.companies = out.companies;
    saveConfig(config);
    showMain();
  } catch (err) {
    config = null;
    showSetupError(err.message === 'bad_pin' ? 'Wrong PIN.' : 'Could not reach the server. Check the URL and try again.');
  } finally {
    $('setup-go').textContent = 'Register';
  }
});

function showSetupError(msg) {
  const el = $('setup-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

function showMain() {
  setupScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  $('device-label').textContent = config.device;

  if (config.role === 'ceo') {
    $('company-row').classList.remove('hidden');
    companySelect.innerHTML = '';
    for (const c of config.companies) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      companySelect.appendChild(opt);
    }
    companySelect.value = 'Seven Grain Bakery';
  }

  updateSyncChip();
  renderToday();
  syncNow();
}

function currentCompany() {
  return config.role === 'ceo' ? companySelect.value : 'Seven Grain Bakery';
}

// ---------------------------------------------------------------------------
// Speech capture
// ---------------------------------------------------------------------------

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recording = false;
let lang = 'en-IN';

document.querySelectorAll('.lang-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.lang-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    lang = btn.dataset.lang;
  });
});

micBtn.addEventListener('click', () => {
  if (recording) { recognition.stop(); return; }
  if (!SpeechRec) {
    toast('Speech recognition not available — type instead.');
    openConfirm('');
    return;
  }
  recognition = new SpeechRec();
  recognition.lang = lang;
  recognition.interimResults = true;
  recognition.continuous = false;

  let finalText = '';
  recognition.onresult = (ev) => {
    let interim = '';
    for (const r of ev.results) {
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    micHint.textContent = (finalText + ' ' + interim).trim() || 'Listening…';
  };
  recognition.onerror = (ev) => {
    stopRecordingUI();
    if (ev.error === 'no-speech') toast('Heard nothing — try again.');
    else if (ev.error === 'not-allowed') toast('Microphone permission is blocked.');
    else toast('Mic error — you can type instead.');
  };
  recognition.onend = () => {
    stopRecordingUI();
    if (finalText.trim()) openConfirm(finalText.trim());
  };

  recording = true;
  micBtn.classList.add('recording');
  micHint.textContent = 'Listening…';
  recognition.start();
});

function stopRecordingUI() {
  recording = false;
  micBtn.classList.remove('recording');
  micHint.textContent = 'Tap and speak';
}

$('type-btn').addEventListener('click', () => openConfirm(''));

// ---------------------------------------------------------------------------
// Confirm & save
// ---------------------------------------------------------------------------

function openConfirm(text) {
  transcriptBox.value = text;
  confirmCard.classList.remove('hidden');
  if (!text) transcriptBox.focus();
}

$('discard-btn').addEventListener('click', () => {
  transcriptBox.value = '';
  confirmCard.classList.add('hidden');
});

$('save-btn').addEventListener('click', async () => {
  const text = transcriptBox.value.trim();
  if (!text) return;
  const entry = {
    id: crypto.randomUUID(),
    transcript: text,
    company: currentCompany(),
    captureTime: new Date().toISOString(),
    state: 'pending',
  };
  await putEntry(entry);
  transcriptBox.value = '';
  confirmCard.classList.add('hidden');
  toast('Saved' + (navigator.onLine ? '' : ' — will sync when online'));
  if (navigator.vibrate) navigator.vibrate(40);
  renderToday();
  syncNow();
});

// ---------------------------------------------------------------------------
// Undo last
// ---------------------------------------------------------------------------

$('undo-btn').addEventListener('click', async () => {
  const entries = (await allEntries())
    .filter((e) => e.state !== 'voided' && e.state !== 'void_pending')
    .sort((a, b) => a.captureTime.localeCompare(b.captureTime));
  const last = entries[entries.length - 1];
  if (!last) return toast('Nothing to undo.');
  if (!confirm('Undo: "' + last.transcript.slice(0, 60) + '"?')) return;
  if (last.state === 'pending') {
    await deleteEntry(last.id);
  } else {
    last.state = 'void_pending';
    await putEntry(last);
    syncNow();
  }
  toast('Entry undone.');
  renderToday();
});

// ---------------------------------------------------------------------------
// Today list + totals (this device's local log)
// ---------------------------------------------------------------------------

function guessAmount(e) {
  if (e.parsed && typeof e.parsed.amount === 'number') return e.parsed.amount;
  const m = e.transcript.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

async function renderToday() {
  const today = new Date().toISOString().slice(0, 10);
  const entries = (await allEntries())
    .filter((e) => e.captureTime.slice(0, 10) === today)
    .sort((a, b) => b.captureTime.localeCompare(a.captureTime));

  const list = $('entry-list');
  list.innerHTML = '';
  let total = 0;

  for (const e of entries) {
    const voided = e.state === 'voided' || e.state === 'void_pending';
    if (!voided) total += guessAmount(e);

    const li = document.createElement('li');
    li.className = 'entry' + (voided ? ' voided' : '');
    const desc = document.createElement('span');
    desc.className = 'entry-desc';
    desc.textContent = (e.parsed && e.parsed.description) || e.transcript;
    const amt = document.createElement('span');
    amt.className = 'entry-amt';
    amt.textContent = '₹' + guessAmount(e).toLocaleString('en-IN');
    const st = document.createElement('span');
    st.className = 'entry-state';
    st.textContent = voided ? 'VOID' : e.state === 'synced' ? '✓' : '…';
    li.append(desc, amt, st);
    list.appendChild(li);
  }
  $('today-total').textContent = '₹' + total.toLocaleString('en-IN');
  updateSyncChip();
}

// ---------------------------------------------------------------------------
// Sync chip
// ---------------------------------------------------------------------------

async function updateSyncChip(label) {
  const pending = db
    ? (await allEntries()).filter((e) => e.state === 'pending' || e.state === 'void_pending').length
    : 0;
  $('sync-dot').className = 'dot' + (navigator.onLine && !pending ? ' on' : '');
  $('sync-text').textContent = label ||
    (pending ? pending + ' pending' : navigator.onLine ? 'Synced' : 'Offline');
}

$('sync-chip').addEventListener('click', syncNow);

// ---------------------------------------------------------------------------
// Toast + boot
// ---------------------------------------------------------------------------

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

(async function boot() {
  db = await openDb();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  if (config && config.role) showMain();
  else setupScreen.classList.remove('hidden');
})();
