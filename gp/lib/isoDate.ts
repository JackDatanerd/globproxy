// Real calendar-date check for YYYY-MM-DD strings (the regex alone lets 2026-13-45 through, and
// Date.parse alone accepts 2026-02-31).
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}
