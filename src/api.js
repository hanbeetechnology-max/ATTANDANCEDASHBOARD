const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'
// Render's free tier spins the backend down after ~15 min idle; waking it
// back up can take 30-60s, so the timeout has to tolerate a cold start.
const REQUEST_TIMEOUT_MS = 45000

export async function fetchAttendance(dateStr) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response
  try {
    response = await fetch(`${API_BASE_URL}/api/attendance?date=${dateStr}`, {
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Data stored timeout: the server took too long to respond.')
    }
    throw new Error('Could not reach the attendance server. Is the backend running?')
  } finally {
    clearTimeout(timeoutId)
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || `Request failed with status ${response.status}`)
  }

  return response.json()
}
