// Prevent a console window from popping up alongside the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use chrono::{Local, NaiveDate, NaiveTime, Timelike};
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
// picked up unchanged after the port. A process-local lock serializes the main
// and reminder windows so their read/modify/write cycles cannot clobber data.

static STORAGE_LOCK: Mutex<()> = Mutex::new(());

fn base_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    PathBuf::from(appdata).join("Timesheet")
}

fn validate_date(date: &str) -> Result<(), String> {
    let parsed =
        NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| format!("Invalid date: {date}"))?;
    if parsed.format("%Y-%m-%d").to_string() != date {
        return Err(format!("Invalid date: {date}"));
    }
    Ok(())
}

fn validate_slot(slot: &str) -> Result<(), String> {
    let parsed = NaiveTime::parse_from_str(slot, "%H:%M")
        .map_err(|_| format!("Invalid time slot: {slot}"))?;
    if parsed.format("%H:%M").to_string() != slot || parsed.minute() % 15 != 0 {
        return Err(format!("Invalid time slot: {slot}"));
    }
    Ok(())
}

// Persist through a sibling temp file and keep the previous file recoverable
// until the replacement succeeds. `std::fs::rename` cannot replace an existing
// destination on Windows, so a direct temp -> destination rename loses updates.
fn replace_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(contents).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);

    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(e) = fs::rename(&tmp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(e.to_string());
    }
    let _ = fs::remove_file(&backup);
    Ok(())
}

