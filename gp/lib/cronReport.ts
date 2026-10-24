// Pure (import-free) so it can be unit-tested with `node --test` — see tests/.

// Tasks report failures as `{ error: "…" }` somewhere in a 200 body. Returns the
// first one found in the first few levels, or null.
export function findReportedError(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 4) return null
  const v = value as Record<string, unknown>
  if (typeof v.error === 'string' && v.error) return v.error
  for (const k of Object.keys(v)) {
    const hit = findReportedError(v[k], depth + 1)
    if (hit) return hit
  }
  return null
}
