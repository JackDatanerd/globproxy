import { appUrl } from '@/lib/appUrl'
import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { dispatchWebhook } from '@/lib/webhooks'

// A key with an expiry used to just stop working on the day, taking the
// customer's integration down with it and teaching them nothing until their
// own jobs started failing. This warns 7 days ahead — by e-mail and by an
// `api_key_expiring` webhook — once per key (expiry_warned_at, reset when the
// expiry is changed or the key is rotated). Runs hourly from the 'webhooks' cron task (lib/webhooks.ts runIntegrationHousekeeping).
const WARN_WINDOW_MS = 7 * 86_400_000
const MAX_PER_RUN = 10 // Workers caps subrequests per invocation; runs hourly from the 'webhooks' task

export async function warnExpiringApiKeys(): Promise<{ warned: number }> {
  const supabase = await createAdminClient()
  const now = Date.now()
  const { data: keys, error } = await supabase
    .from('api_keys')
    .select('id, user_id, label, key_prefix, expires_at')
    .is('revoked_at', null)
    .is('expiry_warned_at', null)
    .gt('expires_at', new Date(now).toISOString())
    .lte('expires_at', new Date(now + WARN_WINDOW_MS).toISOString())
    .order('expires_at', { ascending: true })
    .limit(MAX_PER_RUN)
  if (error) { console.error('[api-key-expiry] query failed', error); return { warned: 0 } }

  let warned = 0
  for (const k of keys ?? []) {
    // Claim first (flag, then notify): a duplicate warning is worse than the
    // rare lost one, and a lost one is still visible as a dashboard badge.
    const { data: claimed } = await supabase
      .from('api_keys').update({ expiry_warned_at: new Date().toISOString() })
      .eq('id', k.id).is('expiry_warned_at', null).select('id')
    if (!claimed?.length) continue

    try {
      const { data: profile } = await supabase.from('profiles').select('email, full_name, is_deleted, is_suspended').eq('id', k.user_id).maybeSingle()
      if (profile?.email && !profile.is_deleted) {
        const days = Math.max(1, Math.ceil((new Date(k.expires_at as string).getTime() - now) / 86_400_000))
        await sendEmail({
          to: profile.email,
          subject: `Your GlobProxy API key expires in ${days} day${days === 1 ? '' : 's'}`,
          html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
            <h2>API key expiring</h2>
            <p>Hi ${escapeHtml(profile.full_name?.split(' ')[0]) || 'there'}, your API key
            <strong>${escapeHtml(k.label ?? 'Unnamed key')}</strong> (<code>${escapeHtml(k.key_prefix)}…</code>)
            expires on ${escapeHtml(String(k.expires_at).slice(0, 10))}. Requests using it will start failing with
            <code>401</code> after that.</p>
            <p>Use <strong>Rotate</strong> on
            <a href="${appUrl()}/dashboard/api-keys">API Keys</a> to issue a replacement and keep the old key
            working for a grace window while you deploy the new one.</p></div>`,
        })
      }
    } catch (e) {
      console.error('[api-key-expiry] email failed', k.id, e)
    }
    await dispatchWebhook(k.user_id, 'api_key_expiring', {
      key_id: k.id, label: k.label, key_prefix: k.key_prefix, expires_at: k.expires_at,
    })
    warned++
  }
  return { warned }
}
