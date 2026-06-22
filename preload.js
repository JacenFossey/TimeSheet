const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ts', {
  loadDay:          (date)         => ipcRenderer.invoke('loadDay', date),
  loadRange:        (from, to)     => ipcRenderer.invoke('loadRange', from, to),
  saveDay:          (date, data)   => ipcRenderer.invoke('saveDay', date, data),
  loadCategories:   ()             => ipcRenderer.invoke('loadCategories'),
  saveCategories:   (cats)         => ipcRenderer.invoke('saveCategories', cats),
  exportData:       (from, to)     => ipcRenderer.invoke('exportData', from, to),
  exportJson:       (from, to)     => ipcRenderer.invoke('exportJson', from, to),

  // Reminder window
  submitReminder:   (slotKey, cat, text) => ipcRenderer.invoke('submitReminder', slotKey, cat, text),
  dismissReminder:  ()             => ipcRenderer.invoke('dismissReminder'),

  onReminderData:   (cb)           => ipcRenderer.on('reminderData', (_, d) => cb(d)),
  onRefreshDay:     (cb)           => ipcRenderer.on('refreshDay', () => cb()),
  checkForUpdates:  ()             => ipcRenderer.invoke('checkForUpdates'),
  onUpdateStatus:   (cb)           => ipcRenderer.on('updateStatus', (_, msg) => cb(msg)),
});
