const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ts', {
  loadDay:          (date)         => ipcRenderer.invoke('loadDay', date),
  saveDay:          (date, data)   => ipcRenderer.invoke('saveDay', date, data),
  loadCategories:   ()             => ipcRenderer.invoke('loadCategories'),
  saveCategories:   (cats)         => ipcRenderer.invoke('saveCategories', cats),
  getAllData:        ()             => ipcRenderer.invoke('getAllData'),
  exportData:       (from, to)     => ipcRenderer.invoke('exportData', from, to),
  exportJson:       (from, to)     => ipcRenderer.invoke('exportJson', from, to),

  // Reminder window
  reminderReady:    ()             => ipcRenderer.invoke('reminderReady'),
  submitReminder:   (slotKey, cat, text) => ipcRenderer.invoke('submitReminder', slotKey, cat, text),
  dismissReminder:  ()             => ipcRenderer.invoke('dismissReminder'),

  onReminderData:   (cb)           => ipcRenderer.on('reminderData', (_, d) => cb(d)),
  onRefreshDay:     (cb)           => ipcRenderer.on('refreshDay', () => cb()),
});