fn recover_interrupted_replace(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let tmp = path.with_extension("tmp");
    let backup = path.with_extension("bak");
    if tmp.exists() {
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(backup);
    } else if backup.exists() {
        fs::rename(backup, path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn days_dir() -> Result<PathBuf, String> {
    let d = base_dir().join("days");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}
fn cats_file() -> PathBuf {
    base_dir().join("categories.json")
}
fn email_cfg_file() -> PathBuf {
    base_dir().join("email.json")
}
fn standard_plan_file() -> PathBuf {
    base_dir().join("standard-week.json")
}

fn read_day(date: &str) -> Result<Value, String> {
    let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
    read_day_unlocked(date)
}

fn read_day_unlocked(date: &str) -> Result<Value, String> {
    validate_date(date)?;
    let path = days_dir()?.join(format!("{date}.json"));
    recover_interrupted_replace(&path)?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(e.to_string()),
    };
    serde_json::from_str(&text).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

fn write_day(date: &str, data: &Value) -> Result<(), String> {
    let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
    write_day_unlocked(date, data)
}

fn write_day_unlocked(date: &str, data: &Value) -> Result<(), String> {
    validate_date(date)?;
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

    let file = days_dir()?.join(format!("{date}.json"));
    if clean.is_empty() {
        match fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        replace_file(&file, Value::Object(clean).to_string().as_bytes())
    }
}

fn load_range_inner(from: &str, to: &str) -> Result<Value, String> {
    let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
    validate_date(from)?;
    validate_date(to)?;
    if from > to {
        return Err("Start date must be before end date.".to_string());
    }
    let mut result = serde_json::Map::new();
    let dir = days_dir()?;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("bak") {
            let _ = recover_interrupted_replace(&path.with_extension("json"));
        }
    }
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        let date = &name[..name.len() - 5];
        if date >= from && date <= to {
            let txt = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
            let value = serde_json::from_str::<Value>(&txt)
                .map_err(|e| format!("Could not read {name}: {e}"))?;
            result.insert(date.to_string(), value);
        }
    }
    Ok(Value::Object(result))
}

fn default_cats() -> Value {
    json!([
        { "id": "none",     "label": "None",        "color": "#95a29b" },
        { "id": "ontario_sales",  "label": "Ontario Sales",       "color": "#2563eb", "payoff": "high" },
        { "id": "montreal_sales", "label": "Montreal Sales",      "color": "#7c3aed", "payoff": "high" },
        { "id": "quotes_followup", "label": "Quotes / Follow-up", "color": "#0891b2", "payoff": "high" },
        { "id": "karl_vmi",        "label": "Karl / VMI",         "color": "#d97706" },
        { "id": "workflow",        "label": "Workflow Improvements", "color": "#64748b", "payoff": "low" },
        { "id": "meetings", "label": "Meetings",    "color": "#a855f7" },
        { "id": "admin",    "label": "Admin",       "color": "#f97316" },
        { "id": "break",    "label": "Lunch / Break", "color": "#22c55e" },
        { "id": "other",    "label": "Other",       "color": "#6b7280" }
    ])
}

fn default_standard_plan() -> Value {
    let shared_start = json!([
        { "start": "07:00", "end": "07:30", "cat": "admin", "text": "Priorities and urgent follow-ups" },
        { "start": "07:30", "end": "08:00", "cat": "meetings", "text": "Morning meeting" }
    ]);
    let shared_end = json!([
        { "start": "10:00", "end": "10:15", "cat": "admin", "text": "Log and reset" },
        { "start": "12:00", "end": "13:00", "cat": "break", "text": "Lunch" },
        { "start": "14:30", "end": "15:30", "cat": "quotes_followup", "text": "Quotes and follow-ups" },
        { "start": "16:00", "end": "16:30", "cat": "meetings", "text": "EOD meeting and wrap-up" }
    ]);
    let make_template = |sales: &str, flex_cat: &str, flex_text: &str| {
        let mut blocks = shared_start.as_array().cloned().unwrap_or_default();
        blocks.push(
            json!({ "start": "08:00", "end": "10:00", "cat": sales, "text": "Call block 1" }),
        );
        blocks.push(shared_end[0].clone());
        blocks.push(
            json!({ "start": "10:15", "end": "12:00", "cat": sales, "text": "Call block 2" }),
        );
        blocks.push(shared_end[1].clone());
        blocks.push(
            json!({ "start": "13:00", "end": "14:30", "cat": sales, "text": "Call block 3" }),
        );
        blocks.push(shared_end[2].clone());
        blocks
            .push(json!({ "start": "15:30", "end": "16:00", "cat": flex_cat, "text": flex_text }));
        blocks.push(shared_end[3].clone());
        Value::Array(blocks)
    };
    json!({
        "templates": {
            "ontario": make_template("ontario_sales", "admin", "Flex, admin, and tomorrow prep"),
            "montreal": make_template("montreal_sales", "karl_vmi", "Flex / VMI / catch-up")
        },
        "templateNames": {
            "ontario": "Ontario day",
            "montreal": "Montreal / Flex day"
        },
        "week": {
            "mon": "ontario", "tue": "ontario", "wed": "montreal", "thu": "ontario", "fri": "ontario"
        }
    })
}

fn today_string() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn csv_escape(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

// ── Commands (the `window.ts` API, mirrored from the old preload.js) ──────────

#[tauri::command]
fn load_day(date: String) -> Result<Value, String> {
    read_day(&date)
}

#[tauri::command]
fn save_day(date: String, data: Value) -> Result<(), String> {
    write_day(&date, &data)
}

#[tauri::command]
fn save_slot(
    date: String,
    slot_key: String,
    side: String,
    field: String,
    value: String,
) -> Result<(), String> {
    validate_date(&date)?;
    validate_slot(&slot_key)?;
    if side != "planned" && side != "actual" {
        return Err("Invalid slot side.".to_string());
    }
    if field != "cat" && field != "text" {
        return Err("Invalid slot field.".to_string());
    }
    let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut data = read_day_unlocked(&date)?;
    if !data.is_object() {
        data = json!({});
    }
    let day = data.as_object_mut().unwrap();
    let slot = day.entry(slot_key).or_insert_with(|| json!({}));
    if !slot.is_object() {
        *slot = json!({});
    }
    let sides = slot.as_object_mut().unwrap();
    let entry = sides
        .entry(side)
        .or_insert_with(|| json!({ "cat": "none", "text": "" }));
    if !entry.is_object() {
        *entry = json!({ "cat": "none", "text": "" });
    }
    entry.as_object_mut().unwrap().insert(field, json!(value));
    write_day_unlocked(&date, &data)
}

#[tauri::command]
fn load_range(from: String, to: String) -> Result<Value, String> {
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
fn save_categories(cats: Value) -> Result<(), String> {
    let arr = cats.as_array().ok_or("Categories must be an array.")?;
    for cat in arr {
        let id = cat
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Category id is required.")?;
        let label = cat
            .get("label")
            .and_then(Value::as_str)
            .ok_or("Category label is required.")?;
        let color = cat
            .get("color")
            .and_then(Value::as_str)
            .ok_or("Category color is required.")?;
        if id.is_empty()
            || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || label.trim().is_empty()
            || label.chars().count() > 32
            || color.len() != 7
            || !color.starts_with('#')
            || !color[1..].chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err("Invalid category data.".to_string());
        }
    }
    let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
    replace_file(&cats_file(), cats.to_string().as_bytes())
}

#[tauri::command]
fn load_standard_plan() -> Value {
    fs::read_to_string(standard_plan_file())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(default_standard_plan)
}

fn validate_standard_plan(config: &Value) -> Result<(), String> {
    let templates = config
        .get("templates")
        .and_then(Value::as_object)
        .ok_or("Standard-week templates are required.")?;
    if templates.is_empty() {
        return Err("At least one standard day is required.".to_string());
    }
    if templates.len() > 20 {
        return Err("You can create up to 20 standard days.".to_string());
    }
    let template_names = config
        .get("templateNames")
        .and_then(Value::as_object)
        .ok_or("Standard-day names are required.")?;
    for (template_id, value) in templates {
        if template_id.len() > 64
            || template_id.is_empty()
            || !template_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err("A standard-day identifier is invalid.".to_string());
        }
        let name = template_names
            .get(template_id)
            .and_then(Value::as_str)
            .ok_or("Every standard day needs a name.")?;
        if name.trim().is_empty() || name.chars().count() > 40 {
            return Err("Standard-day names must be between 1 and 40 characters.".to_string());
        }
        let blocks = value
            .as_array()
            .ok_or_else(|| format!("The {template_id} template must contain a block list."))?;
        if blocks.len() > 32 {
            return Err("A standard day cannot contain more than 32 blocks.".to_string());
        }
        let mut previous_end: Option<NaiveTime> = None;
        for block in blocks {
            let start = block
                .get("start")
                .and_then(Value::as_str)
                .ok_or("Every block needs a start time.")?;
            let end = block
                .get("end")
                .and_then(Value::as_str)
                .ok_or("Every block needs an end time.")?;
            validate_slot(start)?;
            validate_slot(end)?;
            let start_time =
                NaiveTime::parse_from_str(start, "%H:%M").map_err(|e| e.to_string())?;
            let end_time = NaiveTime::parse_from_str(end, "%H:%M").map_err(|e| e.to_string())?;
            if start_time >= end_time {
                return Err("Every block must end after it starts.".to_string());
            }
            if previous_end.is_some_and(|previous| start_time < previous) {
                return Err("Standard-plan blocks cannot overlap.".to_string());
            }
            previous_end = Some(end_time);
            let cat = block
                .get("cat")
                .and_then(Value::as_str)
                .ok_or("Every block needs a category.")?;
            if cat.is_empty() || !cat.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err("A standard-plan category is invalid.".to_string());
            }
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .ok_or("Every block needs a description field.")?;
            if text.chars().count() > 120 {
                return Err("Standard-plan descriptions cannot exceed 120 characters.".to_string());
            }
        }
    }
    let week = config
        .get("week")
        .and_then(Value::as_object)
        .ok_or("Standard-week assignments are required.")?;
    for day in ["mon", "tue", "wed", "thu", "fri"] {
        let template = week.get(day).and_then(Value::as_str).unwrap_or("");
        if !templates.contains_key(template) {
            return Err(format!("Choose a valid template for {day}."));
        }
    }
    Ok(())
}

