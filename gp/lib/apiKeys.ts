import { createAdminClient } from '@/lib/supabase/server'
import { parseAllowedIps, allocateAllowlistProblem } from '@/lib/ipAllowlist'
import { dispatchWebhook, dispatchWebhookBatch } from '@/lib/webhooks'
import { logSecurityEvent, requestMeta } from '@/lib/securityEvents'
import { isUuidString } from '@/lib/cursor'

// API-key management shared by /api/dashboard/api-keys/* (session auth + step-up).
// Keys authenticate /api/v1/* (lib/apiAuth.ts); this file only creates, edits,
// rotates and revokes them.
type Admin = Awaited<ReturnType<typeof createAdminClient>>

export const KEY_PREFIX = 'gp_live_'
export const EXPIRY_CHOICES_DAYS = [30, 90, 180, 365]
export const MAX_ROTATION_GRACE_HOURS = 72
export const KEY_VIEW_COLS = 'id, key_prefix, label, scopes, allowed_ips, expires_at, created_at, last_used_at, last_used_ip, revoked_at'

export type KeyError = { ok: false; status: number; message: string; code?: string }
export type KeyResult<T> = { ok: true; data: T } | KeyError
const fail = (status: number, message: string, code?: string): KeyError => ({ ok: false, status, message, code })

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `${KEY_PREFIX}${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function cleanLabel(v: unknown, fallback = 'Default key'): string {
  // eslint-disable-next-line no-control-regex
  return (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '').slice(0, 60) || fallback
}

// 'write' implies 'read'; 'allocate' (move bandwidth between accounts) is its
// own grant and, because API keys skip the dashboard's 2FA step-up, is only
// ever valid together with a source-IP allowlist (checked by the callers).
export function parseScopes(input: unknown, opts: { canAllocate: boolean }): { ok: true; value: string[] } | { ok: false; error: string } {
  const hint = 'scopes must be a non-empty array of "read", "write" and (resellers only) "allocate".'
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: hint }
  const set = new Set(input)
  if (![...set].every((x) => x === 'read' || x === 'write' || x === 'allocate')) return { ok: false, error: hint }
  if (set.has('allocate') && !opts.canAllocate) return { ok: false, error: 'The "allocate" scope is only available to reseller accounts.' }
  const out: string[] = ['read']
  if (set.has('write')) out.push('write')
  if (set.has('allocate')) out.push('allocate')
  return { ok: true, value: out }
}

export function parseExpiryDays(v: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: null }
  if (!EXPIRY_CHOICES_DAYS.includes(Number(v))) {
    return { ok: false, error: `expires_in_days must be one of: ${EXPIRY_CHOICES_DAYS.join(', ')} (or omit for no expiry).` }
  }
  return { ok: true, value: new Date(Date.now() + Number(v) * 86_400_000).toISOString() }
}

// null = no such profile OR the lookup failed; callers treat both as "cannot verify" (fail closed).
export async function loadKeyOwner(admin: Admin, userId: string) {
  const { data, error } = await admin.from('profiles').select('role, api_access, is_suspended, is_deleted').eq('id', userId).maybeSingle()
  if (error) console.error('[api-keys] owner lookup failed', error.message)
  return error ? null : data
}

// A rotation grace period from a request body: absent / null = the default; anything but a
// number is NaN (the rotate functions answer 400). Number(null) and Number('') are both 0 —
// which used to kill the old key or secret on the spot for a client that sent null or "".
export function graceInput(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback
  return typeof v === 'number' ? v : NaN
}

export const canUseApi = (p: { role?: string | null; api_access?: boolean | null } | null) =>
  !!p && p.role !== 'user' && (!!p.api_access || p.role === 'admin')
export const canAllocate = (p: { role?: string | null } | null) => !!p && (p.role === 'reseller' || p.role === 'admin')

// ── Create ────────────────────────────────────────────────────────────
export async function createApiKey(
  admin: Admin, userId: string,
  input: { label: string; scopes: string[]; expires_at: string | null; allowed_ips: string[] }
): Promise<KeyResult<{ plaintext: string; meta: any }>> {
  if (input.scopes.includes('allocate')) {
    const problem = allocateAllowlistProblem(input.allowed_ips)
    if (problem) return fail(400, problem)
  }
  const plaintext = generateKey()
  const key_hash = await sha256Hex(plaintext)
  const key_prefix = plaintext.slice(0, KEY_PREFIX.length + 6) // e.g. gp_live_a1b2c3
  const { data, error } = await admin
    .from('api_keys')
    .insert({ user_id: userId, key_hash, key_prefix, label: input.label, scopes: input.scopes, expires_at: input.expires_at, allowed_ips: input.allowed_ips })
    .select('id, key_prefix, label, scopes, allowed_ips, expires_at, created_at')
    .single()
  if (error) {
    // The 25-active-keys cap is a DB trigger (race-free) → 23514.
    if (error.code === '23514' && /maximum/i.test(error.message ?? '')) return fail(400, 'Maximum of 25 active API keys per account. Revoke one first.')
    console.error('[api-keys] create failed', error)
    return fail(500, 'Could not create the key. Please try again.')
  }
  return { ok: true, data: { plaintext, meta: data } }
}

// ── Edit ──────────────────────────────────────────────────────────────
// Label, allowed_ips, scopes and expiry can be changed in place — tightening a
// key used to mean minting a new secret and redeploying it everywhere.
// `loosens` tells the route whether the change widens what the key can do (more
// scopes, a later/no expiry, more or any IPs) and therefore needs the same
// step-up as creating a key; narrowing and renaming never do.
export async function planKeyUpdate(
  admin: Admin, userId: string, id: string, body: any, owner: { role?: string | null }
): Promise<KeyResult<{ patch: Record<string, unknown>; loosens: boolean; current: any }>> {
  if (!isUuidString(id)) return fail(404, 'Key not found or already revoked')
  const { data: current, error: curErr } = await admin
    .from('api_keys').select('id, label, scopes, allowed_ips, expires_at, revoked_at, key_prefix').eq('id', id).eq('user_id', userId).maybeSingle()
  if (curErr) { console.error('[api-keys] edit lookup failed', curErr); return fail(500, 'Could not load the key. Please try again.') }
  if (!current || current.revoked_at) return fail(404, 'Key not found or already revoked')
  // An expired key behaves like a revoked one everywhere else. Editing its expiry used to bring it
  // back to life — past the 25-active-keys cap, which only checks inserts. Rotate renews a key.
  if (current.expires_at && new Date(current.expires_at).getTime() <= Date.now()) {
    return fail(409, 'This key has expired and cannot be edited. Rotate it to issue a replacement.')
  }

  const patch: Record<string, unknown> = {}
  let loosens = false

  if (body?.label !== undefined) {
    if (typeof body.label !== 'string' || !body.label.trim()) return fail(400, 'label must be a non-empty string.')
    patch.label = cleanLabel(body.label)
  }

  let nextIps: string[] = (current.allowed_ips as string[] | null) ?? []
  if (body?.allowed_ips !== undefined) {
    const ips = parseAllowedIps(body.allowed_ips)
    if (!ips.ok) return fail(400, ips.error)
    // Loosening = the key becomes usable from MORE places: going to "any IP"
    // (empty list) from a restricted one, or adding an address that wasn't
    // there. Going from "any IP" to a restricted list, or removing entries, is
    // tightening and needs no step-up.
    // Compared in canonical form: an entry stored before canonicalisation ("1.2.3.4/32")
    // must not read as a NEW address when it comes back as "1.2.3.4".
    const oldCanon = parseAllowedIps(nextIps)
    const old = new Set(oldCanon.ok ? oldCanon.value : nextIps)
    if (old.size > 0 && (ips.value.length === 0 || ips.value.some((x) => !old.has(x)))) loosens = true
    nextIps = ips.value
    patch.allowed_ips = ips.value
  }

  let nextScopes: string[] = (current.scopes as string[]) ?? ['read', 'write']
  if (body?.scopes !== undefined) {
    const s = parseScopes(body.scopes, { canAllocate: canAllocate(owner) || nextScopes.includes('allocate') })
    if (!s.ok) return fail(400, s.error)
    if (s.value.some((x) => !nextScopes.includes(x))) loosens = true
    nextScopes = s.value
    patch.scopes = s.value
  }
  if (nextScopes.includes('allocate') && (body?.scopes !== undefined || body?.allowed_ips !== undefined)) {
    const problem = allocateAllowlistProblem(nextIps)
    if (problem) return fail(400, problem)
  }

  if (body?.expires_in_days !== undefined) {
    const e = parseExpiryDays(body.expires_in_days)
    if (!e.ok) return fail(400, e.error)
    const oldMs = current.expires_at ? new Date(current.expires_at).getTime() : Infinity
    const newMs = e.value ? new Date(e.value).getTime() : Infinity
    if (newMs > oldMs) loosens = true
    patch.expires_at = e.value
    patch.expiry_warned_at = null // a renewed key can be warned again
  }

  if (Object.keys(patch).length === 0) return fail(400, 'No fields to update. Supported: label, scopes, allowed_ips, expires_in_days.')
  return { ok: true, data: { patch, loosens, current } }
}

export async function applyKeyUpdate(admin: Admin, userId: string, id: string, patch: Record<string, unknown>): Promise<KeyResult<any>> {
  const { data, error } = await admin
    .from('api_keys').update(patch).eq('id', id).eq('user_id', userId).is('revoked_at', null).select(KEY_VIEW_COLS).maybeSingle()
  if (error) { console.error('[api-keys] update failed', error); return fail(500, 'Could not update the key.') }
  return data ? { ok: true, data } : fail(404, 'Key not found or already revoked')
}

// ── Rotate ────────────────────────────────────────────────────────────
// New key with the same label/scopes/IPs/lifespan; the old one keeps working
// for `graceHours` (default 24) so the new secret can be rolled out without an
// outage, then stops. graceHours = 0 revokes the old key immediately (right when
// the old secret leaked).
//
// Every write below is checked. The old-key update used to be fire-and-forget:
// if it failed, a leaked key stayed live while the response reported it as
// revoked (old_key_valid_until: null).
//   - grace 0: the old key is revoked FIRST (which also frees its slot under the
//     25-active-keys cap, so an account at the cap can still rotate a leaked key),
//     then the replacement is minted; if minting fails the old key is restored.
//   - grace > 0: the replacement is minted first (the old key keeps working while
//     it is created); if the old key's expiry cannot then be set, the replacement
//     is revoked again and the call fails, so nothing is left half-rotated.
export type RotatedKey = {
  plaintext: string; meta: any; old_key_valid_until: string | null
  old: { id: string; label: string | null; key_prefix: string; revoked: boolean }
}

export async function rotateApiKey(
  admin: Admin, userId: string, id: string, graceHours: number
): Promise<KeyResult<RotatedKey>> {
  if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > MAX_ROTATION_GRACE_HOURS) {
    return fail(400, `grace_hours must be between 0 and ${MAX_ROTATION_GRACE_HOURS}.`)
  }
  if (!isUuidString(id)) return fail(404, 'Key not found or already revoked')
  const { data: old, error: oldErr } = await admin
    .from('api_keys').select('id, label, scopes, allowed_ips, expires_at, created_at, revoked_at, key_prefix').eq('id', id).eq('user_id', userId).maybeSingle()
  if (oldErr) { console.error('[api-keys] rotate lookup failed', oldErr); return fail(500, 'Could not load the key. Please try again.') }
  if (!old || old.revoked_at) return fail(404, 'Key not found or already revoked')
  // A key made before the allocate-pin rule may carry a block that is now too wide. The
  // replacement would be refused (and, with no grace period, the old key revoked and
  // put back) — say so up front instead, before anything is touched.
  if ((old.scopes as string[] | null)?.includes('allocate')) {
    const problem = allocateAllowlistProblem((old.allowed_ips as string[] | null) ?? [])
    if (problem) return fail(400, `${problem} Narrow this key's allowed IPs first, then rotate it.`)
  }

  // Same lifespan as the old key, measured from now (a rotation is also how
  // you renew an expiring key).
  let expires_at: string | null = null
  if (old.expires_at) {
    const span = new Date(old.expires_at).getTime() - new Date(old.created_at).getTime()
    expires_at = new Date(Date.now() + Math.max(span, 30 * 86_400_000)).toISOString()
  }
  const input = {
    label: old.label, scopes: old.scopes as string[], expires_at, allowed_ips: (old.allowed_ips as string[] | null) ?? [],
  }
  const oldInfo = { id: old.id as string, label: old.label as string | null, key_prefix: old.key_prefix as string }

  if (graceHours === 0) {
    const revokedAt = new Date().toISOString()
    const { data: revoked, error: revErr } = await admin
      .from('api_keys').update({ revoked_at: revokedAt }).eq('id', id).eq('user_id', userId).is('revoked_at', null).select('id')
    if (revErr) { console.error('[api-keys] rotate: revoke failed', revErr); return fail(500, 'Could not rotate the key. The old key was NOT revoked — please try again.') }
    if (!revoked?.length) return fail(404, 'Key not found or already revoked')

    const created = await createApiKey(admin, userId, input)
    if (!created.ok) {
      // Put the old key back exactly as it was: the caller asked to REPLACE it, not lose it.
      const { error: restoreErr } = await admin
        .from('api_keys').update({ revoked_at: null }).eq('id', id).eq('user_id', userId).eq('revoked_at', revokedAt)
      if (restoreErr) console.error('[api-keys] rotate: could not restore old key after failed create', id, restoreErr)
      return created
    }
    return { ok: true, data: { ...created.data, old_key_valid_until: null, old: { ...oldInfo, revoked: true } } }
  }

  const created = await createApiKey(admin, userId, input)
  if (!created.ok) {
    if (created.status === 400 && /maximum/i.test(created.message)) {
      return fail(400, 'Maximum of 25 active API keys per account. Revoke an unused key first, or rotate with grace_hours 0 (the old key is revoked, freeing its slot).')
    }
    return created
  }

  // Old key: lapse after the grace window, never EXTEND an earlier expiry.
  const graceEnd = Date.now() + graceHours * 3_600_000
  const oldEnd = old.expires_at ? new Date(old.expires_at).getTime() : Infinity
  const validUntil = new Date(Math.min(graceEnd, oldEnd)).toISOString()
  // expiry_warned_at: the user just rotated — the expiry warning must not
  // e-mail "your key expires tomorrow" about the key they are replacing.
  const { data: shortened, error: shortErr } = await admin
    .from('api_keys').update({ expires_at: validUntil, expiry_warned_at: new Date().toISOString() })
    .eq('id', id).eq('user_id', userId).is('revoked_at', null).select('id')
  if (shortErr || !shortened?.length) {
    console.error('[api-keys] rotate: could not set the old key\'s grace expiry', id, shortErr)
    // Undo: a replacement without a bounded old key is a half-rotation.
    await admin.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', created.data.meta.id).eq('user_id', userId)
      .then(() => {}, (e: unknown) => console.error('[api-keys] rotate: could not undo replacement key', e))
    return shortErr ? fail(500, 'Could not rotate the key. Nothing was changed — please try again.') : fail(404, 'Key not found or already revoked')
  }
  return { ok: true, data: { ...created.data, old_key_valid_until: validUntil, old: { ...oldInfo, revoked: false } } }
}

