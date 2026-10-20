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

  await logAdminAction(auth.supabase, { adminId: auth.adminId, action: 'email.unban', targetRef: removed[0].email })
  return NextResponse.json({ success: true })
}