#[tauri::command]
fn save_standard_plan(config: Value) -> Result<(), String> {
    validate_standard_plan(&config)?;
    let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
    replace_file(
        &standard_plan_file(),
        serde_json::to_string_pretty(&config)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
}

#[tauri::command]
fn export_csv(app: AppHandle, from: String, to: String) -> Result<Value, String> {
    validate_date(&from)?;
    validate_date(&to)?;
    let picked = app
        .dialog()
        .file()
        .add_filter("CSV", &["csv"])
        .set_file_name(format!("timesheet_{from}_to_{to}.csv"))
        .blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(json!({ "cancelled": true }));
    };

    let mut lines = vec!["Date,Time,Side,Category,Text".to_string()];
    let range = load_range_inner(&from, &to)?;
    let obj = range.as_object().cloned().unwrap_or_default();
    // serde_json keys are sorted; date + zero-padded slot keys sort chronologically.
    for (date, day) in &obj {
        if let Some(slots) = day.as_object() {
            for (slot, sides) in slots {
                if let Some(sides) = sides.as_object() {
                    for (side, val) in sides {
                        let cat = val.get("cat").and_then(|c| c.as_str()).unwrap_or("");
                        let text = val.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        lines.push(format!("{date},{slot},{side},{cat},{}", csv_escape(text)));
                    }
                }
            }
        }
    }
    fs::write(&path, lines.join("\n")).map_err(|e| e.to_string())?;
    Ok(json!({ "filePath": path.to_string_lossy() }))
}

