import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response

  const body = await readJson<{ banId?: unknown }>(req)
  if (!body || !isUuid(body.banId)) return badRequest('Ban ID missing or invalid')

  const { data: removed, error } = await auth.supabase.from('banned_emails').delete().eq('id', body.banId).select('email')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!removed?.length) return NextResponse.json({ error: 'That ban no longer exists.' }, { status: 409 })

  // Accounts suspended BY this ban stay suspended — lifting a ban is not a reinstatement. Say
  // which ones, so the admin can decide, instead of leaving them silently locked out.
  const { data: rows } = await auth.supabase.rpc('profiles_matching_ban', { p_email: removed[0].email })
  const still = ((rows ?? []) as { id: string; email: string; is_suspended: boolean }[]).filter(r => r.is_suspended)

  await logAdminAction(auth.supabase, {
    adminId: auth.adminId, action: 'email.unban', targetRef: removed[0].email,
    details: still.length ? { still_suspended_accounts: still.length } : {},
  })
  return NextResponse.json({
    success: true,
    still_suspended: still.slice(0, 20).map(r => ({ id: r.id, email: r.email })),
    still_suspended_total: still.length,
  })
}
