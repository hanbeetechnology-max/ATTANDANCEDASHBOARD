import { useEffect, useMemo, useState } from 'react'
import { fetchAttendance } from './api'
import './App.css'

function todayISO() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

function formatTime12h(timeStr) {
  if (!timeStr) return null
  const [hours, minutes, seconds] = timeStr.split(':').map(Number)
  const period = hours >= 12 ? 'PM' : 'AM'
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  return `${hour12}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} ${period}`
}

function StatTile({ label, value, tone = 'neutral' }) {
  return (
    <div className={`stat-tile stat-tile--${tone}`}>
      <span className="stat-tile__value">{value}</span>
      <span className="stat-tile__label">{label}</span>
    </div>
  )
}

function StatusPill({ tone, children }) {
  return (
    <span className={`pill pill--${tone}`}>
      <span className="pill__dot" aria-hidden="true" />
      {children}
    </span>
  )
}

function EmployeeCard({ employee }) {
  const {
    name,
    status,
    checkIn,
    checkOut,
    late,
    leftEarly,
    incomplete,
    netHours,
    extraHours,
    breaks,
    unmatchedScans,
    scanCount,
  } = employee

  const isAbsent = status === 'Absent'

  return (
    <article className={`employee-card${isAbsent ? ' employee-card--absent' : ''}`}>
      <header className="employee-card__header">
        <h3>{name}</h3>
        <div className="employee-card__pills">
          <StatusPill tone={isAbsent ? 'critical' : 'good'}>{status}</StatusPill>
          {!isAbsent && late && <StatusPill tone="warning">Late arrival</StatusPill>}
          {!isAbsent && leftEarly && <StatusPill tone="warning">Left early</StatusPill>}
          {!isAbsent && incomplete && (
            <StatusPill tone="serious">Incomplete ({scanCount}/6 scans)</StatusPill>
          )}
        </div>
      </header>

      {isAbsent ? (
        <p className="employee-card__empty">No card scans recorded for this date.</p>
      ) : (
        <>
          <div className="employee-card__times">
            <div>
              <span className="label">Check-in</span>
              <span className="value">{formatTime12h(checkIn) ?? '—'}</span>
            </div>
            <div>
              <span className="label">Check-out</span>
              <span className="value">{formatTime12h(checkOut) ?? '—'}</span>
            </div>
          </div>

          <div className="employee-card__breaks">
            {breaks.length === 0 && <p className="muted">No break scans recorded.</p>}
            {breaks.map((brk) => (
              <div
                className={`break-row${brk.overLimit ? ' break-row--over' : ''}${brk.inProgress ? ' break-row--in-progress' : ''}`}
                key={`${brk.label}-${brk.out}`}
              >
                <span className="break-row__label">{brk.label}</span>
                <span className="break-row__times">
                  {brk.inProgress
                    ? `Out since ${formatTime12h(brk.out)}`
                    : `${formatTime12h(brk.out)} → ${formatTime12h(brk.in)}`}
                </span>
                <span className="break-row__duration">
                  {brk.inProgress
                    ? 'In progress'
                    : `${brk.durationMinutes} min${brk.overLimit ? ' (over limit)' : ''}`}
                </span>
              </div>
            ))}
            {unmatchedScans.map((scan) => (
              <div className="break-row break-row--unmatched" key={`unmatched-${scan}`}>
                <span className="break-row__label">Unmatched scan</span>
                <span className="break-row__times">{formatTime12h(scan)}</span>
              </div>
            ))}
          </div>

          <footer className="employee-card__footer">
            <div>
              <span className="label">Net hours worked</span>
              <span className="value">{netHours != null ? `${netHours}h` : '—'}</span>
            </div>
            <div>
              <span className="label">Extra hours</span>
              <span className={`value${extraHours ? ' value--highlight' : ''}`}>
                {extraHours ? `${extraHours}h` : '—'}
              </span>
            </div>
          </footer>
        </>
      )}
    </article>
  )
}

function App() {
  const [date, setDate] = useState(todayISO())
  const [refreshKey, setRefreshKey] = useState(0)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [slowLoading, setSlowLoading] = useState(false)

  useEffect(() => {
    if (!loading) {
      setSlowLoading(false)
      return
    }
    const timer = setTimeout(() => setSlowLoading(true), 4000)
    return () => clearTimeout(timer)
  }, [loading])

  useEffect(() => {
    let cancelled = false

    async function loadAttendance() {
      setLoading(true)
      setError(null)
      try {
        const result = await fetchAttendance(date)
        if (!cancelled) setData(result)
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadAttendance()

    return () => {
      cancelled = true
    }
  }, [date, refreshKey])

  const stats = useMemo(() => {
    const employees = data?.employees ?? []
    return {
      present: employees.filter((e) => e.status === 'Present').length,
      absent: employees.filter((e) => e.status === 'Absent').length,
      late: employees.filter((e) => e.late).length,
      incomplete: employees.filter((e) => e.status === 'Present' && e.incomplete).length,
      extraHours: employees.reduce((sum, e) => sum + (e.extraHours || 0), 0),
    }
  }, [data])

  const employees = data?.employees ?? []
  const hasNoRoster = !loading && employees.length === 0
  const hasNoRecordsForDate = !loading && employees.length > 0 && stats.present === 0

  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <div>
          <h1>Hanbee Attendance</h1>
          <p className="muted">Office hours 10:00 AM – 7:00 PM IST · Lunch 1h · Tea 30m</p>
        </div>
        <div className="dashboard__controls">
          <input
            type="date"
            value={date}
            max={todayISO()}
            onChange={(e) => setDate(e.target.value)}
          />
          <button type="button" onClick={() => setRefreshKey((k) => k + 1)}>
            Refresh
          </button>
        </div>
      </header>

      {error && <p className="dashboard__error">Couldn&apos;t load attendance: {error}</p>}

      {!error && (
        <>
          <section className="stat-grid">
            <StatTile label="Present" value={stats.present} tone="good" />
            <StatTile label="Absent" value={stats.absent} tone="critical" />
            <StatTile label="Late arrivals" value={stats.late} tone="warning" />
            <StatTile label="Incomplete scans" value={stats.incomplete} tone="serious" />
            <StatTile label="Total extra hours" value={stats.extraHours.toFixed(2)} tone="neutral" />
          </section>

          {loading && !data && (
            <p className="muted">
              {slowLoading
                ? 'Still loading — the backend may be waking up from sleep, this can take up to a minute.'
                : 'Loading attendance…'}
            </p>
          )}

          {hasNoRoster && (
            <p className="dashboard__notice">
              No employees found. Nobody has scanned a card yet.
            </p>
          )}

          {hasNoRecordsForDate && (
            <p className="dashboard__notice">
              No attendance records were stored for {date}. Everyone below is
              marked absent because there are no scans on file for this date.
            </p>
          )}

          <section className={`employee-grid${loading ? ' employee-grid--loading' : ''}`}>
            {employees.map((employee) => (
              <EmployeeCard employee={employee} key={employee.name} />
            ))}
          </section>
        </>
      )}
    </div>
  )
}

export default App
