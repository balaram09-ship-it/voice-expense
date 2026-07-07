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
    // Capture order, so queued cash counts land in the sheet chronologically.
    const entries = (await allEntries())
      .sort((a, b) => a.captureTime.localeCompare(b.captureTime));
    for (const e of entries) {
      if (e.state === 'pending') {
        const out = e.type === 'cash'
          ? await post({
              action: 'cash', id: e.id, amount: e.amount, date: e.date,
              shift: e.shift, note: e.note, captureTime: e.captureTime,
            })
          : await post({
              action: 'log', id: e.id, transcript: e.transcript,
              captureTime: e.captureTime, company: e.company,
              quick: e.quick, vendor: e.vendor, amount: e.amount, payment: e.payment,
            });
        if (out.ok) {
          e.state = 'synced';
          if (out.parsed) e.parsed = out.parsed;
          if (out.status) e.status = out.status;
          await putEntry(e);
          if (e.type === 'cash' && out.last) setLastCount(out.last);
        }
      } else if (e.state === 'void_pending') {
        const out = await post({
          action: 'void', id: e.id, company: e.company, entryType: e.type,
        });
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
    renderCash();
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
    // Staff pay these regulars in cash only — the toggle is CEO-only.
    $('quick-payment-row').classList.remove('hidden');
  }

  $('cash-date').value = new Date().toISOString().slice(0, 10);
  setShift(defaultShift());
  updateSyncChip();
  renderToday();
  renderCash();
  refreshLastCount();
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

// Quick add — regulars: the vendor is fixed, so only the amount (and, for
// the CEO device, payment method) is asked for. These upload as
// already-structured data (vendor + amount + rule-based category on the
// server) with no Claude parse involved.
document.querySelectorAll('.payment-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.payment-btn').forEach((b) =>
      b.classList.toggle('active', b === btn));
  });
});

function currentPayment() {
  const active = document.querySelector('.payment-btn.active');
  return active ? active.dataset.payment : 'cash';
}

$('quick-select').addEventListener('change', () => {
  const v = $('quick-select').value;
  if (!v) return;
  $('quick-select').value = '';
  confirmCard.classList.add('hidden');
  $('quick-vendor').textContent = v;
  $('quick-amount').value = '';
  document.querySelectorAll('.payment-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.payment === 'cash'));
  $('quick-card').classList.remove('hidden');
  $('quick-amount').focus();
});

$('quick-discard').addEventListener('click', () => $('quick-card').classList.add('hidden'));

$('quick-save').addEventListener('click', async () => {
  const vendor = $('quick-vendor').textContent;
  const amount = parseFloat($('quick-amount').value.replace(/[,\s₹]/g, ''));
  if (!(amount > 0)) return toast('Enter the amount.');
  const payment = currentPayment();

  const entry = {
    id: crypto.randomUUID(),
    quick: true,
    vendor,
    amount,
    payment,
    transcript: vendor + ' ' + amount + ' ' + payment,
    company: currentCompany(),
    captureTime: new Date().toISOString(),
    state: 'pending',
  };
  await putEntry(entry);
  $('quick-card').classList.add('hidden');
  toast('Saved' + (navigator.onLine ? '' : ' — will sync when online'));
  if (navigator.vibrate) navigator.vibrate(40);
  renderToday();
  syncNow();
});

// ---------------------------------------------------------------------------
// Confirm & save
// ---------------------------------------------------------------------------

function openConfirm(text) {
  $('quick-card').classList.add('hidden');
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

async function undoLast(type, label) {
  const entries = (await allEntries())
    .filter((e) => (e.type === 'cash') === (type === 'cash'))
    .filter((e) => e.state !== 'voided' && e.state !== 'void_pending')
    .sort((a, b) => a.captureTime.localeCompare(b.captureTime));
  const last = entries[entries.length - 1];
  if (!last) return toast('Nothing to undo.');
  if (!confirm('Undo ' + label(last) + '?')) return;
  if (last.state === 'pending') {
    await deleteEntry(last.id);
  } else {
    last.state = 'void_pending';
    await putEntry(last);
    syncNow();
  }
  toast('Entry undone.');
  renderToday();
  renderCash();
}

$('undo-btn').addEventListener('click', () =>
  undoLast('expense', (e) => '"' + e.transcript.slice(0, 60) + '"'));

// ---------------------------------------------------------------------------
// Today list + totals (this device's local log)
// ---------------------------------------------------------------------------

function guessAmount(e) {
  if (typeof e.amount === 'number') return e.amount; // quick + cash entries
  if (e.parsed && typeof e.parsed.amount === 'number') return e.parsed.amount;
  const m = e.transcript.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}

async function renderToday() {
  const today = new Date().toISOString().slice(0, 10);
  const entries = (await allEntries())
    .filter((e) => e.type !== 'cash')
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
// View switch (Expense / Cash)
// ---------------------------------------------------------------------------

document.querySelectorAll('.view-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-btn').forEach((b) =>
      b.classList.toggle('active', b === btn));
    $('view-expense').classList.toggle('hidden', btn.dataset.view !== 'expense');
    $('view-cash').classList.toggle('hidden', btn.dataset.view !== 'cash');
    if (btn.dataset.view === 'cash') {
      if (!$('cash-date').value) $('cash-date').value = new Date().toISOString().slice(0, 10);
      setShift(defaultShift());
      renderCash();
      refreshLastCount();
    }
  });
});

// ---------------------------------------------------------------------------
// Daily cash count
// ---------------------------------------------------------------------------

const LAST_COUNT_KEY = 've-last-count';