#[tauri::command]
fn export_json(app: AppHandle, from: String, to: String) -> Result<Value, String> {
    validate_date(&from)?;
    validate_date(&to)?;
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(format!("timesheet_{from}_to_{to}.json"))
        .blocking_save_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(json!({ "cancelled": true }));
    };
    let range = load_range_inner(&from, &to)?;
    let output = serde_json::to_string_pretty(&range).map_err(|e| e.to_string())?;
    fs::write(&path, output).map_err(|e| e.to_string())?;
    Ok(json!({ "filePath": path.to_string_lossy() }))
}

// ── Email (SendGrid SMTP) ─────────────────────────────────────────────────────
// From/To live in email.json; the API key lives in Windows Credential Manager
// (keyring), never on disk in cleartext. Manager-facing reports are HTML emails
// with no attachment.

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("Timesheet", "sendgrid").map_err(|e| e.to_string())
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
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

fn daily_category_counts(day: &Value) -> std::collections::BTreeMap<String, usize> {
    let mut counts = std::collections::BTreeMap::new();
    if let Some(slots) = day.as_object() {
        for sides in slots.values() {
            let cat = sides
                .get("actual")
                .and_then(|actual| actual.get("cat"))
                .and_then(Value::as_str)
                .unwrap_or("none");
            if cat != "none" {
                *counts.entry(cat.to_string()).or_default() += 1;
            }
        }
    }
    counts
}

fn daily_report_to_html(date: &str, day: &Value) -> String {
    let labels = cat_labels();
    let counts = daily_category_counts(day);
    let total_hours = counts.values().sum::<usize>() as f64 * 0.25;
    let mut sorted: Vec<_> = counts.iter().collect();
    sorted.sort_by_key(|(_, count)| std::cmp::Reverse(**count));
    let mut rows = String::new();
    for (id, count) in sorted {
        let label = labels.get(id).map(String::as_str).unwrap_or(id);
        rows.push_str(&format!(
            "<tr><td style=\"padding:9px 12px;border-bottom:1px solid #e3e9e5;\">{}</td><td style=\"padding:9px 12px;border-bottom:1px solid #e3e9e5;text-align:right;font-weight:700;\">{:.1}h</td></tr>",
            html_escape(label),
            *count as f64 * 0.25
        ));
    }
    if rows.is_empty() {
        rows.push_str("<tr><td style=\"padding:12px;color:#718078;\">No work logged.</td></tr>");
    }
    format!(
        "<div style=\"font-family:Arial,sans-serif;color:#20322a;max-width:560px;padding:8px;\">\
         <p style=\"margin:0 0 5px;color:#2f6f5e;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;\">Daily activity report</p>\
         <h1 style=\"margin:0 0 20px;font-size:25px;\">{}</h1>\
         <div style=\"display:inline-block;min-width:150px;padding:18px;background:#f3f6f2;border:1px solid #dce5df;border-radius:12px;\"><strong style=\"display:block;font-size:26px;line-height:1.1;\">{total_hours:.1}h</strong><span style=\"color:#718078;font-size:12px;\">Total logged</span></div>\
         <h2 style=\"font-size:15px;margin:16px 0 8px;\">Time by category</h2>\
         <table style=\"border-collapse:collapse;width:100%;max-width:440px;\"><tbody>{rows}</tbody></table></div>",
        html_escape(date),
    )
}

