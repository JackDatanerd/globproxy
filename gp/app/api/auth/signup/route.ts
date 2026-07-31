import { createAdminClient } from '@/lib/supabase/server'
import { validateEmail } from '@/lib/email-validation'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  try {
    const { email, password, full_name, intended_role, emailRedirectTo } = await req.json()
    if (!email || !password) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })

    // Was previously only enforced client-side in app/auth/signup/page.tsx,
    // which anyone posting to this endpoint directly could skip entirely.
    const { valid, error: emailError } = validateEmail(email)
    if (!valid) return NextResponse.json({ error: emailError }, { status: 400 })

    const supabase = await createAdminClient()

    // 1. Check banned emails
    const { data: banned } = await supabase
      .from('banned_emails')
      .select('id')
      .eq('email', email.toLowerCase())
      .single()

    if (banned) return NextResponse.json({
      error: 'This email is not eligible to create an account. Contact support@globproxy.com.'
    }, { status: 403 })

    // 2. Check if profile exists (existing user)
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_suspended, role')
      .eq('email', email.toLowerCase())
      .single()

    if (profile) {
      if (profile.is_suspended) return NextResponse.json({
        error: 'This account has been suspended. Contact support@globproxy.com.'
      }, { status: 403 })

      return NextResponse.json({
        error: 'An account with this email already exists.',
        existing: true,
      }, { status: 409 })
    }

    // 3. All clear — sign up via Supabase
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name, intended_role },
        emailRedirectTo,
      }
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}