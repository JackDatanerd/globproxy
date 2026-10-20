import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// POST { email, reason? } — blocks an address from registering. The signup
// check normalises before comparing (case, +tags), so banning
// "abuser+1@gmail.com" also blocks "abuser@gmail.com" and "ABUSER+x@gmail.com".
// This does NOT touch an account that already exists with that address — the
// response says so, so the admin can suspend it separately.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ email?: unknown; reason?: unknown }>(req)
  if (!body || typeof body.email !== 'string') return badRequest('email is required')
  const email = body.email.trim().toLowerCase()
  if (email.length > 254 || !EMAIL_RE.test(email)) return badRequest('That does not look like an email address')
  if (body.reason != null && typeof body.reason !== 'string') return badRequest('reason must be text')
  const reason = (body.reason ?? '').toString().trim().slice(0, 300)

  const { data: already, error: checkErr } = await supabase.rpc('is_email_banned', { check_email: email })
  if (checkErr) return NextResponse.json({ error: checkErr.message }, { status: 500 })
  if (already) return NextResponse.json({ error: 'That address (or an alias of it) is already banned.' }, { status: 409 })

  const { error } = await supabase.from('banned_emails').insert({ email, reason: reason || null, banned_by: adminId })
  if (error) {
    if ((error as any).code === '23505') return NextResponse.json({ error: 'That address is already banned.' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { data: existing } = await supabase.from('profiles').select('id').eq('email', email).eq('is_deleted', false).maybeSingle()

  await logAdminAction(supabase, {
    adminId, action: 'email.ban', targetUserId: existing?.id ?? null, targetRef: email,
    details: reason ? { reason } : {},
  })
  return NextResponse.json({ success: true, existing_account_id: existing?.id ?? null })
}
