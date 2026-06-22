const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path    = require('path');
const fs      = require('fs');
const { Database } = require('node-sqlite3-wasm');

// ── Database ──────────────────────────────────────────────────────────────────

const DB_PATH = path.join(app.getPath('userData'), 'timesheet.db');
let db, stmts;

function openDb() {
  db = new Database(DB_PATH);
  // ponytail: DELETE mode instead of WAL — avoids -wal/-shm lock files surviving crashes
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS slots (
      date     TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      side     TEXT NOT NULL CHECK(side IN ('planned','actual')),
      cat      TEXT NOT NULL DEFAULT 'none',
      text     TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (date, slot_key, side)
    );
    CREATE TABLE IF NOT EXISTS categories (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      color      TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
    const ins = db.prepare('INSERT INTO categories (id, label, color, sort_order) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      [
        ['none',     'None',        '#2e3350',  0],
        ['deep',     'Deep Work',   '#3b82f6',  1],
        ['meetings', 'Meetings',    '#a855f7',  2],
        ['admin',    'Admin',       '#f97316',  3],
        ['break',    'Break',       '#22c55e',  4],
        ['personal', 'Personal',    '#06b6d4',  5],
        ['exercise', 'Exercise',    '#ef4444',  6],
        ['learning', 'Learning',    '#eab308',  7],
        ['quoting',  'Quoting',     '#0d9488',  8],
        ['wasted',   'Wasted Time', '#991b1b',  9],
        ['other',    'Other',       '#6b7280', 10],
      ].forEach(r => ins.run(r));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  stmts = {
    getDay:          db.prepare('SELECT slot_key, side, cat, text FROM slots WHERE date = ?'),
    upsertSlot:      db.prepare(`
      INSERT INTO slots (date, slot_key, side, cat, text) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date, slot_key, side) DO UPDATE SET cat=excluded.cat, text=excluded.text
    `),
    deleteDay:       db.prepare('DELETE FROM slots WHERE date = ?'),
    getSlotsInRange: db.prepare(`
      SELECT date, slot_key, side, cat, text FROM slots
      WHERE date >= ? AND date <= ? ORDER BY date, slot_key, side
    `),
    getCats:         db.prepare('SELECT id, label, color FROM categories ORDER BY sort_order'),
    upsertCat:       db.prepare(`
      INSERT INTO categories (id, label, color, sort_order) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, color=excluded.color, sort_order=excluded.sort_order
    `),
    clearCats:       db.prepare('DELETE FROM categories'),
  };
}

function withTransaction(fn) {
  db.exec('BEGIN');
  try { fn(); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowsToDay(rows) {
  const data = {};
  for (const row of rows) {
    if (!data[row.slot_key]) data[row.slot_key] = {};
    data[row.slot_key][row.side] = { cat: row.cat, text: row.text };
  }
  return data;
}

function rowsToRange(rows) {
  const all = {};
  for (const row of rows) {
    if (!all[row.date]) all[row.date] = {};
    if (!all[row.date][row.slot_key]) all[row.date][row.slot_key] = {};
    all[row.date][row.slot_key][row.side] = { cat: row.cat, text: row.text };
  }
  return all;
}

// ── Windows ───────────────────────────────────────────────────────────────────

let mainWin = null, reminderWin = null;

function createMain() {
  mainWin = new BrowserWindow({
    width: 1200, height: 900, minWidth: 800, minHeight: 600,
    title: 'Timesheet',
    backgroundColor: '#0f1117',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWin.on('closed', () => { mainWin = null; });
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

ipcMain.handle('loadDay',        (_, date)      => rowsToDay(stmts.getDay.all([date])));
ipcMain.handle('loadRange',      (_, from, to)  => rowsToRange(stmts.getSlotsInRange.all([from, to])));
ipcMain.handle('loadCategories', ()             => stmts.getCats.all());

ipcMain.handle('saveDay', (_, date, data) => {
  withTransaction(() => {
    stmts.deleteDay.run([date]);
    for (const [slot_key, sides] of Object.entries(data)) {
      for (const [side, val] of Object.entries(sides)) {
        if (val && (val.cat !== 'none' || val.text)) {
          stmts.upsertSlot.run([date, slot_key, side, val.cat || 'none', val.text || '']);
        }
      }
    }
  });
});

ipcMain.handle('saveCategories', (_, cats) => {
  withTransaction(() => {
    stmts.clearCats.run();
    cats.forEach((cat, i) => stmts.upsertCat.run([cat.id, cat.label, cat.color, i]));
  });
});

ipcMain.handle('exportData', async (_, from, to) => {
  const { filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Export CSV',
    defaultPath: `timesheet_${from}_to_${to}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!filePath) return { cancelled: true };
  const rows  = stmts.getSlotsInRange.all([from, to]);
  const esc   = s => `"${(s||'').replace(/"/g,'""')}"`;
  const lines = ['Date,Time,Side,Category,Text',
    ...rows.map(r => [r.date, r.slot_key, r.side, r.cat, esc(r.text)].join(','))];
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
  fs.writeFileSync(filePath, JSON.stringify(rowsToRange(stmts.getSlotsInRange.all([from, to])), null, 2), 'utf8');
  return { filePath };
});

ipcMain.handle('submitReminder', (_, slotKey, cat, text) => {
  stmts.upsertSlot.run([todayString(), slotKey, 'actual', cat || 'none', text || '']);
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
  const now = new Date();
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
  const dayData = rowsToDay(stmts.getDay.all([todayString()]));
  createReminder(slot.key, slot.label, (dayData[slot.key] && dayData[slot.key].planned) || null);
}

function scheduleReminders() {
  setTimeout(() => { fireReminder(); setInterval(fireReminder, 15 * 60 * 1000); }, msUntilNextQuarter());
}

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
    openDb();
    createMain();
    scheduleReminders();
    app.on('activate', () => { if (!mainWin) createMain(); });
  });

  app.on('window-all-closed', () => {
    if (db) db.close();
    if (process.platform !== 'darwin') app.quit();
  });
}