// ── Revoke ────────────────────────────────────────────────────────────
export async function revokeApiKeys(admin: Admin, userId: string, ids: string[] | 'all'): Promise<KeyResult<{ revoked: { id: string; label: string; key_prefix: string }[] }>> {
  // Non-UUID ids would reach Postgres as 22P02 and come back as a 500.
  if (ids !== 'all') {
    ids = ids.filter(isUuidString)
    if (ids.length === 0) return fail(404, 'Key not found or already revoked')
  }
  let q = admin.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId).is('revoked_at', null)
  if (ids !== 'all') q = q.in('id', ids)
  const { data, error } = await q.select('id, label, key_prefix')
  if (error) { console.error('[api-keys] revoke failed', error); return fail(500, 'Could not revoke the key. Please try again.') }
  if (!data || data.length === 0) return fail(404, 'Key not found or already revoked')
  return { ok: true, data: { revoked: data as any } }
}

// ── Webhook fan-out for key lifecycle events ─────────────────────────────
export async function notifyKeyEvent(
  userId: string, event: 'api_key_created' | 'api_key_revoked' | 'api_key_updated',
  k: { id: string; label: string | null; key_prefix: string; scopes?: string[]; expires_at?: string | null },
  extra: Record<string, unknown> = {}
) {
  await dispatchWebhook(userId, event, {
    key_id: k.id, label: k.label, key_prefix: k.key_prefix,
    ...(event !== 'api_key_revoked' ? { scopes: k.scopes ?? null, expires_at: k.expires_at ?? null } : {}),
    ...extra,
  })
}

