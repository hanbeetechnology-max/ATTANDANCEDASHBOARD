# Attendance Dashboard API (Node)

A small read-only Express API that powers the HR dashboard. It's a JavaScript
port of the same attendance-summary logic used elsewhere in this project,
reading from the same `Hanbee_attendance` table the ESP32 writes to via the
existing Python backend — this service never writes anything, only reads.

Kept in its own subfolder on purpose: it has its own `package.json` and
dependencies (Express, mysql2) separate from the React app's, since Vite
would otherwise try to bundle this server code as browser JS. The Python
backend keeps handling ESP32 scan inserts untouched; this service exists
purely so the dashboard's data path can be JavaScript end-to-end.

## API

### `GET /api/attendance?date=YYYY-MM-DD`

Returns per-employee attendance for that date (IST), with check-in/out,
breaks (positional: 1st pair = lunch, 2nd pair = tea), in-progress breaks,
net/extra hours, and unmatched extra scans. Defaults to today (IST) if
`date` is omitted.

## Local setup

```bash
cd server
npm install
cp .env.example .env   # fill in your real Aiven credentials
npm start
```

Runs on `http://localhost:5000` by default (override with `PORT`).

## Deploying

Any Node host works (Render, Railway, Fly.io, etc.). On Render: **New → Web
Service**, connect this same repo, set **Root Directory** to `server` (since
this folder isn't the repo root), build command `npm install`, start command
`npm start`, and set the same environment variables from `.env.example`
(`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`) in the dashboard.

Once deployed, point the React app's `VITE_API_BASE_URL` (in the repo root's
`.env`) at this service's URL instead of the Python backend.
