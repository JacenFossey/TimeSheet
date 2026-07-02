# Timesheet

A local desktop timesheet app built with Tauri v2 (native WebView2).

## Features

- 15-minute time slots from 4:30 AM – 10:30 PM
- Planned vs. actual tracking with colour-coded categories
- 15-minute popup reminders to log what you just did
- Stats dashboard (week / month / 3M / 6M / year / all-time)
- CSV and JSON export with custom date ranges
- Data stored locally as one JSON file per day under `%AppData%\Timesheet\days`
- Auto-updates from GitHub releases

## Development

Requires [Rust](https://rustup.rs) and the tauri CLI (`cargo install tauri-cli`).

```
cargo tauri dev
```

## Release

Bump `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then
push a matching `v*` tag — `.github/workflows/release.yml` builds the NSIS
installer, signs the updater artifacts, and publishes the GitHub release.
