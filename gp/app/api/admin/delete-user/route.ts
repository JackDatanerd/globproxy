import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  // ── Auth: must be a logged-in admin ──────────────────────────────────────
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: { user: caller } } = await supabase.auth.getUser(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: cp } = await supabase
    .from('profiles').select('role').eq('id', caller.id).single()
  if (cp?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // ── Payload ───────────────────────────────────────────────────────────────
  const { user_id } = await req.json()
  if (!user_id) return NextResponse.json({ error: 'Missing user_id' }, { status: 400 })

  // ── Guard: cannot delete another admin ───────────────────────────────────
  const { data: tp } = await supabase
    .from('profiles')
    .select('role, email, full_name, is_deleted')
    .eq('id', user_id)
    .single()

  if (!tp) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (tp.role === 'admin') return NextResponse.json({ error: 'Cannot delete an admin account' }, { status: 403 })
  if (tp.is_deleted) return NextResponse.json({ error: 'User is already deleted' }, { status: 400 })

  // ── Step 1: Anonymise profile — preserve row for FK integrity ────────────
  // Orders, bandwidth_accounts, reseller_transfers all remain intact for auditing.
  const { error: profileError } = await supabase
    .from('profiles')
    .update({
      full_name: '[deleted]',
      email: '[deleted]',
      is_deleted: true,
      deleted_at: new Date().toISOString(),
      // Clear any sensitive fields your profiles table holds
      avatar_url: null,
      is_suspended: false,
      suspended_at: null,
      suspension_reason: null,
    })
    .eq('id', user_id)

  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 500 })
  }

  // ── Step 2: Delete auth user ─────────────────────────────────────────────
  // This cascades to proxy_credentials only (per migration).
  // Everything else (orders, bandwidth, transfers) stays — linked to the
  // now-anonymised profile row above.
  const { error: authError } = await supabase.auth.admin.deleteUser(user_id)

  if (authError) {
    // Roll back the profile anonymisation so the record is not in a broken state
    await supabase.from('profiles').update({
      full_name: tp.full_name,
      email: tp.email,
      is_deleted: false,
      deleted_at: null,
    }).eq('id', user_id)

    return NextResponse.json({ error: authError.message }, { status: 500 })
  }

  // ── Step 3: Send deletion email (best-effort — don't fail the request) ───
  if (tp.email && tp.email !== '[deleted]') {
    await sendEmail({
      to: tp.email,
      subject: 'Your GlobProxy account has been deleted',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
          <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
            style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
          <h2 style="text-align:center;color:#111;">Account deleted</h2>
          <p style="color:#444;text-align:center;">
            Hi ${tp.full_name ?? 'there'}, your GlobProxy account has been permanently deleted.
            Your personal data has been removed. If you believe this was a mistake,
            please contact us as soon as possible.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="mailto:support@globproxy.com"
               style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Contact support →
            </a>
          </div>
          <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
            © 2026 GlobProxy · Residential Proxies That Never Expire
          </p>
        </div>
      `,
    }).catch(() => {
      // Email failure is non-fatal — deletion already succeeded
    })
  }

  return NextResponse.json({ success: true })
}
