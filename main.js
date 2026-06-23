const { app, BrowserWindow, ipcMain, dialog, screen, Tray, Menu, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');

// ── Storage ───────────────────────────────────────────────────────────────────
// One JSON file per day in userData/days/. categories.json for category list.
// No database, no WASM, no locking.

let DAYS_DIR, CATS_FILE;

function initPaths() {
  DAYS_DIR  = path.join(app.getPath('userData'), 'days');
  CATS_FILE = path.join(app.getPath('userData'), 'categories.json');
  if (!fs.existsSync(DAYS_DIR)) fs.mkdirSync(DAYS_DIR, { recursive: true });
}

function readDay(date) {
  try { return JSON.parse(fs.readFileSync(path.join(DAYS_DIR, `${date}.json`), 'utf8')); }
  catch { return {}; }
}

function writeDay(date, data) {
  // Strip empty slots before writing
  const clean = {};
  for (const [slot, sides] of Object.entries(data)) {
    const s = {};
    for (const [side, val] of Object.entries(sides)) {
      if (val && (val.cat !== 'none' || val.text)) s[side] = val;
    }
    if (Object.keys(s).length) clean[slot] = s;
  }
  const file = path.join(DAYS_DIR, `${date}.json`);
  if (Object.keys(clean).length) {
    // ponytail: atomic write via rename — safe on NTFS
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean), 'utf8');
    fs.renameSync(tmp, file);
  } else {
    try { fs.unlinkSync(file); } catch {}
  }
}

function loadRange(from, to) {
  const result = {};
  try {
    for (const file of fs.readdirSync(DAYS_DIR).sort()) {
      if (!file.endsWith('.json')) continue;
      const date = file.slice(0, -5);
      if (date >= from && date <= to) {
        try { result[date] = JSON.parse(fs.readFileSync(path.join(DAYS_DIR, file), 'utf8')); }
        catch {}
      }
    }
  } catch {}
  return result;
}

const DEFAULT_CATS = [
  { id: 'none',     label: 'None',        color: '#2e3350' },
  { id: 'deep',     label: 'Deep Work',   color: '#3b82f6' },
  { id: 'meetings', label: 'Meetings',    color: '#a855f7' },
  { id: 'admin',    label: 'Admin',       color: '#f97316' },
  { id: 'break',    label: 'Break',       color: '#22c55e' },
  { id: 'personal', label: 'Personal',    color: '#06b6d4' },
  { id: 'exercise', label: 'Exercise',    color: '#ef4444' },
  { id: 'learning', label: 'Learning',    color: '#eab308' },
  { id: 'quoting',  label: 'Quoting',     color: '#0d9488' },
  { id: 'wasted',   label: 'Wasted Time', color: '#991b1b' },
  { id: 'other',    label: 'Other',       color: '#6b7280' },
];

function readCategories() {
  try { return JSON.parse(fs.readFileSync(CATS_FILE, 'utf8')); }
  catch { return DEFAULT_CATS; }
}

function writeCategories(cats) {
  fs.writeFileSync(CATS_FILE, JSON.stringify(cats), 'utf8');
}

// ── Migration from SQLite (v1.1/v1.2) ────────────────────────────────────────
// Runs once on first launch after upgrade. Safe to remove after v1.4.0.
function migrateFromSqlite() {
  const dbPath = path.join(app.getPath('userData'), 'timesheet.db');
  if (!fs.existsSync(dbPath) || fs.existsSync(CATS_FILE)) return;
  try {
    const { Database } = require('node-sqlite3-wasm');
    const db = new Database(dbPath);

    const cats = db.prepare('SELECT id, label, color FROM categories ORDER BY sort_order').all();
    if (cats.length) writeCategories(cats);

    const slots = db.prepare('SELECT date, slot_key, side, cat, text FROM slots').all();
    const byDate = {};
    for (const r of slots) {
      if (!byDate[r.date]) byDate[r.date] = {};
      if (!byDate[r.date][r.slot_key]) byDate[r.date][r.slot_key] = {};
      byDate[r.date][r.slot_key][r.side] = { cat: r.cat, text: r.text };
    }
    for (const [date, data] of Object.entries(byDate)) writeDay(date, data);

    db.close();
    fs.renameSync(dbPath, dbPath + '.migrated');
  } catch {} // silently skip — user starts fresh if migration fails
}

// ── Windows ───────────────────────────────────────────────────────────────────

