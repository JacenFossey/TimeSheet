# Timesheet

A local desktop timesheet app built with Tauri v2 (native WebView2).

## Features

- Focus view showing what to do now, what just finished, and today's progress
- One-click standard workweek plan (Ontario sales, Wednesday Montreal/Flex)
- Larger planned work blocks backed by editable 15-minute detail slots
- One-click “Same as planned” logging plus optional category and note overrides
- 15-minute time slots from 4:30 AM – 10:30 PM
- Planned vs. actual tracking with colour-coded categories
- 15-minute popup reminders to log what you just did
- Stats dashboard (week / month / 3M / 6M / year / all-time)
- CSV and JSON export with custom date ranges
- Data stored locally as one JSON file per day under `%AppData%\Timesheet\days`
- Auto-updates from GitHub releases

The first-run theme is light mode; dark mode remains available from the toolbar.

## Development

Requires [Rust](https://rustup.rs) and the tauri CLI (`cargo install tauri-cli`).

```
cargo tauri dev
```

## Release

Bump `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then
push a matching `v*` tag — `.github/workflows/release.yml` builds the NSIS
installer, signs the updater artifacts, and publishes the GitHub release.
