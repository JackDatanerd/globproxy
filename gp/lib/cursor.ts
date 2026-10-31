// Shared by the newest-first, cursor-paged lists (webhook deliveries, API
// activity). The cursor is the last row's (created_at, id): paging on
// created_at alone skipped any rows that shared the boundary timestamp.
// `before` stays valid on its own (older clients); `before_id` makes it exact.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Timestamps are interpolated into a PostgREST or() expression, so they are
// matched against a strict shape first (no quotes, commas or parentheses).
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/

// A calendar-valid ISO 8601 date, optionally followed by a time and a UTC offset. (Plain
// Date.parse reads "2026-02-30" as March 2nd; Postgres rejects it.)
export function isIsoTimestamp(v: string): boolean {
  const m = ISO_RE.exec(v)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return false
  const time = /[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(v)
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] ?? 0) > 59)) return false
  // A UTC offset must be a real one. Postgres refuses a displacement beyond +/-15:59 ("time zone
  // displacement out of range"), which used to surface as a 500 for e.g. "...T10:00:00+25:00".
  // Real offsets stop at +14:00 / -12:00, so +/-14:00 is the ceiling here. (Searching only the part
  // after the time keeps the "-23" of a date-only value from being read as an offset.)
  const off = /[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?([+-])(\d{2})(?::?(\d{2}))?$/.exec(v)
  if (off) {
    const h = Number(off[2]), m = Number(off[3] ?? 0)
    if (m > 59 || h > 14 || (h === 14 && m > 0)) return false
  }
  return true
}

// A validated ISO 8601 value as a canonical UTC ISO string, or null when it is not a real ISO date.
// Date.parse alone reads "1" as 2001-01-01, "2026" as 1 Jan 2026 and "2026-02-30" as 2 March, and
// treats an offset-less date-time as server-local time. Here a value without an offset is UTC.
export function isoToUtcString(v: string): string | null {
  if (!isIsoTimestamp(v)) return null
  let s = v.replace(' ', 'T')
  const hasTime = s.includes('T')
  if (hasTime) {
    // "+0100" -> "+01:00" so every engine parses it the same way
    s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/([+-]\d{2})$/, '$1:00')
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(s)) s += 'Z'
  }
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export const isUuidString = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

// A cursor timestamp as it should be HANDED OUT. PostgREST returns timestamptz as
// "2026-10-23T10:00:00.123456+00:00"; that "+" turns into a space when a client
// pastes the value into a query string without URL-encoding it (curl, shell
// scripts), and the next page then failed with a 400. UTC is rewritten to the
// equivalent "Z" form, which needs no encoding and keeps the microseconds the
// (created_at, id) tie-break depends on. A non-UTC offset is left untouched.
export function cursorTs<T extends string | null | undefined>(ts: T): T {
  if (typeof ts !== 'string') return ts
  return ts.replace(/([T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)(?:\+00(?::?00)?)$/, '$1Z') as T
}

// The reverse repair for a cursor that DID arrive mangled ("+00:00" -> " 00:00"):
// only the exact shape produced by a decoded "+" is repaired, so nothing else can
// slip into the or() expression below.
function repairCursorTs(v: string): string {
  return v.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?) (\d{2}(?::?\d{2})?)$/, '$1+$2')
}

export type CursorResult<Q> = { ok: true; query: Q } | { ok: false; message: string }

// `idKind`: 'uuid' (webhook_deliveries) or 'int' (api_request_log.id is bigserial).
export function applyCursor<Q extends { lt: (c: string, v: string) => Q; or: (f: string) => Q }>(
  q: Q, before: string | null | undefined, beforeId: string | null | undefined, idKind: 'uuid' | 'int'
): CursorResult<Q> {
  if (!before) return { ok: true, query: q }
  before = repairCursorTs(before)
  // Date.parse alone is far too lenient for a value that is handed to Postgres as a timestamptz
  // literal: it accepts "1", "5", "2026", "0" and "2026-02-30", which Postgres refuses — and that
  // used to come back as a 500. Anything that is not a real ISO 8601 date (optionally with a time)
  // is a 400 here instead.
  if (!isIsoTimestamp(before)) return { ok: false, message: 'before must be an ISO 8601 timestamp.' }
  if (!beforeId) return { ok: true, query: q.lt('created_at', before) }
  if (!TS_RE.test(before)) return { ok: false, message: 'before must be the next_before value from the previous page.' }
  const idOk = idKind === 'uuid' ? isUuidString(beforeId) : /^\d{1,18}$/.test(beforeId)
  if (!idOk) return { ok: false, message: 'before_id must be the next_before_id value from the previous page.' }
  return { ok: true, query: q.or(`created_at.lt."${before}",and(created_at.eq."${before}",id.lt.${beforeId})`) }
}
