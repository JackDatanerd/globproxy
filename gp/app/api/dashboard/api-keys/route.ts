import { createAdminClient, createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireStepUp } from '@/lib/reauth'
import { logSecurityEvent, notifySecurityChange } from '@/lib/securityEvents'
import { parseAllowedIps } from '@/lib/ipAllowlist'

const PREFIX = 'gp_live_'
const EXPIRY_CHOICES_DAYS = [30, 90, 180, 365]

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const token = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  return `${PREFIX}${token}`
}

// List this user's keys (hash never returned).
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, key_prefix, label, scopes, allowed_ips, expires_at, created_at, last_used_at, last_used_ip, revoked_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[api-keys] list failed', error)
    return NextResponse.json({ error: 'Could not load your API keys. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ keys: data })
}

// Create a new key. The plaintext value is returned exactly once — only the
// hash is persisted. Body: { label?, scopes?: ['read'] | ['read','write'],
// expires_in_days?: 30 | 90 | 180 | 365 | null,
// allowed_ips?: string[] (exact IPv4/IPv6 or IPv4 CIDR; empty/omitted = any IP) }.
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 2FA step-up: an account that enabled two-factor must hold a verified
  // session for this action — a password alone isn't enough. See lib/mfa.ts.
  const mfaGate = await requireStepUp(req, user.id)
  if (mfaGate) return mfaGate


  const { data: profile } = await supabase.from('profiles').select('role, api_access, is_suspended, is_deleted').eq('id', user.id).single()
  // Middleware excludes /api, so a deleted account's unexpired session token
  // can reach this route even though /dashboard/api-keys is blocked
  // (migration 0029). requireApiAccess would reject the key anyway; no
  // reason to hand out one that's dead on arrival.
  if (profile?.is_deleted) return NextResponse.json({ error: 'This account no longer exists.' }, { status: 403 })
  if (profile?.is_suspended) return NextResponse.json({ error: 'Account suspended' }, { status: 403 })
  if (profile?.role === 'user' || (!profile?.api_access && profile?.role !== 'admin')) {
    return NextResponse.json({ error: 'API access is not enabled for your account.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  // eslint-disable-next-line no-control-regex
  const label = (typeof body.label === 'string' ? body.label.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '').slice(0, 60) || 'Default key'

  // 'write' implies read; the default is a full-access key, same as before.
  let scopes: string[] = ['read', 'write']
  if (body.scopes !== undefined) {
    const s = Array.isArray(body.scopes) ? [...new Set(body.scopes)] : null
    const valid = s && s.length > 0 && s.every((x) => x === 'read' || x === 'write')
    if (!valid) return NextResponse.json({ error: 'scopes must be ["read"] or ["read","write"].' }, { status: 400 })
    scopes = s!.includes('write') ? ['read', 'write'] : ['read']
  }

  let expires_at: string | null = null
  if (body.expires_in_days !== undefined && body.expires_in_days !== null) {
    if (!EXPIRY_CHOICES_DAYS.includes(Number(body.expires_in_days))) {
      return NextResponse.json({ error: `expires_in_days must be one of: ${EXPIRY_CHOICES_DAYS.join(', ')} (or omit for no expiry).` }, { status: 400 })
    }
    expires_at = new Date(Date.now() + Number(body.expires_in_days) * 86_400_000).toISOString()
  }

  const ips = parseAllowedIps(body.allowed_ips)
  if (!ips.ok) return NextResponse.json({ error: ips.error }, { status: 400 })

  const plaintext = generateKey()
  const key_hash = await sha256Hex(plaintext)
  const key_prefix = plaintext.slice(0, PREFIX.length + 6) // e.g. gp_live_a1b2c3

  const admin = await createAdminClient()
  const { data, error } = await admin
    .from('api_keys')
    .insert({ user_id: user.id, key_hash, key_prefix, label, scopes, expires_at, allowed_ips: ips.value })
    .select('id, key_prefix, label, scopes, allowed_ips, expires_at, created_at')
    .single()

  if (error) {
    // The 25-active-keys cap is a DB trigger (race-free) → 23514.
    if (error.code === '23514') return NextResponse.json({ error: 'Maximum of 25 active API keys per account. Revoke one first.' }, { status: 400 })
    console.error('[api-keys] create failed', error)
    return NextResponse.json({ error: 'Could not create the key. Please try again.' }, { status: 500 })
  }

  // Audit trail + tripwire: a new API key is the thing an intruder makes
  // first. Awaited so Workers can't cancel the e-mail after the response.
  await logSecurityEvent({ userId: user.id, event: 'api_key_created', req, meta: { label, key_prefix }, admin })
  await notifySecurityChange(user.id, 'A new API key was created on your GlobProxy account', `a new API key (<strong>${label.replace(/[<>&"]/g, '')}</strong>, starting ${key_prefix}…) was just created on your account.`)

  // `key` is only ever present in this one response.
  return NextResponse.json({ key: plaintext, meta: data }, { status: 201 })
}

// Revoke a key (soft delete — sets revoked_at, keeps the row so usage
// history stays visible). Goes through the admin client after an explicit
// ownership check (migration 0042 removed the client UPDATE policy), and
// only touches a not-yet-revoked row, so re-revoking can't overwrite the
// original revoked_at.
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await req.json().catch(() => ({}))
  if (!id || typeof id !== 'string') return NextResponse.json({ error: 'Missing key id' }, { status: 400 })

  const admin = await createAdminClient()
  const { data: revoked, error } = await admin
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .select('id')

  if (error) return NextResponse.json({ error: 'Could not revoke the key. Please try again.' }, { status: 500 })
  if (!revoked || revoked.length === 0) {
    return NextResponse.json({ error: 'Key not found or already revoked' }, { status: 404 })
  }
  return NextResponse.json({ success: true })
}