// Two shifts a day; default follows the clock (afternoon onward = Evening).
function defaultShift() {
  return new Date().getHours() >= 14 ? 'Evening' : 'Morning';
}

function currentShift() {
  const active = document.querySelector('.shift-btn.active');
  return active ? active.dataset.shift : defaultShift();
}

function setShift(shift) {
  document.querySelectorAll('.shift-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.shift === shift));
  updateCashWarning();
}

document.querySelectorAll('.shift-btn').forEach((btn) => {
  btn.addEventListener('click', () => setShift(btn.dataset.shift));
});

function setLastCount(last) {
  if (last && last.date) localStorage.setItem(LAST_COUNT_KEY, JSON.stringify(last));
  renderLastCount();
}

function getLastCount() {
  try { return JSON.parse(localStorage.getItem(LAST_COUNT_KEY)); } catch (_) { return null; }
}

function renderLastCount() {
  const last = getLastCount();
  const el = $('cash-last');
  if (!last) { el.textContent = 'No previous count on record.'; updateCashWarning(); return; }
  const days = Math.round(
    (new Date(new Date().toISOString().slice(0, 10)) - new Date(last.date)) / 86400000);
  const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago';
  el.textContent = 'Last count: ₹' + Number(last.amount).toLocaleString('en-IN') +
    ' on ' + last.date + (last.shift ? ' ' + last.shift.toLowerCase() : '') +
    ' (' + ago + ')' + (last.device ? ' — ' + last.device : '');
  updateCashWarning();
}

// Ask the server for the latest count across ALL devices; fall back to
// whatever this device last knew when offline.
async function refreshLastCount() {
  if (!config || !navigator.onLine) { renderLastCount(); return; }
  try {
    const out = await post({ action: 'cash_last' });
    if (out.ok && out.last) setLastCount(out.last);
    else renderLastCount();
  } catch (_) { renderLastCount(); }
}

async function updateCashWarning() {
  const el = $('cash-warning');
  const date = $('cash-date').value;
  const shift = currentShift();
  const last = getLastCount();

  // Same date AND same shift is the duplicate case — two shifts a day is normal.
  let dupe = null;
  if (date && last && last.date === date && (last.shift || 'Morning') === shift) dupe = last;
  if (!dupe && date && db) {
    dupe = (await allEntries()).find((e) =>
      e.type === 'cash' && e.date === date && (e.shift || 'Morning') === shift &&
      e.state !== 'voided' && e.state !== 'void_pending');
  }

  if (dupe) {
    el.textContent = 'A ' + shift.toLowerCase() + ' count for this date already exists: ₹' +
      Number(dupe.amount).toLocaleString('en-IN') +
      (dupe.device ? ' (' + dupe.device + ')' : '') + '. Saving adds a second one.';
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

$('cash-date').addEventListener('change', updateCashWarning);

$('cash-save').addEventListener('click', async () => {
  const amount = parseFloat($('cash-amount').value.replace(/[,\s₹]/g, ''));
  const date = $('cash-date').value;
  if (!date) return toast('Pick the count date.');
  if (!(amount > 0)) return toast('Enter the counted amount.');

  const entry = {
    id: crypto.randomUUID(),
    type: 'cash',
    amount,
    date,
    shift: currentShift(),
    note: $('cash-note').value.trim(),
    captureTime: new Date().toISOString(),
    state: 'pending',
  };
  await putEntry(entry);
  $('cash-amount').value = '';
  $('cash-note').value = '';
  setShift(defaultShift());
  toast('Count saved' + (navigator.onLine ? '' : ' — will sync when online'));
  if (navigator.vibrate) navigator.vibrate(40);
  renderCash();
  syncNow();
});

$('cash-undo').addEventListener('click', () =>
  undoLast('cash', (e) => 'count of ₹' + Number(e.amount).toLocaleString('en-IN') + ' for ' + e.date));

async function renderCash() {
  const list = $('cash-list');
  if (!list) return;
  const entries = (await allEntries())
    .filter((e) => e.type === 'cash')
    .sort((a, b) => b.captureTime.localeCompare(a.captureTime))
    .slice(0, 14);

  list.innerHTML = '';
  for (const e of entries) {
    const voided = e.state === 'voided' || e.state === 'void_pending';
    const li = document.createElement('li');
    li.className = 'entry' + (voided ? ' voided' : '');
    const desc = document.createElement('span');
    desc.className = 'entry-desc';
    desc.textContent = e.date + (e.shift ? ' ' + e.shift.toLowerCase() : '') +
      (e.note ? ' — ' + e.note : '');
    const amt = document.createElement('span');
    amt.className = 'entry-amt';
    amt.textContent = '₹' + Number(e.amount).toLocaleString('en-IN');
    const st = document.createElement('span');
    st.className = 'entry-state';
    st.textContent = voided ? 'VOID' : e.state === 'synced' ? '✓' : '…';
    li.append(desc, amt, st);
    list.appendChild(li);
  }
  renderLastCount();
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
// Theme toggle — manual, overrides the system light/dark setting.
// index.html applies any saved choice before first paint to avoid a flash.
// ---------------------------------------------------------------------------

const THEME_KEY = 've-theme';

function effectiveTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function updateThemeIcon() {
  const dark = effectiveTheme() === 'dark';
  $('theme-toggle').querySelector('.icon-sun').classList.toggle('hidden', !dark);
  $('theme-toggle').querySelector('.icon-moon').classList.toggle('hidden', dark);
}

$('theme-toggle').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  document.documentElement.setAttribute('data-theme', next);
  updateThemeIcon();
});

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
  updateThemeIcon();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
  if (config && config.role) showMain();
  else setupScreen.classList.remove('hidden');
})();
