import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: { user: caller } } = await supabase.auth.getUser(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: cp } = await supabase.from('profiles').select('role').eq('id', caller.id).single()
  if (cp?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { user_id } = await req.json()
  if (!user_id) return NextResponse.json({ error: 'user_id required' }, { status: 400 })

  const { data: tp } = await supabase
    .from('profiles')
    .select('role, email, full_name')
    .eq('id', user_id)
    .single()

  if (!tp) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (tp.role === 'admin') return NextResponse.json({ error: 'Cannot delete admin accounts' }, { status: 403 })

  if (tp.email) {
    await sendEmail({
      to: tp.email,
      subject: 'Your GlobProxy account has been permanently deleted',
      html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;"><h2>Account permanently deleted</h2><p>Your GlobProxy account has been permanently deleted by an administrator.</p><p>If you believe this was a mistake, contact support@globproxy.com</p></div>',
    })

    await supabase.from('banned_emails').upsert({
      email: tp.email.toLowerCase(),
      reason: 'Account deleted by admin',
      banned_by: caller.id,
    }, { onConflict: 'email' })
  }

  const { error } = await supabase.auth.admin.deleteUser(user_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
