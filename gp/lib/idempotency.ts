import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { apiError } from '@/lib/apiAuth'

// Idempotency-Key support for the v1 endpoints that spend or move bandwidth
// (table api_idempotency_keys, migration 0042): create sub-user, top-up, bulk
// create/top-up, allocate, reclaim. A client that times out and retries used
// to get a SECOND credential / top-up / transfer. With a key, the retry
// returns the original response instead.
//
// Stale claims: if the first attempt died without recording a response, a
// retry after IN_PROGRESS_STALE_MS may "take over" and run again — but ONLY for
// operations that are safe to repeat (create sub-user: the unique
// (user_id, idempotency_key) index on proxy_credentials makes a double create
// impossible). Money-moving operations pass allowStaleTakeover:false and the
// caller gets a 409 telling them to check state instead: re-running an
// attempt whose outcome is unknown is how a top-up gets applied twice.
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
// How long a key is remembered (lib/webhooks.ts pruneIntegrationData deletes claims older than this).
// Anything stored against a key elsewhere (proxy_credentials.idempotency_key) must lapse with it.
export const IDEMPOTENCY_WINDOW_MS = 24 * 3_600_000
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
  | { kind: 'unknown_outcome' }

export async function claimIdempotencyKey(
  admin: Admin, userId: string, key: string, canonicalBody: string,
  scope = 'POST /sub-users', opts: { allowStaleTakeover?: boolean } = {}
): Promise<Claim> {
  const allowStaleTakeover = opts.allowStaleTakeover ?? true
  // The scope is part of the hash: the same key reused on a DIFFERENT endpoint
  // is a client bug (422), not a replay of the first call's response.
  const requestHash = await sha256Hex(`${scope}\n${canonicalBody}`)

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
      // Unsafe to repeat: the first attempt may have committed before dying.
      if (!allowStaleTakeover) return { kind: 'unknown_outcome' }
      // The original attempt died without completing — take over its claim.
      // Delete exactly THE stale row (matched on created_at). Without that, two retries
      // racing here could have the slower one delete the faster one's FRESH claim, and
      // both would then run the operation.
      await admin.from('api_idempotency_keys').delete().eq('user_id', userId).eq('key', key).eq('status', 'in_progress').eq('created_at', row.created_at)
      continue
    }
    return { kind: 'in_flight' }
  }
  return { kind: 'in_flight' }
}

