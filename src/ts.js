// window.ts — same surface the old preload.js exposed, reimplemented over Tauri.
// Storage/export/update run as Rust commands (invoke); window control and the
// refresh signal use Tauri's core JS APIs. Loaded before the page scripts thanks
// to `withGlobalTauri`, so window.ts is ready synchronously.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const { getCurrentWindow } = window.__TAURI__.window;

  let updateStatusCb = null;

  window.ts = {
    loadDay: (date) => invoke('load_day', { date }),
    loadRange: (from, to) => invoke('load_range', { from, to }),
    saveDay: (date, data) => invoke('save_day', { date, data }),
    saveSlot: (date, slotKey, side, field, value) =>
      invoke('save_slot', { date, slotKey, side, field, value }),
    loadCategories: () => invoke('load_categories'),
    saveCategories: (cats) => invoke('save_categories', { cats }),
    exportData: (from, to) => invoke('export_csv', { from, to }),
    exportJson: (from, to) => invoke('export_json', { from, to }),

    // Email (SendGrid SMTP). loadEmailSettings returns { from, to, hasKey }.
    loadEmailSettings: () => invoke('load_email_settings'),
    saveEmailSettings: (from, to, apiKey) =>
      invoke('save_email_settings', { from, to, apiKey }),
    sendTimesheetEmail: (date) => invoke('send_timesheet_email', { date }),

    // Reminder window
    submitReminder: (slotKey, cat, text) =>
      invoke('submit_reminder', { slotKey, cat, text }),
    dismissReminder: () => getCurrentWindow().close(),

    onRefreshDay: (cb) => listen('refreshDay', () => cb()),

    checkForUpdates: async () => {
      try {
        const msg = await invoke('check_for_updates');
        if (updateStatusCb) updateStatusCb(msg);
      } catch (e) {
        if (updateStatusCb) updateStatusCb(String(e));
      }
    },
    onUpdateStatus: (cb) => { updateStatusCb = cb; },
  };
})();
