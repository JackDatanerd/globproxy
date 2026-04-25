import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  try {
    const { email, redirectTo } = await req.json()
    if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 })

    const supabase = await createAdminClient()

    // 1. Check banned
    const { data: banned } = await supabase
      .from('banned_emails')
      .select('id')
      .eq('email', email.toLowerCase())
      .single()

    if (banned) return NextResponse.json({
      error: 'No account found with this email address.'
    }, { status: 404 })

    // 2. Check profile exists
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_suspended')
      .eq('email', email.toLowerCase())
      .single()

    if (!profile) return NextResponse.json({
      error: 'No account found with this email address.'
    }, { status: 404 })

    if (profile.is_suspended) return NextResponse.json({
      error: 'This account has been suspended. Contact support@globproxy.com.'
    }, { status: 403 })

    // 3. All clear — send reset email
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}