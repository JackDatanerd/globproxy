// Shared by the newest-first, cursor-paged lists (webhook deliveries, API
// activity). The cursor is the last row's (created_at, id): paging on
// created_at alone skipped any rows that shared the boundary timestamp.
// `before` stays valid on its own (older clients); `before_id` makes it exact.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Timestamps are interpolated into a PostgREST or() expression, so they are
// matched against a strict shape first (no quotes, commas or parentheses).
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/

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
  if (Number.isNaN(Date.parse(before))) return { ok: false, message: 'before must be an ISO 8601 timestamp.' }
  if (!beforeId) return { ok: true, query: q.lt('created_at', before) }
  if (!TS_RE.test(before)) return { ok: false, message: 'before must be the next_before value from the previous page.' }
  const idOk = idKind === 'uuid' ? isUuidString(beforeId) : /^\d{1,18}$/.test(beforeId)
  if (!idOk) return { ok: false, message: 'before_id must be the next_before_id value from the previous page.' }
  return { ok: true, query: q.or(`created_at.lt."${before}",and(created_at.eq."${before}",id.lt.${beforeId})`) }
}
