// Prevent a console window from popping up alongside the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf, time::Duration};

use chrono::{Local, Timelike};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

// ── Storage ─────────────────────────────────────────────────────────────────
// One JSON file per day under %APPDATA%\Timesheet\days, categories.json beside it.
// The path is pinned to the old Electron `userData` location so existing data is
// picked up unchanged after the port. No database, no locking.

fn base_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    PathBuf::from(appdata).join("Timesheet")
}
fn days_dir() -> PathBuf {
    let d = base_dir().join("days");
    let _ = fs::create_dir_all(&d);
    d
}
fn cats_file() -> PathBuf {
    base_dir().join("categories.json")
}
fn email_cfg_file() -> PathBuf {
    base_dir().join("email.json")
}

fn read_day(date: &str) -> Value {
    fs::read_to_string(days_dir().join(format!("{date}.json")))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_day(date: &str, data: &Value) {
    // Strip empty slots before writing (matches the original writeDay).
    let mut clean = serde_json::Map::new();
    if let Some(obj) = data.as_object() {
        for (slot, sides) in obj {
            let mut s = serde_json::Map::new();
            if let Some(sobj) = sides.as_object() {
                for (side, val) in sobj {
                    let has_text = val
                        .get("text")
                        .and_then(|t| t.as_str())
                        .map(|t| !t.is_empty())
                        .unwrap_or(false);
                    let has_cat = val
                        .get("cat")
                        .and_then(|c| c.as_str())
                        .map(|c| c != "none")
                        .unwrap_or(false);
                    if has_text || has_cat {
                        s.insert(side.clone(), val.clone());
                    }
                }
            }
            if !s.is_empty() {
                clean.insert(slot.clone(), Value::Object(s));
            }
        }
    }

    let file = days_dir().join(format!("{date}.json"));
    if clean.is_empty() {
        let _ = fs::remove_file(&file);
    } else {
        // Atomic write via temp + rename — safe on NTFS.
        let tmp = days_dir().join(format!("{date}.json.tmp"));
        if fs::write(&tmp, Value::Object(clean).to_string()).is_ok() {
            let _ = fs::rename(&tmp, &file);
        }
    }
}

fn load_range_inner(from: &str, to: &str) -> Value {
    let mut result = serde_json::Map::new();
    if let Ok(entries) = fs::read_dir(days_dir()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") {
                continue; // skips *.json.tmp too
            }
            let date = &name[..name.len() - 5];
            if date >= from && date <= to {
                if let Ok(txt) = fs::read_to_string(entry.path()) {
                    if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                        result.insert(date.to_string(), v);
                    }
                }
            }
        }
    }
    Value::Object(result)
}

fn default_cats() -> Value {
    json!([
        { "id": "none",     "label": "None",        "color": "#2e3350" },
        { "id": "deep",     "label": "Deep Work",   "color": "#3b82f6" },
        { "id": "meetings", "label": "Meetings",    "color": "#a855f7" },
        { "id": "admin",    "label": "Admin",       "color": "#f97316" },
        { "id": "break",    "label": "Break",       "color": "#22c55e" },
        { "id": "personal", "label": "Personal",    "color": "#06b6d4" },
        { "id": "exercise", "label": "Exercise",    "color": "#ef4444" },
        { "id": "learning", "label": "Learning",    "color": "#eab308" },
        { "id": "quoting",  "label": "Quoting",     "color": "#0d9488" },
        { "id": "wasted",   "label": "Wasted Time", "color": "#991b1b" },
        { "id": "other",    "label": "Other",       "color": "#6b7280" }
    ])
}

