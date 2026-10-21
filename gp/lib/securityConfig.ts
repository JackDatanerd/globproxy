import { createAdminClient } from '@/lib/supabase/server'
import { encryptionEnabled } from '@/lib/mfaCrypto'

// What the Auth & MFA section depends on being configured, as plain
// pass/warn/fail rows for the admin Settings page. Booleans and counts only:
// no secret value ever leaves this module. Each of these degrades SILENTLY when
// missing (plaintext TOTP seeds, no bot check on sign-up, no email), so without
// this nobody learns production is running in the weaker mode.
export type SecurityCheck = {
  id: string
  label: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
}

export async function loadSecurityChecks(): Promise<SecurityCheck[]> {
  const checks: SecurityCheck[] = []
  const has = (k: string) => !!process.env[k]?.trim()

  // 2FA secret storage
  const keyOn = encryptionEnabled()
  let plain = 0, v1 = 0, v2 = 0, total = 0, adminsNo2fa = 0, dbOk = true
  try {
    const admin = await createAdminClient()
    const count = async (build: (q: any) => any) => {
      const { count: n, error } = await build(admin.from('mfa_totp_factors').select('user_id', { count: 'exact', head: true }))
      if (error) throw error
      return n ?? 0
    }
    total = await count(q => q)
    v2 = await count(q => q.like('secret', 'enc:v2:%'))
    v1 = await count(q => q.like('secret', 'enc:v1:%'))
    plain = Math.max(0, total - v1 - v2)
    const { count: n, error } = await admin.from('profiles')
      .select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('mfa_enabled', false).eq('is_deleted', false)
    if (error) throw error
    adminsNo2fa = n ?? 0
  } catch (e) {
    dbOk = false
    console.error('[securityConfig] query failed', e)
  }

  checks.push({
    id: 'mfa_key',
    label: '2FA secret encryption key',
    status: keyOn ? 'ok' : 'fail',
    detail: keyOn
      ? 'MFA_ENCRYPTION_KEY is set: new authenticator seeds are encrypted and backup codes are keyed.'
      : 'MFA_ENCRYPTION_KEY is NOT set: authenticator seeds are stored in plaintext and backup codes use unkeyed SHA-256. Set it (openssl rand -base64 32) and redeploy.',
  })
  if (dbOk) {
    const stale = plain + v1
    checks.push({
      id: 'mfa_secret_formats',
      label: 'Stored 2FA seeds',
      status: total === 0 || stale === 0 ? 'ok' : keyOn ? 'warn' : 'fail',
      detail: total === 0
        ? 'No authenticator seeds stored yet.'
        : `${total} stored: ${v2} owner-bound encrypted, ${v1} older encryption, ${plain} plaintext.` +
          (stale > 0 && keyOn ? ' Older rows upgrade themselves the next time each user signs in with a code.' : ''),
    })
    checks.push({
      id: 'admins_2fa',
      label: 'Admins without 2FA',
      status: adminsNo2fa === 0 ? 'ok' : 'warn',
      detail: adminsNo2fa === 0 ? 'Every active admin has 2FA on.' : `${adminsNo2fa} active admin account(s) have 2FA off.`,
    })
  }
  if (has('MFA_ENCRYPTION_KEY_PREVIOUS')) {
    checks.push({
      id: 'mfa_prev_key',
      label: 'Previous encryption key',
      status: 'warn',
      detail: 'MFA_ENCRYPTION_KEY_PREVIOUS is still set (key rotation in progress). Remove it only once every stored seed has been rewritten.',
    })
  }

  const turnstile = has('TURNSTILE_SECRET_KEY') && has('NEXT_PUBLIC_TURNSTILE_SITE_KEY')
  checks.push({
    id: 'turnstile',
    label: 'Bot check (Turnstile)',
    status: turnstile ? 'ok' : 'warn',
    detail: turnstile
      ? 'Sign-up, sign-in and password-reset forms are protected.'
      : 'Turnstile keys are missing: sign-up, sign-in and password-reset have no bot check (only rate limits).',
  })
  const email = has('RESEND_API_KEY')
  checks.push({
    id: 'email',
    label: 'Email delivery',
    status: email ? 'ok' : 'fail',
    detail: email
      ? 'RESEND_API_KEY is set: security notices and recovery links can be sent.'
      : 'RESEND_API_KEY is missing: no security notice, lockout alert or 2FA-recovery email is delivered.',
  })
  return checks
}
