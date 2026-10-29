import { NextResponse } from 'next/server'
import { internalLockKey } from '@/lib/lockKeys'
import type { createAdminClient } from '@/lib/supabase/server'
import { claimIdempotencyKey, releaseIdempotencyKey } from '@/lib/idempotency'
import {
  listWhitelistedIps, bulkAddWhitelistedIps, subUserExists, isUpstreamNotFound, MAX_BULK_ITEMS, whitelistErrorResponse,
} from '@/lib/ipWhitelist'

type WhitelistedIp = { ip: string; description?: string }

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// A local copy of every session's IP whitelist (proxy_whitelist_entries, migration 0079).
// The whitelist used to live ONLY at the supplier, so a session that had to be re-created
// (its sub-user vanished upstream) came back with an empty list — i.e. less restricted than
// the customer had set it — and nobody was told. The mirror is rewritten from the
// supplier's own answer after every successful change, so it never drifts by construction:
// every write returns the full resulting list.

// Replaces the mirror for one session with `ips` (the authoritative list). Never throws —
// a failed mirror only means the backfill will redo it.
//
// `upstreamSubUserId` makes the copy order-safe. Two edits finishing close together each hold the
// full list as THEIR upstream call returned it; written in the other order than they happened,
// the older list wins and the mirror keeps an IP the customer had removed — which a later
// re-provision would put back. With the id, mirror writes for one session are serialized and each
// re-reads the supplier's current list under that lock, so the last write always reflects the
// state after every edit that finished before it. Without it (or if the re-read fails) the list
// passed in is written as before.
export async function mirrorWhitelist(admin: Admin, credentialId: string, userId: string, ips: WhitelistedIp[], upstreamSubUserId?: string | null): Promise<void> {
  const lockKey = internalLockKey('whitelist-mirror', credentialId)
  let claimed = false
  if (upstreamSubUserId) {
    for (let attempt = 0; attempt < 4 && !claimed; attempt++) {
      try {
        const claim = await claimIdempotencyKey(admin, userId, lockKey, '', 'whitelist-mirror')
        if (claim.kind === 'proceed') { claimed = true; break }
      } catch (e) { console.error('[whitelist-mirror] lock unavailable — writing without it', credentialId, e); break }
      await new Promise((r) => setTimeout(r, 200))
    }
    if (claimed) {
      try { ips = await listWhitelistedIps(upstreamSubUserId) } catch (e) {
        console.error('[whitelist-mirror] fresh read failed — mirroring the list from the change', credentialId, e)
      }
    }
  }
  try {
    await writeMirror(admin, credentialId, userId, ips)
  } finally {
    if (claimed) await releaseIdempotencyKey(admin, userId, lockKey)
  }
}

async function writeMirror(admin: Admin, credentialId: string, userId: string, ips: WhitelistedIp[]): Promise<void> {
  try {
    const rows = ips.slice(0, 1000).map((i) => ({
      credential_id: credentialId, user_id: userId, ip: i.ip, description: (i.description ?? '').slice(0, 100),
    }))
    // One transaction (delete + insert), so concurrent edits can't interleave into a
    // half-old/half-new mirror.
    const { error } = await admin.rpc('replace_whitelist_mirror', {
      p_credential_id: credentialId, p_user_id: userId, p_entries: rows.map(({ ip, description }) => ({ ip, description })),
    })
    if (error) throw error
    await admin.from('proxy_credentials').update({ whitelist_mirrored_at: new Date().toISOString() }).eq('id', credentialId)
  } catch (e) {
    console.error('[whitelist-mirror] could not mirror', credentialId, e)
    // Leave whitelist_mirrored_at as it was; if it was current it is now stale, so clear it
    // and the backfill rebuilds the copy from the supplier.
    await admin.from('proxy_credentials').update({ whitelist_mirrored_at: null }).eq('id', credentialId)
      .then(() => undefined, () => undefined)
  }
}