fn today_string() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn csv_escape(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

// ── Commands (the `window.ts` API, mirrored from the old preload.js) ──────────

#[tauri::command]
fn load_day(date: String) -> Value {
    read_day(&date)
}

#[tauri::command]
fn save_day(date: String, data: Value) {
    write_day(&date, &data);
}

#[tauri::command]
fn load_range(from: String, to: String) -> Value {
    load_range_inner(&from, &to)
}

#[tauri::command]
fn load_categories() -> Value {
    fs::read_to_string(cats_file())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(default_cats)
}

#[tauri::command]
fn save_categories(cats: Value) {
    let _ = fs::write(cats_file(), cats.to_string());
}

#[tauri::command]
fn export_csv(app: AppHandle, from: String, to: String) -> Value {
    let picked = app
        .dialog()
        .file()
        .add_filter("CSV", &["csv"])
        .set_file_name(format!("timesheet_{from}_to_{to}.csv"))
        .blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return json!({ "cancelled": true });
    };

    let mut lines = vec!["Date,Time,Side,Category,Text".to_string()];
    let range = load_range_inner(&from, &to);
    let obj = range.as_object().cloned().unwrap_or_default();
    // serde_json keys are sorted; date + zero-padded slot keys sort chronologically.
    for (date, day) in &obj {
        if let Some(slots) = day.as_object() {
            for (slot, sides) in slots {
                if let Some(sides) = sides.as_object() {
                    for (side, val) in sides {
                        let cat = val.get("cat").and_then(|c| c.as_str()).unwrap_or("");
                        let text = val.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        lines.push(format!(
                            "{date},{slot},{side},{cat},{}",
                            csv_escape(text)
                        ));
                    }
                }
            }
        }
    }
    let _ = fs::write(&path, lines.join("\n"));
    json!({ "filePath": path.to_string_lossy() })
}

#[tauri::command]
fn export_json(app: AppHandle, from: String, to: String) -> Value {
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(format!("timesheet_{from}_to_{to}.json"))
        .blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return json!({ "cancelled": true });
    };
    let range = load_range_inner(&from, &to);
    let _ = fs::write(&path, serde_json::to_string_pretty(&range).unwrap_or_default());
    json!({ "filePath": path.to_string_lossy() })
}

// ── Email (SendGrid SMTP) ─────────────────────────────────────────────────────
// From/To live in email.json; the API key lives in Windows Credential Manager
// (keyring), never on disk in cleartext. The email body is the day's *actual*
// entries as an HTML table — a manager-facing report, no attachment.

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("Timesheet", "sendgrid").map_err(|e| e.to_string())
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn cat_labels() -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    if let Some(arr) = load_categories().as_array() {
        for c in arr {
            if let (Some(id), Some(label)) = (
                c.get("id").and_then(|v| v.as_str()),
                c.get("label").and_then(|v| v.as_str()),
            ) {
                m.insert(id.to_string(), label.to_string());
            }
        }
    }
    m
}

