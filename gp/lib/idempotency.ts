import { createAdminClient } from '@/lib/supabase/server'

// Idempotency-Key support for POST /api/v1/sub-users (table
// api_idempotency_keys, migration 0042). A client that times out and
// retries the same create used to get a SECOND credential and a second
// reservation of bandwidth. With a key, the retry returns the original
// response instead.
//
//   claim():    first caller wins an 'in_progress' row (insert, race-free
//               via the primary key); replays get the stored response.
//   complete(): stores the final status + body (only for outcomes worth
//               replaying — not 5xx, so a transient failure can be retried).
//   release():  drops the claim so a failed attempt can be retried.
//
// Same key + different body → 422 (a client bug, not a replay).
type Admin = Awaited<ReturnType<typeof createAdminClient>>

const IN_PROGRESS_STALE_MS = 2 * 60_000
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/

export function parseIdempotencyKey(req: Request): { ok: true; key: string | null } | { ok: false; error: string } {
  const raw = req.headers.get('idempotency-key')
  if (raw === null) return { ok: true, key: null }
  if (!KEY_RE.test(raw)) return { ok: false, error: 'Idempotency-Key must be 8–128 characters of A-Z a-z 0-9 _ - : .' }
  return { ok: true, key: raw }
}

async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type Claim =
  | { kind: 'proceed'; requestHash: string }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' }
  | { kind: 'in_flight' }

export async function claimIdempotencyKey(admin: Admin, userId: string, key: string, canonicalBody: string): Promise<Claim> {
  const requestHash = await sha256Hex(`POST /sub-users\n${canonicalBody}`)

  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await admin.from('api_idempotency_keys').insert({ user_id: userId, key, request_hash: requestHash })
    if (!error) return { kind: 'proceed', requestHash }
    if (error.code !== '23505') throw error // anything but "already exists" is unexpected

    const { data: row } = await admin
      .from('api_idempotency_keys').select('request_hash, status, response_status, response_body, created_at')
      .eq('user_id', userId).eq('key', key).maybeSingle()
    if (!row) continue // deleted between insert and read — try the claim again

    if (row.request_hash !== requestHash) return { kind: 'mismatch' }
    if (row.status === 'completed') return { kind: 'replay', status: row.response_status ?? 200, body: row.response_body }

    if (Date.now() - new Date(row.created_at).getTime() > IN_PROGRESS_STALE_MS) {
      // The original attempt died without completing — take over its claim.
      await admin.from('api_idempotency_keys').delete().eq('user_id', userId).eq('key', key).eq('status', 'in_progress')
      continue
    }
    return { kind: 'in_flight' }
  }
  return { kind: 'in_flight' }
}

export async function completeIdempotencyKey(admin: Admin, userId: string, key: string, status: number, body: unknown) {
  try {
    await admin.from('api_idempotency_keys')
      .update({ status: 'completed', response_status: status, response_body: body as any })
      .eq('user_id', userId).eq('key', key)
  } catch (e) {
    console.error('[idempotency] failed to store response', e)
  }
}

export async function releaseIdempotencyKey(admin: Admin, userId: string, key: string) {
  try {
    await admin.from('api_idempotency_keys').delete().eq('user_id', userId).eq('key', key)
  } catch (e) {
    console.error('[idempotency] failed to release claim', e)
  }
}
