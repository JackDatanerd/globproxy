import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { suspendAccount, sendSuspensionEmail } from '@/lib/adminSuspend'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN_RE = /^@[^\s@]+\.[^\s@]+$/

// A whole-domain ban on one of these would lock out a large share of real
// customers (and our own staff) — refuse it rather than rely on a careful admin.
const PROTECTED_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com', 'globproxy.com',
])

// POST { email, reason?, suspendExisting? } — blocks an address (or, written
// as "@example.com", a whole domain) from registering.
//
// The signup check normalises before comparing: case, +tags, and Gmail's
// dot-insensitivity (a.b@gmail.com = ab@gmail.com = ab@googlemail.com), so
// banning one spelling blocks them all.
//
// Accounts that ALREADY use the address are looked up with the same
// normalisation (an exact-match lookup missed every alias). With
// suspendExisting the matching accounts are suspended in the same step —
// never for a domain ban, and never for an admin account.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ email?: unknown; reason?: unknown; suspendExisting?: unknown }>(req)
  if (!body || typeof body.email !== 'string') return badRequest('email is required')
  const email = body.email.trim().toLowerCase()
  const isDomain = DOMAIN_RE.test(email)
  if (email.length > 254 || !(isDomain || EMAIL_RE.test(email))) return badRequest('That does not look like an email address or a domain (@example.com)')
  if (isDomain && PROTECTED_DOMAINS.has(email.slice(1))) return badRequest('That domain is used by too many real customers to ban as a whole. Ban individual addresses instead.')
  if (body.reason != null && typeof body.reason !== 'string') return badRequest('reason must be text')
  const reason = (body.reason ?? '').toString().trim().slice(0, 300)
  const suspendExisting = body.suspendExisting === true
  if (suspendExisting && isDomain) return badRequest('Existing accounts are not suspended automatically for a domain ban — review them first.')

  const { data: already, error: checkErr } = await supabase.rpc('is_email_banned', { check_email: email })
  if (checkErr) return NextResponse.json({ error: checkErr.message }, { status: 500 })
  if (already) return NextResponse.json({ error: isDomain ? 'That domain is already banned.' : 'That address (or an alias of it) is already banned.' }, { status: 409 })

  const { error } = await supabase.from('banned_emails').insert({ email, reason: reason || null, banned_by: adminId })
  if (error) {
    if ((error as any).code === '23505') return NextResponse.json({ error: 'That address is already banned.' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Accounts already using this address / any alias of it / any address at the domain.
  const { data: matchRows, error: matchErr } = await supabase.rpc('profiles_matching_ban', { p_email: email })
  if (matchErr) console.error('[ban-email] matching accounts lookup failed', matchErr)
  // A failed lookup must not read as "nobody matched" — the ban is in, but existing accounts were not checked or suspended.
  const lookupFailed = !!matchErr
  const matches = ((matchRows ?? []) as { id: string; email: string; full_name: string | null; role: string; is_suspended: boolean }[])

  const suspended: string[] = []
  const failed: { id: string; error: string }[] = []
  if (suspendExisting) {
    for (const m of matches) {
      if (m.role === 'admin' || m.is_suspended) continue
      const why = `Email address banned${reason ? `: ${reason}` : ''}`.slice(0, 300)
      const r = await suspendAccount(supabase, m.id, why)
      if (!r.ok) { failed.push({ id: m.id, error: r.error }); continue }
      suspended.push(m.id)
      await logAdminAction(supabase, {
        adminId, action: 'user.suspend', targetUserId: m.id,
        details: { reason: why, via: 'email.ban', credentials_changed: r.proxy.changed, credential_failures: r.proxy.failed.length },
      })
      await sendSuspensionEmail({ email: m.email, full_name: m.full_name }, reason)
    }
  }

  await logAdminAction(supabase, {
    adminId, action: 'email.ban', targetUserId: matches.length === 1 ? matches[0].id : null, targetRef: email,
    details: {
      ...(reason ? { reason } : {}),
      ...(isDomain ? { domain: true } : {}),
      matched_accounts: matches.length,
      ...(lookupFailed ? { lookup_failed: true } : {}),
      ...(suspendExisting ? { suspended_accounts: suspended.length, suspend_failures: failed.length } : {}),
    },
  })

  return NextResponse.json({
    success: true,
    existing_account_id: matches[0]?.id ?? null,
    existing_accounts: matches.slice(0, 20).map(m => ({ id: m.id, email: m.email, role: m.role, is_suspended: m.is_suspended || suspended.includes(m.id) })),
    existing_total: matches.length,
    suspended: suspended.length,
    suspend_failures: failed,
    lookup_failed: lookupFailed,
  })
}