fn day_to_html(date: &str, day: &Value) -> String {
    let labels = cat_labels();
    let mut rows = String::new();
    // serde_json Map is a BTreeMap here (no preserve_order feature), so "HH:MM"
    // slot keys iterate in chronological order — same assumption as export_csv.
    if let Some(slots) = day.as_object() {
        for (slot, sides) in slots {
            let actual = sides.get("actual");
            let cat = actual
                .and_then(|a| a.get("cat"))
                .and_then(|c| c.as_str())
                .unwrap_or("none");
            let text = actual
                .and_then(|a| a.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if cat == "none" && text.is_empty() {
                continue;
            }
            let cat_label = labels.get(cat).map(|s| s.as_str()).unwrap_or(cat);
            let td = "padding:4px 10px;border-bottom:1px solid #eee;";
            rows.push_str(&format!(
                "<tr><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td><td style=\"{td}\">{}</td></tr>",
                html_escape(slot),
                html_escape(cat_label),
                html_escape(text)
            ));
        }
    }
    if rows.is_empty() {
        rows.push_str("<tr><td colspan=\"3\" style=\"padding:10px;color:#888;\">No entries recorded.</td></tr>");
    }
    let th = "text-align:left;padding:4px 10px;border-bottom:2px solid #333;";
    format!(
        "<div style=\"font-family:Arial,sans-serif;font-size:14px;color:#222;\">\
         <h2 style=\"margin:0 0 12px;\">Timesheet — {}</h2>\
         <table style=\"border-collapse:collapse;width:100%;max-width:520px;\">\
         <thead><tr><th style=\"{th}\">Time</th><th style=\"{th}\">Category</th><th style=\"{th}\">Notes</th></tr></thead>\
         <tbody>{}</tbody></table></div>",
        html_escape(date),
        rows
    )
}

#[tauri::command]
fn load_email_settings() -> Value {
    let mut v = fs::read_to_string(email_cfg_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({}));
    // Report whether a key is stored, but never hand the key back to the UI.
    let has_key = keyring_entry()
        .and_then(|e| e.get_password().map_err(|e| e.to_string()))
        .is_ok();
    if let Some(o) = v.as_object_mut() {
        o.insert("hasKey".to_string(), json!(has_key));
    }
    v
}

#[tauri::command]
fn save_email_settings(from: String, to: String, api_key: String) -> Result<(), String> {
    fs::write(email_cfg_file(), json!({ "from": from, "to": to }).to_string())
        .map_err(|e| e.to_string())?;
    // Empty api_key means "keep the existing key" — lets the user edit addresses
    // without re-typing the secret.
    if !api_key.is_empty() {
        keyring_entry()?
            .set_password(&api_key)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn send_email_blocking(date: &str) -> Result<String, String> {
    use lettre::message::header::ContentType;
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{Message, SmtpTransport, Transport};

    let cfg = fs::read_to_string(email_cfg_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .ok_or("Email not configured — set From, To and API key first.")?;
    let from = cfg.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let to = cfg.get("to").and_then(|v| v.as_str()).unwrap_or("");
    if from.is_empty() || to.is_empty() {
        return Err("From and To addresses are required.".to_string());
    }
    let api_key = keyring_entry()?
        .get_password()
        .map_err(|_| "No SendGrid API key stored. Save one in Settings.".to_string())?;

    let day = read_day(date);
    let email = Message::builder()
        .from(from.parse().map_err(|e| format!("Bad From address: {e}"))?)
        .to(to.parse().map_err(|e| format!("Bad To address: {e}"))?)
        .subject(format!("Timesheet — {date}"))
        .header(ContentType::TEXT_HTML)
        .body(day_to_html(date, &day))
        .map_err(|e| e.to_string())?;

    // SendGrid SMTP: username is the literal "apikey", password is the API key.
    let creds = Credentials::new("apikey".to_string(), api_key);
    let mailer = SmtpTransport::relay("smtp.sendgrid.net")
        .map_err(|e| e.to_string())?
        .credentials(creds)
        .build();
    mailer.send(&email).map_err(|e| e.to_string())?;
    Ok(format!("Sent to {to}"))
}

#[tauri::command]
async fn send_timesheet_email(date: String) -> Result<String, String> {
    // async command → runs on the tokio pool, not the main thread, so the blocking
    // SMTP send doesn't freeze the UI. ponytail: a rare single-user send; not worth
    // spawn_blocking to free the worker thread.
    send_email_blocking(&date)
}

#[tauri::command]
fn submit_reminder(app: AppHandle, slot_key: String, cat: String, text: String) {
    let today = today_string();
    let mut data = read_day(&today);
    if !data.is_object() {
        data = json!({});
    }
    let obj = data.as_object_mut().unwrap();
    let slot = obj.entry(slot_key).or_insert_with(|| json!({}));
    if let Some(slot) = slot.as_object_mut() {
        slot.insert(
            "actual".to_string(),
            json!({ "cat": if cat.is_empty() { "none".to_string() } else { cat }, "text": text }),
        );
    }
    write_day(&today, &data);
    let _ = app.emit("refreshDay", ());
    if let Some(w) = app.get_webview_window("reminder") {
        let _ = w.close();
    }
}

// ponytail: updater/dialog signatures here are the part most likely to need a
// tweak on first `cargo tauri dev` — the rest of the file is plain std/serde.
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<String, String> {
    run_update_check(app).await
}

async fn run_update_check(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => {
            update
                .download_and_install(|_chunk, _total| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            let restart = app
                .dialog()
                .message("A new version of Timesheet has been downloaded. Restart now to install it?")
                .title("Update Ready")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Restart".to_string(),
                    "Later".to_string(),
                ))
                .blocking_show();
            if restart {
                app.restart();
            }
            Ok("Update downloaded".to_string())
        }
        None => Ok("You're up to date".to_string()),
    }
}

// ── Reminders ─────────────────────────────────────────────────────────────────
// The renderer's hidden window could have its timers throttled by the OS webview,
// so the schedule lives here (the "main process") exactly like the Electron build.
// reminder.html figures out the slot from the clock and reads the day file itself.

fn ms_until_next_quarter() -> u64 {
    let now = Local::now();
    let into = (now.minute() as u64 % 15) * 60_000
        + now.second() as u64 * 1000
        + now.timestamp_subsec_millis() as u64;
    15 * 60 * 1000 - into
}
fn quarter_elapsed_ms() -> u64 {
    15 * 60 * 1000 - ms_until_next_quarter()
}

fn open_reminder(app: &AppHandle) {
    if app.get_webview_window("reminder").is_some() {
        return;
    }
    // Built hidden; reminder.html sizes/positions itself (bottom-right) then shows.
    let _ = WebviewWindowBuilder::new(app, "reminder", WebviewUrl::App("reminder.html".into()))
        .title("Timesheet Reminder")
        .inner_size(360.0, 220.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_day,
            save_day,
            load_range,
            load_categories,
            save_categories,
            export_csv,
            export_json,
            load_email_settings,
            save_email_settings,
            send_timesheet_email,
            submit_reminder,
            check_for_updates
        ])
        .setup(|app| {
            // Tray icon + menu (Open / Quit). App stays alive in the tray.
            let open_i = MenuItem::with_id(app, "open", "Open Timesheet", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("Timesheet")
                .menu(&menu)
                .show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "open" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            })
            .build(app)?;

            // Check for updates once on startup (silent unless one is found).
            let up_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = run_update_check(up_handle).await;
            });

            // Quarter-hour reminder scheduler. Re-aligns to the wall clock after
            // every tick (no drift); a tick that came due while asleep is stale —
            // if we're already >60s into the quarter, skip it.
            let sched_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(ms_until_next_quarter().max(1)));
                if quarter_elapsed_ms() < 60_000 {
                    let h = sched_handle.clone();
                    let _ = sched_handle.run_on_main_thread(move || open_reminder(&h));
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray: the main window hides instead of closing. The app
            // only quits via the tray menu.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_to_html_renders_actuals_and_escapes() {
        let day = json!({
            "07:00": { "actual": { "cat": "deep", "text": "spec <review> & notes" } },
            "07:15": { "planned": { "cat": "meetings", "text": "standup" } }, // no actual → skipped
            "07:30": { "actual": { "cat": "none", "text": "" } }              // empty → skipped
        });
        let html = day_to_html("2026-07-07", &day);
        assert!(html.contains("2026-07-07"));
        assert!(html.contains("07:00"));
        assert!(html.contains("spec &lt;review&gt; &amp; notes")); // escaped
        assert!(!html.contains("standup")); // planned-only slot omitted
        assert!(!html.contains("07:30")); // empty actual omitted
    }

    #[test]
    fn day_to_html_handles_empty_day() {
        let html = day_to_html("2026-07-07", &json!({}));
        assert!(html.contains("No entries recorded."));
    }
}
