import { createAdminClient, createClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'
import { requireStepUp } from '@/lib/reauth'
import { logSecurityEvent, notifySecurityChange } from '@/lib/securityEvents'
import { parseAllowedIps } from '@/lib/ipAllowlist'
import {
  KEY_VIEW_COLS, cleanLabel, parseScopes, parseExpiryDays, loadKeyOwner, canUseApi, canAllocate,
  createApiKey, planKeyUpdate, applyKeyUpdate, revokeApiKeys, notifyKeyEvent,
} from '@/lib/apiKeys'

const err = (message: string, status: number, code?: string) => NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status })

// List this user's keys (hash never returned).
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return err('Unauthorized', 401)

  const { data, error } = await supabase
    .from('api_keys')
    .select(KEY_VIEW_COLS)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[api-keys] list failed', error)
    return err('Could not load your API keys.', 500)
  }
  return NextResponse.json({ keys: data })
}

// Create a new key. The plaintext value is returned exactly once — only the
// hash is persisted. Body: { label?, scopes?: ['read'] | ['read','write'] |
// [...,'allocate'] (resellers), expires_in_days?: 30 | 90 | 180 | 365 | null,
// allowed_ips?: string[] (IPv4/IPv6 address or CIDR; empty/omitted = any IP,
// except 'allocate' keys, which REQUIRE an allowlist) }.
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return err('Unauthorized', 401)

  // Per-user throttle (lib/rateLimit.ts) — this route mints a credential on every call.
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'api-key-create')
  if (throttled) return throttled

  // 2FA / password step-up: a stolen session must not be able to mint a key.
  const mfaGate = await requireStepUp(req, user.id)
  if (mfaGate) return mfaGate

  const admin = await createAdminClient()
  const profile = await loadKeyOwner(admin, user.id)
  // Middleware excludes /api, so a deleted account's unexpired session token
  // can reach this route even though /dashboard/api-keys is blocked.
  if (profile?.is_deleted) return err('This account no longer exists.', 403)
  if (profile?.is_suspended) return err('Account suspended', 403)
  if (!canUseApi(profile)) return err('API access is not enabled for your account.', 403)

  const body = await req.json().catch(() => ({}))
  const label = cleanLabel(body.label)

  // 'write' implies read; the default is a full-access (read+write) key.
  let scopes = ['read', 'write']
  if (body.scopes !== undefined) {
    const s = parseScopes(body.scopes, { canAllocate: canAllocate(profile) })
    if (!s.ok) return err(s.error, 400)
    scopes = s.value
  }
  const exp = parseExpiryDays(body.expires_in_days)
  if (!exp.ok) return err(exp.error, 400)
  const ips = parseAllowedIps(body.allowed_ips)
  if (!ips.ok) return err(ips.error, 400)

  const created = await createApiKey(admin, user.id, { label, scopes, expires_at: exp.value, allowed_ips: ips.value })
  if (!created.ok) return err(created.message, created.status)

  // Audit trail + tripwire: a new API key is the thing an intruder makes
  // first. Awaited so Workers can't cancel the e-mail after the response.
  const { meta, plaintext } = created.data
  await logSecurityEvent({ userId: user.id, event: 'api_key_created', req, meta: { label, key_prefix: meta.key_prefix, scopes }, admin })
  await notifySecurityChange(user.id, 'A new API key was created on your GlobProxy account', `a new API key (<strong>${label.replace(/[<>&"]/g, '')}</strong>, starting ${meta.key_prefix}…) was just created on your account.`)
  await notifyKeyEvent(user.id, 'api_key_created', meta)

  // `key` is only ever present in this one response.
  return NextResponse.json({ key: plaintext, meta }, { status: 201 })
}

// Edit a key in place. Body: { id, label?, scopes?, allowed_ips?, expires_in_days? }.
// Renaming and TIGHTENING (fewer scopes, sooner expiry, fewer IPs, an allowlist
// where there was none) are free; anything that WIDENS the key needs the same
// step-up as creating one. Allocation keys can't be left without an allowlist.
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return err('Unauthorized', 401)

  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'api-key-update')
  if (throttled) return throttled

  const body = await req.json().catch(() => ({}))
  if (!body?.id || typeof body.id !== 'string') return err('Missing key id', 400)

  const admin = await createAdminClient()
  const profile = await loadKeyOwner(admin, user.id)
  if (profile?.is_deleted || profile?.is_suspended) return err('Account unavailable', 403)

  const plan = await planKeyUpdate(admin, user.id, body.id, body, profile ?? {})
  if (!plan.ok) return err(plan.message, plan.status)

  if (plan.data.loosens) {
    const gate = await requireStepUp(req, user.id)
    if (gate) return gate
  }

  const updated = await applyKeyUpdate(admin, user.id, body.id, plan.data.patch)
  if (!updated.ok) return err(updated.message, updated.status)

  await logSecurityEvent({
    userId: user.id, event: 'api_key_updated', req, admin,
    meta: { key_prefix: plan.data.current.key_prefix, changed: Object.keys(plan.data.patch).filter((k) => k !== 'expiry_warned_at'), widened: plan.data.loosens },
  })
  // Widening a key is exactly what an intruder does to a key they found.
  if (plan.data.loosens) {
    await notifySecurityChange(user.id, 'An API key on your GlobProxy account was widened', `the API key starting ${plan.data.current.key_prefix}… was just given broader access (more scopes, a later expiry or more allowed IPs).`)
  }
  return NextResponse.json({ key: updated.data })
}

// Revoke a key (soft delete — sets revoked_at, keeps the row so usage history
// stays visible). Body: { id } or { all: true } (panic button). Goes through
// the admin client after an explicit ownership scope (migration 0042 removed
// the client UPDATE policy), and only touches not-yet-revoked rows, so
// re-revoking can't overwrite the original revoked_at.
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return err('Unauthorized', 401)

  const body = await req.json().catch(() => ({}))
  const all = body?.all === true
  if (!all && (!body?.id || typeof body.id !== 'string')) return err('Missing key id', 400)

  const admin = await createAdminClient()
  const r = await revokeApiKeys(admin, user.id, all ? 'all' : [body.id])
  if (!r.ok) return err(r.message, r.status)

  for (const k of r.data.revoked) {
    await logSecurityEvent({ userId: user.id, event: 'api_key_revoked', req, admin, meta: { key_prefix: k.key_prefix, label: k.label, all } })
    await notifyKeyEvent(user.id, 'api_key_revoked', { id: k.id, label: k.label, key_prefix: k.key_prefix })
  }
  return NextResponse.json({ success: true, revoked: r.data.revoked.length })
}