// Puts the mirrored entries onto a freshly created sub-user. Only called for a session that
// was just (re)activated. No-op when nothing is mirrored.
export async function replayWhitelist(admin: Admin, credentialId: string, upstreamSubUserId: string): Promise<number> {
  const { data: entries, error } = await admin
    .from('proxy_whitelist_entries').select('ip, description').eq('credential_id', credentialId).order('created_at')
  if (error) throw error
  if (!entries?.length) return 0
  // Only what the sub-user does not already have: a retry after a partly applied replay must not
  // re-add (and fail on) entries that landed the first time.
  const present = new Set((await listWhitelistedIps(upstreamSubUserId)).map((i: WhitelistedIp) => i.ip))
  const todo = entries.filter((e: any) => !present.has(e.ip))
  let restored = 0
  for (let i = 0; i < todo.length; i += MAX_BULK_ITEMS) {
    const chunk = todo.slice(i, i + MAX_BULK_ITEMS).map((e: any) => ({ ip: e.ip, description: e.description || 'Restored' }))
    await bulkAddWhitelistedIps(upstreamSubUserId, chunk)
    restored += chunk.length
  }
  return restored
}

// Cron batches used to take the oldest `limit` rows every run, so rows that fail every time (the
// supplier keeps erroring for them) filled the batch forever and starved everything behind them.
// Read a wider window and start from a different place each tick.
function rotatedBatch<T>(rows: T[] | null, limit: number): T[] {
  const w = rows ?? []
  if (w.length <= limit) return w
  const off = Math.floor(Date.now() / 300_000) % w.length
  return w.slice(off).concat(w.slice(0, off)).slice(0, limit)
}

// Cron: sessions whose whitelist replay failed at provisioning (proxy_credentials.whitelist_replay_pending).
// Retried until it lands; a sub-user missing upstream is left to the usage sync's handling.
export async function retryPendingWhitelistReplays(admin: Admin, limit = 15): Promise<{ checked: number; restored: number }> {
  const { data: rows, error } = await admin
    .from('proxy_credentials').select('id, upstream_sub_user_id')
    .eq('status', 'active').eq('whitelist_replay_pending', true).not('upstream_sub_user_id', 'is', null)
    .order('created_at').limit(limit * 8)
  if (error) { console.error('[whitelist-mirror] replay retry read failed', error); return { checked: 0, restored: 0 } }
  const batch = rotatedBatch(rows, limit)
  let restored = 0
  for (const r of batch) {
    try {
      await replayWhitelist(admin, r.id, r.upstream_sub_user_id)
      await admin.from('proxy_credentials').update({ whitelist_replay_pending: false }).eq('id', r.id)
      restored++
    } catch (e) {
      if (!isUpstreamNotFound(e)) console.error('[whitelist-mirror] replay retry failed', r.id, e)
    }
  }
  return { checked: batch.length, restored }
}

// Cron backfill: sessions created before the mirror existed (or whose mirror failed) have
// whitelist_mirrored_at NULL. Bounded per run; the partial index keeps the scan cheap.
export async function backfillWhitelistMirrors(admin: Admin, limit = 15): Promise<{ checked: number; mirrored: number }> {
  const { data: rows, error } = await admin
    .from('proxy_credentials').select('id, user_id, upstream_sub_user_id')
    .eq('status', 'active').is('whitelist_mirrored_at', null).not('upstream_sub_user_id', 'is', null)
    .order('created_at').limit(limit * 8)
  if (error) { console.error('[whitelist-mirror] backfill read failed', error); return { checked: 0, mirrored: 0 } }
  const batch = rotatedBatch(rows, limit)
  let mirrored = 0
  for (const r of batch) {
    try {
      const ips = await listWhitelistedIps(r.upstream_sub_user_id)
      await mirrorWhitelist(admin, r.id, r.user_id, ips, r.upstream_sub_user_id)
      mirrored++
    } catch (e) {
      // 404 = sub-user missing upstream: the usage sync's missing-sub-user handling owns that.
      if (!isUpstreamNotFound(e)) console.error('[whitelist-mirror] backfill failed', r.id, e)
    }
  }
  return { checked: batch.length, mirrored }
}

// A supplier 404 on a whitelist call can mean "that IP isn't listed" OR "this session's
// proxy no longer exists upstream". The second used to be reported as the first. Ask once.
export async function whitelistFailure(e: unknown, upstreamSubUserId: string): Promise<NextResponse> {
  if (upstreamSubUserId && isUpstreamNotFound(e)) {
    const exists = await subUserExists(upstreamSubUserId).catch(() => true)
    if (!exists) {
      console.error('[whitelist] sub-user missing upstream', upstreamSubUserId)
      return NextResponse.json({
        error: 'This session’s proxy is being restored, so its whitelist can’t be changed right now. Please try again shortly or contact support.',
        code: 'conflict',
      }, { status: 409 })
    }
  }
  return whitelistErrorResponse(e)
}
