# Timesheet

A local desktop timesheet app built with Electron and SQLite.

## Features

- 15-minute time slots from 4:30 AM – 10:30 PM
- Planned vs. actual tracking with colour-coded categories
- 15-minute popup reminders to log what you just did
- Stats dashboard (week / month / 3M / 6M / year / all-time)
- CSV and JSON export with custom date ranges
- Data stored locally in a SQLite database (`%AppData%\Timesheet\timesheet.db`)

## Setup

Requires [Node.js](https://nodejs.org) (v18+).

```
npm install
npm start
```

> `npm install` will automatically rebuild `better-sqlite3` against Electron's ABI via `@electron/rebuild`.