// Audit rows + webhooks for keys that were just revoked from the dashboard. A single
// key keeps the full per-key path; several (the panic button) are written with one
// insert and one webhook batch so the notices cannot be cut short by the Workers
// subrequest cap. `reason` tells a receiver which of the two it was.
export async function notifyKeysRevoked(
  admin: Admin, userId: string, req: Request,
  revoked: { id: string; label: string | null; key_prefix: string }[], all: boolean
) {
  const reason = all ? 'revoke_all' : 'manual'
  if (revoked.length <= 2) {
    for (const k of revoked) {
      await logSecurityEvent({ userId, event: 'api_key_revoked', req, admin, meta: { key_prefix: k.key_prefix, label: k.label, all } })
      await notifyKeyEvent(userId, 'api_key_revoked', k, { reason })
    }
    return
  }
  await logSecurityEventsBulk(admin, userId, req, revoked.map((k) => ({ key_prefix: k.key_prefix, label: k.label, all })))
  await dispatchWebhookBatch(userId, 'api_key_revoked', revoked.map((k) => ({ key_id: k.id, label: k.label, key_prefix: k.key_prefix, reason })))
}

async function logSecurityEventsBulk(admin: Admin, userId: string, req: Request, metas: Record<string, unknown>[]) {
  // Same row shape logSecurityEvent writes, in one statement.
  try {
    const { ip, ua } = requestMeta(req)
    const { error } = await admin.from('security_events').insert(
      metas.map((meta) => ({ user_id: userId, actor_id: null, event: 'api_key_revoked', ip, user_agent: ua, meta, notify: false }))
    )
    if (error) console.error('[api-keys] bulk security_events insert failed', error.message)
  } catch (e) {
    console.error('[api-keys] bulk security_events insert threw', e)
  }
}
