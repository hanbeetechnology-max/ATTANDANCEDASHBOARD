require('dotenv/config');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());

// Office runs on IST (UTC+5:30), but Aiven's server clock and the ESP32's
// CURDATE()/CURTIME() writes are both UTC. Every stored date/time has to be
// shifted forward by this much before it means anything to an HR person.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const OFFICE_START_SEC = 10 * 3600; // 10:00 AM IST
const OFFICE_END_SEC = 19 * 3600; // 7:00 PM IST
const LUNCH_TARGET_SEC = 60 * 60;
const TEA_TARGET_SEC = 30 * 60;

// Fixed scan sequence for one employee's day: 1st = check-in, 2nd/3rd = lunch
// out/in, 4th/5th = tea out/in, 6th = check-out. Every scan's meaning is
// determined by its position in the day's sequence so far, not by whether
// it happens to be the last scan seen - a half-finished day (e.g. only 3
// scans in: check-in, lunch-out, lunch-in) must not be misread as "checked
// out" just because scan #3 is currently the last one on record.
const BREAK_SEQUENCE = [
  { label: 'Lunch Break', outIdx: 1, inIdx: 2, targetSec: LUNCH_TARGET_SEC },
  { label: 'Tea Break', outIdx: 3, inIdx: 4, targetSec: TEA_TARGET_SEC },
];
const CHECK_OUT_INDEX = 5;

function pad(n) {
  return String(n).padStart(2, '0');
}

function parseTimeToSeconds(value) {
  const [h, m, s] = String(value).split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function formatSeconds(totalSeconds) {
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function buildEmployeeSummary(name, scanSeconds) {
  const scanCount = scanSeconds.length;

  const record = {
    name,
    status: scanCount ? 'Present' : 'Absent',
    scanCount,
    incomplete: scanCount !== 6,
    checkIn: null,
    checkOut: null,
    late: false,
    leftEarly: false,
    grossHours: null,
    netHours: null,
    extraHours: null,
    totalBreakMinutes: 0,
    breaks: [],
    unmatchedScans: [],
  };

  if (scanCount === 0) return record;

  const checkInSec = scanSeconds[0];
  record.checkIn = formatSeconds(checkInSec);
  record.late = checkInSec > OFFICE_START_SEC;

  // Each break only appears once BOTH its out and in scans have actually
  // happened; if only the out-scan has happened so far, it's in-progress
  // (no in time / duration yet) instead of being dropped or misread.
  let totalBreakSeconds = 0;
  for (const { label, outIdx, inIdx, targetSec } of BREAK_SEQUENCE) {
    if (scanCount > inIdx) {
      const outSec = scanSeconds[outIdx];
      const inSec = scanSeconds[inIdx];
      const duration = Math.max(0, inSec - outSec);
      totalBreakSeconds += duration;
      record.breaks.push({
        label,
        out: formatSeconds(outSec),
        in: formatSeconds(inSec),
        durationMinutes: Math.round(duration / 60),
        overLimit: duration > targetSec,
        inProgress: false,
      });
    } else if (scanCount === outIdx + 1) {
      record.breaks.push({
        label,
        out: formatSeconds(scanSeconds[outIdx]),
        in: null,
        durationMinutes: null,
        overLimit: false,
        inProgress: true,
      });
    }
  }

  record.totalBreakMinutes = Math.round(totalBreakSeconds / 60);

  // Check-out - and anything derived from it - only exists once the 6th
  // scan has actually happened, not just because a scan happens to be last.
  if (scanCount > CHECK_OUT_INDEX) {
    const checkOutSec = scanSeconds[CHECK_OUT_INDEX];
    record.checkOut = formatSeconds(checkOutSec);
    record.leftEarly = checkOutSec < OFFICE_END_SEC;

    const grossSeconds = checkOutSec - checkInSec;
    record.grossHours = round2(grossSeconds / 3600);
    record.netHours = round2(record.grossHours - totalBreakSeconds / 3600);

    if (checkOutSec > OFFICE_END_SEC) {
      record.extraHours = round2((checkOutSec - OFFICE_END_SEC) / 3600);
    }
  }

  // Scans past the expected 6 are unplanned extras.
  if (scanCount > CHECK_OUT_INDEX + 1) {
    record.unmatchedScans = scanSeconds.slice(CHECK_OUT_INDEX + 1).map(formatSeconds);
  }

  return record;
}

function addDaysUtc(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
    ssl: { rejectUnauthorized: false },
    connectTimeout: 8000,
    dateStrings: true, // DATE/DATETIME columns come back as plain 'YYYY-MM-DD' strings, not JS Date objects in local time
  });
}

app.get('/api/attendance', async (req, res) => {
  const dateParam = req.query.date;
  let targetDate;

  if (dateParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
    }
    targetDate = dateParam;
  } else {
    // "Today" also has to account for the UTC/IST gap - it's already
    // tomorrow in UTC for the last 5:30 hours of the IST day.
    targetDate = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  }

  // Rows are stored against Aiven's UTC clock. A scan at, say, 23:15 UTC is
  // actually 04:45 IST the *next* day, so the previous UTC date can contain
  // rows that belong to today in IST - fetch both and filter after converting.
  const prevDate = addDaysUtc(targetDate, -1);

  let connection;
  try {
    connection = await getConnection();

    // The roster isn't stored anywhere - it's inferred from everyone who
    // has ever scanned a card, so new employees show up automatically.
    const [rosterRows] = await connection.query('SELECT DISTINCT Name FROM Hanbee_attendance');
    const roster = rosterRows.map((r) => r.Name);

    const [rows] = await connection.query(
      'SELECT Name, `date`, `time` FROM Hanbee_attendance WHERE `date` IN (?, ?) ORDER BY Name, `date`, `time`',
      [prevDate, targetDate]
    );

    await connection.end();

    const scansByEmployee = new Map(roster.map((name) => [name, []]));
    for (const row of rows) {
      const timeSeconds = parseTimeToSeconds(row.time);
      const utcMs = Date.parse(`${row.date}T00:00:00Z`) + timeSeconds * 1000;
      const istMs = utcMs + IST_OFFSET_MS;
      const istDateStr = new Date(istMs).toISOString().slice(0, 10);
      if (istDateStr !== targetDate) continue; // belongs to the adjacent IST day

      const istSecondsOfDay = Math.round((istMs - Date.parse(`${istDateStr}T00:00:00Z`)) / 1000);
      if (!scansByEmployee.has(row.Name)) scansByEmployee.set(row.Name, []);
      scansByEmployee.get(row.Name).push(istSecondsOfDay);
    }

    const employees = [...scansByEmployee.entries()]
      .map(([name, secondsList]) =>
        buildEmployeeSummary(
          name,
          [...secondsList].sort((a, b) => a - b)
        )
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ date: targetDate, employees });
  } catch (err) {
    if (connection) {
      try {
        await connection.end();
      } catch {
        // already closed / never opened
      }
    }
    console.error('Database error:', err);
    const message = String(err && err.message ? err.message : err).toLowerCase();
    if (message.includes('timeout') || message.includes('timed out')) {
      return res.status(504).json({ error: 'Database request timed out. Please try again.' });
    }
    return res.status(500).json({ error: 'Database error. Please try again later.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Attendance dashboard API listening on port ${PORT}`);
});