fn weekly_report_to_html(from: &str, to: &str, range: &Value) -> Result<String, String> {
    validate_date(from)?;
    validate_date(to)?;
    let mut date = NaiveDate::parse_from_str(from, "%Y-%m-%d").map_err(|e| e.to_string())?;
    let end = NaiveDate::parse_from_str(to, "%Y-%m-%d").map_err(|e| e.to_string())?;
    if date > end {
        return Err("Start date must be before end date.".to_string());
    }

    let labels = cat_labels();
    let mut day_rows = String::new();
    let mut category_counts = std::collections::BTreeMap::<String, usize>::new();
    let mut total_actual = 0usize;

    while date <= end {
        let date_key = date.format("%Y-%m-%d").to_string();
        let day = range.get(&date_key).and_then(Value::as_object);
        let mut day_actual = 0usize;

        if let Some(slots) = day {
            for sides in slots.values() {
                let actual_cat = sides
                    .get("actual")
                    .and_then(|v| v.get("cat"))
                    .and_then(Value::as_str)
                    .unwrap_or("none");
                let actual_text = sides
                    .get("actual")
                    .and_then(|v| v.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let has_actual = actual_cat != "none" || !actual_text.is_empty();

                if has_actual {
                    day_actual += 1;
                    if actual_cat != "none" {
                        *category_counts.entry(actual_cat.to_string()).or_default() += 1;
                    }
                }
            }
        }

        total_actual += day_actual;
        let td = "padding:9px 12px;border-bottom:1px solid #e3e9e5;text-align:right;";
        day_rows.push_str(&format!(
            "<tr><td style=\"{td}text-align:left;\"><strong>{}</strong><br><span style=\"color:#718078;font-size:12px;\">{}</span></td><td style=\"{td}\">{:.1}h</td></tr>",
            date.format("%A"),
            date.format("%b %-d"),
            day_actual as f64 * 0.25,
        ));
        date = date.succ_opt().ok_or("Date range is too large.")?;
    }

    let mut category_rows = String::new();
    let mut sorted_categories: Vec<_> = category_counts.into_iter().collect();
    sorted_categories.sort_by_key(|item| std::cmp::Reverse(item.1));
    for (id, count) in sorted_categories {
        let label = labels.get(&id).map(String::as_str).unwrap_or(&id);
        category_rows.push_str(&format!(
            "<tr><td style=\"padding:7px 10px;border-bottom:1px solid #e3e9e5;\">{}</td><td style=\"padding:7px 10px;border-bottom:1px solid #e3e9e5;text-align:right;font-weight:600;\">{:.1}h</td></tr>",
            html_escape(label),
            count as f64 * 0.25
        ));
    }
    if category_rows.is_empty() {
        category_rows
            .push_str("<tr><td style=\"padding:10px;color:#718078;\">No work logged.</td></tr>");
    }

    let card = "display:inline-block;min-width:120px;padding:14px;margin:0 8px 10px 0;background:#f3f6f2;border:1px solid #dce5df;border-radius:10px;";
    Ok(format!(
        "<div style=\"font-family:Arial,sans-serif;font-size:14px;color:#20322a;max-width:760px;\">\
         <p style=\"margin:0 0 5px;color:#2f6f5e;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;\">Weekly timesheet</p>\
         <h1 style=\"margin:0 0 18px;font-size:25px;\">{} to {}</h1>\
         <div><div style=\"{card}\"><strong style=\"font-size:21px;\">{:.1}h</strong><br><span style=\"color:#718078;font-size:11px;\">Total logged</span></div></div>\
         <h2 style=\"font-size:15px;margin:18px 0 8px;\">Logged time by day</h2>\
         <table style=\"border-collapse:collapse;width:100%;\"><thead><tr style=\"color:#718078;font-size:10px;text-transform:uppercase;\"><th style=\"text-align:left;padding:8px 12px;\">Day</th><th style=\"text-align:right;padding:8px 12px;\">Total logged</th></tr></thead><tbody>{day_rows}</tbody></table>\
         <h2 style=\"font-size:15px;margin:22px 0 8px;\">Actual time by category</h2>\
         <table style=\"border-collapse:collapse;width:100%;max-width:420px;\"><tbody>{category_rows}</tbody></table></div>",
        html_escape(from),
        html_escape(to),
        total_actual as f64 * 0.25,
    ))
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
    {
        let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
        replace_file(
            &email_cfg_file(),
            json!({ "from": from, "to": to }).to_string().as_bytes(),
        )?;
    }
    // Empty api_key means "keep the existing key" — lets the user edit addresses
    // without re-typing the secret.
    if !api_key.is_empty() {
        keyring_entry()?
            .set_password(&api_key)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn send_html_email_blocking(subject: String, html: String) -> Result<String, String> {
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

    let email = Message::builder()
        .from(from.parse().map_err(|e| format!("Bad From address: {e}"))?)
        .to(to.parse().map_err(|e| format!("Bad To address: {e}"))?)
        .subject(subject)
        .header(ContentType::TEXT_HTML)
        .body(html)
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

fn send_daily_report_blocking(date: &str) -> Result<String, String> {
    let day = read_day(date)?;
    send_html_email_blocking(
        format!("Daily activity report — {date}"),
        daily_report_to_html(date, &day),
    )
}

#[tauri::command]
async fn send_daily_report_email(date: String) -> Result<String, String> {
    // async command → runs on the tokio pool, not the main thread, so the blocking
    // SMTP send doesn't freeze the UI. ponytail: a rare single-user send; not worth
    // spawn_blocking to free the worker thread.
    send_daily_report_blocking(&date)
}

#[tauri::command]
async fn send_weekly_report_email(from: String, to: String) -> Result<String, String> {
    let range = load_range_inner(&from, &to)?;
    let html = weekly_report_to_html(&from, &to, &range)?;
    send_html_email_blocking(format!("Weekly timesheet — {from} to {to}"), html)
}

#[tauri::command]
fn submit_reminder(
    app: AppHandle,
    slot_key: String,
    cat: String,
    text: String,
) -> Result<(), String> {
    let today = today_string();
    let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut data = read_day_unlocked(&today)?;
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
    write_day_unlocked(&today, &data)?;
    let _ = app.emit("refreshDay", ());
    if let Some(w) = app.get_webview_window("reminder") {
        let _ = w.close();
    }
    Ok(())
}

#[tauri::command]
fn open_reminder_correction(app: AppHandle, slot_key: String) -> Result<(), String> {
    validate_slot(&slot_key)?;
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    app.emit("correctSlot", slot_key)
        .map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("reminder") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
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
                .message(
                    "A new version of Timesheet has been downloaded. Restart now to install it?",
                )
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
            save_slot,
            load_range,
            load_categories,
            save_categories,
            load_standard_plan,
            save_standard_plan,
            export_csv,
            export_json,
            load_email_settings,
            save_email_settings,
            send_daily_report_email,
            send_weekly_report_email,
            submit_reminder,
            open_reminder_correction,
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
    fn validates_dates_before_using_them_as_paths() {
        assert!(validate_date("2026-08-19").is_ok());
        assert!(validate_date("../email").is_err());
        assert!(validate_date("2026-02-30").is_err());
        assert!(validate_date("2026-8-19").is_err());
    }

    #[test]
    fn validates_quarter_hour_slots() {
        assert!(validate_slot("07:00").is_ok());
        assert!(validate_slot("16:15").is_ok());
        assert!(validate_slot("07:10").is_err());
        assert!(validate_slot("../email").is_err());
    }

    #[test]
    fn replace_file_overwrites_an_existing_destination() {
        let dir = std::env::temp_dir().join(format!("timesheet-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("day.json");
        replace_file(&path, b"first").unwrap();
        replace_file(&path, b"second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert!(!path.with_extension("tmp").exists());
        assert!(!path.with_extension("bak").exists());
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(dir);
    }

    #[test]
    fn daily_report_summarizes_actual_time_by_category() {
        let day = json!({
            "08:00": { "actual": { "cat": "ontario_sales", "text": "Calls" } },
            "08:15": { "actual": { "cat": "ontario_sales", "text": "Calls" } },
            "08:30": { "planned": { "cat": "ontario_sales", "text": "Calls" } },
            "08:45": { "actual": { "cat": "montreal_sales", "text": "Calls" } }
        });
        let html = daily_report_to_html("2026-07-07", &day);
        assert!(html.contains("2026-07-07"));
        assert!(html.contains("0.8h"));
        assert!(html.contains("Time by category"));
        assert!(!html.contains("Ontario CRM calls"));
        let counts = daily_category_counts(&day);
        assert_eq!(counts.get("ontario_sales"), Some(&2));
        assert_eq!(counts.get("montreal_sales"), Some(&1));
    }

    #[test]
    fn daily_report_handles_zero_hours() {
        let html = daily_report_to_html("2026-07-07", &json!({}));
        assert!(html.contains("0.0h"));
        assert!(html.contains("No work logged."));
    }

    #[test]
    fn weekly_email_reports_only_actual_logged_time() {
        let range = json!({
            "2026-08-17": {
                "08:00": { "planned": { "cat": "ontario_sales", "text": "Calls" }, "actual": { "cat": "ontario_sales", "text": "Calls" } },
                "08:15": { "planned": { "cat": "ontario_sales", "text": "Calls" }, "actual": { "cat": "ontario_sales", "text": "Calls" } },
                "08:30": { "planned": { "cat": "ontario_sales", "text": "Calls" }, "actual": { "cat": "ontario_sales", "text": "Calls" } },
                "08:45": { "planned": { "cat": "ontario_sales", "text": "Calls" }, "actual": { "cat": "ontario_sales", "text": "Calls" } },
                "09:00": { "planned": { "cat": "meetings", "text": "Unlogged meeting" } }
            }
        });
        let html = weekly_report_to_html("2026-08-17", "2026-08-17", &range).unwrap();
        assert!(html.contains("Monday"));
        assert!(html.contains("Actual time by category"));
        assert!(html.contains("1.0h"));
        assert!(!html.contains("Unlogged meeting"));
        assert!(!html.contains("Sales planned"));
        assert!(!html.contains("Unaccounted"));
    }

    #[test]
    fn default_standard_week_is_valid() {
        assert!(validate_standard_plan(&default_standard_plan()).is_ok());
    }

    #[test]
    fn standard_week_accepts_additional_day_templates() {
        let mut config = default_standard_plan();
        config["templates"]["office"] = json!([]);
        config["templateNames"]["office"] = json!("Office day");
        config["week"]["fri"] = json!("office");
        assert!(validate_standard_plan(&config).is_ok());
    }

    #[test]
    fn standard_week_rejects_unknown_weekday_assignments() {
        let mut config = default_standard_plan();
        config["week"]["fri"] = json!("missing");
        assert!(validate_standard_plan(&config).is_err());
    }

    #[test]
    fn standard_week_rejects_overlapping_blocks() {
        let mut config = default_standard_plan();
        config["templates"]["ontario"][1]["start"] = json!("07:15");
        assert!(validate_standard_plan(&config).is_err());
    }
}
