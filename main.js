const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

// ── Database setup ────────────────────────────────────────────────────────────

const DB_PATH = path.join(app.getPath('userData'), 'timesheet.db');

let db;
let stmts;

function openDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

  // Seed default categories if table is empty
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count === 0) {
    const insert = db.prepare(
      'INSERT INTO categories (id, label, color, sort_order) VALUES (?,?,?,?)'
    );
    const defaults = [
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
    ];
    const seedAll = db.transaction(() => defaults.forEach(r => insert.run(...r)));
    seedAll();
  }

  stmts = {
    getDay: db.prepare(`
      SELECT slot_key, side, cat, text FROM slots WHERE date = ?
    `),
    upsertSlot: db.prepare(`
      INSERT INTO slots (date, slot_key, side, cat, text)
      VALUES (@date, @slot_key, @side, @cat, @text)
      ON CONFLICT(date, slot_key, side) DO UPDATE SET cat=excluded.cat, text=excluded.text
    `),
    deleteDay:       db.prepare('DELETE FROM slots WHERE date = ?'),
    getSlotsInRange: db.prepare(`
      SELECT date, slot_key, side, cat, text FROM slots
      WHERE date >= ? AND date <= ?
      ORDER BY date, slot_key, side
    `),
    getCats:    db.prepare('SELECT id, label, color FROM categories ORDER BY sort_order'),
    upsertCat:  db.prepare(`
      INSERT INTO categories (id, label, color, sort_order)
      VALUES (@id, @label, @color, @sort_order)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, color=excluded.color, sort_order=excluded.sort_order
    `),
    clearCats:  db.prepare('DELETE FROM categories'),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Convert flat DB rows → { slotKey: { planned: {cat,text}, actual: {cat,text} } }
function rowsToDay(rows) {
  const data = {};
  for (const row of rows) {
    if (!data[row.slot_key]) data[row.slot_key] = {};
    data[row.slot_key][row.side] = { cat: row.cat, text: row.text };
  }
  return data;
}

// Convert ranged rows → { date: { slotKey: { side: {cat,text} } } }
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

let mainWin    = null;
let reminderWin = null;

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

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('loadDay', (_, date) => rowsToDay(stmts.getDay.all(date)));

ipcMain.handle('loadRange', (_, fromDate, toDate) =>
  rowsToRange(stmts.getSlotsInRange.all(fromDate, toDate))
);

ipcMain.handle('saveDay', (_, date, data) => {
  const saveAll = db.transaction(() => {
    stmts.deleteDay.run(date);
    for (const [slot_key, sides] of Object.entries(data)) {
      for (const [side, val] of Object.entries(sides)) {
        if (val && (val.cat !== 'none' || val.text)) {
          stmts.upsertSlot.run({ date, slot_key, side, cat: val.cat || 'none', text: val.text || '' });
        }
      }
    }
  });
  saveAll();
});

ipcMain.handle('loadCategories', () => stmts.getCats.all());

ipcMain.handle('saveCategories', (_, cats) => {
  const saveAll = db.transaction(() => {
    stmts.clearCats.run();
    cats.forEach((cat, i) => stmts.upsertCat.run({ id: cat.id, label: cat.label, color: cat.color, sort_order: i }));
  });
  saveAll();
});

ipcMain.handle('exportData', async (_, fromDate, toDate) => {
  const { filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Export CSV',
    defaultPath: `timesheet_${fromDate}_to_${toDate}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!filePath) return { cancelled: true };

  const rows = stmts.getSlotsInRange.all(fromDate, toDate);
  const lines = ['Date,Time,Side,Category,Text'];
  for (const row of rows) {
    const esc = s => `"${(s||'').replace(/"/g,'""')}"`;
    lines.push([row.date, row.slot_key, row.side, row.cat, esc(row.text)].join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return { filePath };
});

ipcMain.handle('exportJson', async (_, fromDate, toDate) => {
  const { filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Export JSON',
    defaultPath: `timesheet_${fromDate}_to_${toDate}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return { cancelled: true };

  const rows = stmts.getSlotsInRange.all(fromDate, toDate);
  fs.writeFileSync(filePath, JSON.stringify(rowsToRange(rows), null, 2), 'utf8');
  return { filePath };
});

ipcMain.handle('submitReminder', (_, slotKey, cat, text) => {
  const today = todayString();
  stmts.upsertSlot.run({ date: today, slot_key: slotKey, side: 'actual', cat: cat || 'none', text: text || '' });
  if (mainWin) mainWin.webContents.send('refreshDay');
  if (reminderWin) reminderWin.close();
});

ipcMain.handle('dismissReminder', () => { if (reminderWin) reminderWin.close(); });

// ── 15-minute reminder timer ──────────────────────────────────────────────────

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function msUntilNextQuarter() {
  const now = new Date();
  const msIntoQ = ((now.getMinutes() % 15) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  return (15 * 60 * 1000) - msIntoQ;
}

function prevSlotInfo() {
  const now = new Date();
  const totalMin = now.getHours() * 60 + now.getMinutes();
  const boundary = Math.floor(totalMin / 15) * 15;
  const prevMin  = boundary - 15;
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
  const today = todayString();
  const dayData = rowsToDay(stmts.getDay.all(today));
  const planned = (dayData[slot.key] && dayData[slot.key].planned) || null;
  createReminder(slot.key, slot.label, planned);
}

function scheduleReminders() {
  setTimeout(() => {
    fireReminder();
    setInterval(fireReminder, 15 * 60 * 1000);
  }, msUntilNextQuarter());
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

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
