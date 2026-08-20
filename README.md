# Timesheet

A local desktop timesheet app built with Tauri v2 (native WebView2).

## Features

- Focus view showing the current work block and today's progress
- One-click standard workweek plan (Ontario sales, Wednesday Montreal/Flex)
- Editable Ontario and Montreal/Flex templates with weekday assignments
- Full-block plan editing with no timeline or reporting clutter
- One-click “Log as planned” for entire work blocks, plus simple corrections
- Planned vs. actual tracking backed by compatible 15-minute data
- 15-minute popup reminders to log what you just did
- Concise weekly report with daily and category totals
- One-click daily manager email reporting Ontario CRM call time
- One-click CSV export for the selected week
- Weekly report email through SendGrid
- Data stored locally as one JSON file per day under `%AppData%\Timesheet\days`
- Auto-updates from GitHub releases

The app uses a single calm, light interface designed around planning, doing, and reporting.

## Development

Requires [Rust](https://rustup.rs) and the tauri CLI (`cargo install tauri-cli`).

```
cargo tauri dev
```

## Release

Bump `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, then
push a matching `v*` tag — `.github/workflows/release.yml` builds the NSIS
installer, signs the updater artifacts, and publishes the GitHub release.
