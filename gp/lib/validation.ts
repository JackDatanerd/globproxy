// Tiny strict-input helpers for API routes. Request bodies are attacker-
// controlled JSON: a field that "should" be a string can arrive as a number,
// object, array or null, and several routes used to call string methods on
// it (or embed it in HTML) before checking.

export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t.length > max) return null
  return t
}

export function cleanOptionalText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const t = cleanText(v, max)
  return t === null ? null : t // null => present but invalid
}

export function cleanNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