// supabase-js returns { error } instead of throwing, so these used to swallow a
// failed write without a trace: a completed money operation whose response was
// never stored then answered 409 "unknown outcome" on every retry, with nothing in
// the logs to say why. Each write is checked, retried once, and logged.
async function writeWithOneRetry(label: string, run: () => PromiseLike<{ error: { message: string } | null }>) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await run()
      if (!error) return true
      console.error(`[idempotency] ${label} failed`, attempt === 0 ? '(retrying)' : '(giving up)', error.message)
    } catch (e) {
      console.error(`[idempotency] ${label} threw`, e)
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

export async function completeIdempotencyKey(admin: Admin, userId: string, key: string, status: number, body: unknown) {
  await writeWithOneRetry('store response', () =>
    admin.from('api_idempotency_keys')
      .update({ status: 'completed', response_status: status, response_body: body as any })
      .eq('user_id', userId).eq('key', key))
}

export async function releaseIdempotencyKey(admin: Admin, userId: string, key: string) {
  await writeWithOneRetry('release claim', () =>
    admin.from('api_idempotency_keys').delete().eq('user_id', userId).eq('key', key))
}

// Per-item idempotency for the bulk endpoints. The outer Idempotency-Key only
// guards the request as a whole; each item additionally claims "<key>#<i>" so a
// retry after a PARTIAL failure re-runs just the items that did not succeed and
// replays the ones that did (a top-up is never applied twice). Only 2xx outcomes
// are kept; anything else frees the item's claim so it can be retried. A claim
// whose outcome is unknown (the worker died mid-item) is never re-run — the item
// answers 409 and the caller checks the sub-user's balance.
export type ItemOutcome = { status: number; body: Record<string, unknown> }

export async function runItemOnce(
  admin: Admin, userId: string, itemKey: string, scope: string, canonical: string,
  run: () => Promise<ItemOutcome>
): Promise<ItemOutcome> {
  const claim = await claimIdempotencyKey(admin, userId, itemKey, canonical, scope, { allowStaleTakeover: false })
  if (claim.kind === 'replay') return { status: claim.status, body: (claim.body ?? {}) as Record<string, unknown> }
  if (claim.kind === 'mismatch') {
    return { status: 422, body: { error: { code: 'idempotency_conflict', message: 'This item was already processed under this Idempotency-Key with different values. Use a new Idempotency-Key for a changed request.' } } }
  }
  if (claim.kind === 'in_flight') {
    return { status: 409, body: { error: { code: 'conflict', message: 'This item is still being processed. Retry shortly.' } } }
  }
  if (claim.kind === 'unknown_outcome') {
    return { status: 409, body: { error: { code: 'conflict', message: 'An earlier attempt at this item did not finish and its outcome is unknown. Check the sub-user\u2019s current balance before retrying with a NEW Idempotency-Key.' } } }
  }
  const out = await run()
  if (out.status >= 200 && out.status < 300) await completeIdempotencyKey(admin, userId, itemKey, out.status, out.body)
  else await releaseIdempotencyKey(admin, userId, itemKey)
  return out
}

export type IdempotentOutcome =
  | { kind: 'ok'; status: number; body: unknown }           // replayable success — stored under the key
  | { kind: 'fail'; response: Response }                    // not replayable — key released, client may retry

// Wraps a mutating handler in the claim → run → store/release dance so every
// endpoint does it identically. No Idempotency-Key header = just run it.
// If `exec` THROWS the claim is deliberately left in place (outcome unknown);
// withApiAuth turns the throw into a 500.
export async function runIdempotent(
  req: Request, admin: Admin, userId: string, scope: string, canonicalBody: string,
  exec: (key: string | null) => Promise<IdempotentOutcome>,
  // onReplay: lets an endpoint whose stored answer can go stale (a checkout link that a
  // later purchase has retired) refresh that answer before it is replayed.
  opts: { allowStaleTakeover?: boolean; successStatus?: number; onReplay?: (body: unknown) => Promise<unknown> } = {}
): Promise<Response> {
  const idem = parseIdempotencyKey(req)
  if (!idem.ok) return apiError(400, 'invalid_request', idem.error)

  if (idem.key) {
    const claim = await claimIdempotencyKey(admin, userId, idem.key, canonicalBody, scope, { allowStaleTakeover: opts.allowStaleTakeover })
    if (claim.kind === 'replay') {
      let replayBody = claim.body
      if (opts.onReplay) {
        try { replayBody = await opts.onReplay(claim.body) } catch (e) { console.error('[idempotency] onReplay failed — replaying the stored body', e) }
      }
      return NextResponse.json(replayBody, { status: claim.status, headers: { 'Idempotent-Replayed': 'true' } })
    }
    if (claim.kind === 'mismatch') {
      return apiError(422, 'idempotency_conflict', 'This Idempotency-Key was already used with a different request.')
    }
    if (claim.kind === 'in_flight') {
      return apiError(409, 'conflict', 'A request with this Idempotency-Key is still being processed. Retry shortly.', { 'Retry-After': '2' })
    }
    if (claim.kind === 'unknown_outcome') {
      return apiError(409, 'conflict', 'An earlier request with this Idempotency-Key did not finish and its outcome is unknown. Check the resource\u2019s current state before retrying with a NEW Idempotency-Key.')
    }
  }

  const outcome = await exec(idem.key)
  if (outcome.kind === 'fail') {
    // Failures are not replayable — free the key so the client can retry
    // (e.g. after buying bandwidth following a 402).
    if (idem.key) await releaseIdempotencyKey(admin, userId, idem.key)
    return outcome.response
  }
  if (idem.key) await completeIdempotencyKey(admin, userId, idem.key, outcome.status, outcome.body)
  return NextResponse.json(outcome.body, { status: outcome.status })
}