let mainWin = null, reminderWin = null, tray = null, isQuitting = false;

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Timesheet');
  tray.on('click', () => {
    if (mainWin) { mainWin.show(); mainWin.focus(); }
    else createMain();
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Timesheet', click: () => { if (mainWin) { mainWin.show(); mainWin.focus(); } else createMain(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createMain() {
  mainWin = new BrowserWindow({
    width: 1200, height: 900, minWidth: 800, minHeight: 600,
    title: 'Timesheet', backgroundColor: '#0f1117',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWin.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
}

function createReminder(slotKey, slotLabel, plannedData) {
  if (reminderWin) { reminderWin.focus(); return; }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const W = 360, H = 220;
  reminderWin = new BrowserWindow({
    width: W, height: H, x: sw - W - 16, y: sh - H - 16,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#1a1d27',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  reminderWin.loadFile(path.join(__dirname, 'src', 'reminder.html'));
  reminderWin.on('closed', () => { reminderWin = null; });
  reminderWin.webContents.once('did-finish-load', () => {
    reminderWin.webContents.send('reminderData', { slotKey, slotLabel, plannedData });
  });
  setTimeout(() => { if (reminderWin) reminderWin.close(); }, 2 * 60 * 1000);
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('loadDay',        (_, date)       => readDay(date));
ipcMain.handle('loadRange',      (_, from, to)   => loadRange(from, to));
ipcMain.handle('saveDay',        (_, date, data) => writeDay(date, data));
ipcMain.handle('loadCategories', ()              => readCategories());
ipcMain.handle('saveCategories', (_, cats)       => writeCategories(cats));

ipcMain.handle('exportData', async (_, from, to) => {
  const { filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Export CSV',
    defaultPath: `timesheet_${from}_to_${to}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!filePath) return { cancelled: true };
  const esc   = s => `"${(s||'').replace(/"/g,'""')}"`;
  const lines = ['Date,Time,Side,Category,Text'];
  for (const [date, dayData] of Object.entries(loadRange(from, to)).sort()) {
    for (const [slot_key, sides] of Object.entries(dayData)) {
      for (const [side, val] of Object.entries(sides)) {
        lines.push([date, slot_key, side, val.cat, esc(val.text)].join(','));
      }
    }
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return { filePath };
});

ipcMain.handle('exportJson', async (_, from, to) => {
  const { filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Export JSON',
    defaultPath: `timesheet_${from}_to_${to}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return { cancelled: true };
  fs.writeFileSync(filePath, JSON.stringify(loadRange(from, to), null, 2), 'utf8');
  return { filePath };
});

ipcMain.handle('submitReminder', (_, slotKey, cat, text) => {
  const today = todayString();
  const data  = readDay(today);
  if (!data[slotKey]) data[slotKey] = {};
  data[slotKey].actual = { cat: cat || 'none', text: text || '' };
  writeDay(today, data);
  if (mainWin) mainWin.webContents.send('refreshDay');
  if (reminderWin) reminderWin.close();
});

ipcMain.handle('dismissReminder', () => { if (reminderWin) reminderWin.close(); });

// ── Reminders ─────────────────────────────────────────────────────────────────

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function msUntilNextQuarter() {
  const now    = new Date();
  const msIntoQ = ((now.getMinutes() % 15) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  return 15 * 60 * 1000 - msIntoQ;
}

function prevSlotInfo() {
  const now      = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const prevMin  = Math.floor(totalMin / 15) * 15 - 15;
  if (prevMin < 0) return null;
  const h = Math.floor(prevMin / 60), m = prevMin % 60;
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return {
    key:   `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`,
    label: `${h12}:${String(m).padStart(2,'0')} ${h < 12 ? 'AM' : 'PM'}`,
  };
}

function fireReminder() {
  const slot = prevSlotInfo();
  if (!slot) return;
  const dayData = readDay(todayString());
  createReminder(slot.key, slot.label, (dayData[slot.key] && dayData[slot.key].planned) || null);
}

function scheduleReminders() {
  setTimeout(() => { fireReminder(); setInterval(fireReminder, 15 * 60 * 1000); }, msUntilNextQuarter());
}

// ── Auto-update ───────────────────────────────────────────────────────────────

function setupAutoUpdate() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-not-available', () => {
    if (mainWin) mainWin.webContents.send('updateStatus', "You're up to date");
  });

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(mainWin, {
      type: 'info',
      title: 'Update Ready',
      message: 'A new version of Timesheet has been downloaded. Restart now to install it?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.checkForUpdates().catch(() => {});
}

ipcMain.handle('checkForUpdates', () => autoUpdater.checkForUpdates().catch(() => {}));

// ── App lifecycle ─────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
    else createMain();
  });

  app.whenReady().then(() => {
    initPaths();
    migrateFromSqlite();
    createTray();
    createMain();
    scheduleReminders();
    setupAutoUpdate();
    app.on('activate', () => { if (!mainWin) { mainWin = null; createMain(); } });
  });

  // App stays alive in tray — only quit via tray menu
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { isQuitting = true; });
}
