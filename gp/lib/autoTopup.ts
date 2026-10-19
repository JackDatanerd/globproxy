import { createAdminClient } from '@/lib/supabase/server'
import { updateSubUserTrafficLimit } from '@/lib/geonode'
import { sendEmail, escapeHtml } from '@/lib/email'
import { dispatchWebhook } from '@/lib/webhooks'
import { markLimitSyncNeeded } from '@/lib/credentials'

// Runs right after usage-sync writes fresh gb_used for every active
// credential (see lib/usageSync.ts) — this is deliberately NOT a
// separate cron task. It needs gb_used to already reflect real Geonode
// consumption for the "remaining GB" check below to mean anything, and
// piggybacking on the existing ~5-minute usage-sync cadence means a
// credential gets topped up well before it actually runs dry, not just
// once a day (matching the "doesn't have to wait till allocation dies"
// requirement this was built for) — same reasoning that made the
// 80%/95% bandwidth alerts want to run on their own trigger rather than
// the once-a-day chain.
//
// Reuses topup_credential() (migration 0016) as the actual top-up
// mechanism — the exact same atomic reserve-against-balance +
// bump-gb_allocated RPC the manual "Top up" button calls — so there is
// exactly one place that decides how a top-up is applied, whether a
// human or this loop triggered it.
export async function runAutoTopups(userId?: string) {
  const supabase = await createAdminClient()

  let query = supabase
    .from('proxy_credentials')
    .select('id, user_id, gb_allocated, gb_used, auto_topup_threshold_gb, auto_topup_amount_gb, geonode_sub_user_id, auto_topup_insufficient_alerted_at')
    .eq('auto_topup_enabled', true)
    .eq('status', 'active')
    .is('created_by', null) // reseller-allocated credentials are never eligible — same rule topup_credential() enforces
    .not('geonode_sub_user_id', 'is', null) // needs a live sub-user to actually raise the cap on

  if (userId) query = query.eq('user_id', userId)

  const { data: candidates, error: fetchErr } = await query
  if (fetchErr) {
    console.error('[auto-topup] failed to load candidates:', fetchErr)
    return { checked: 0, triggered: 0, insufficient_alerts: 0 }
  }

  let triggered = 0
  let insufficientAlerts = 0

  for (const cred of candidates ?? []) {
    const remaining = (cred.gb_allocated ?? 0) - (cred.gb_used ?? 0)
    const threshold = cred.auto_topup_threshold_gb ?? 0

    if (remaining > threshold) {
      // Back above threshold (e.g. someone manually topped up, or GB was
      // freed up some other way) — clear any stale alert flag so a
      // future dip re-alerts instead of staying silently suppressed.
      if (cred.auto_topup_insufficient_alerted_at) {
        await supabase.from('proxy_credentials')
          .update({ auto_topup_insufficient_alerted_at: null })
          .eq('id', cred.id)
      }
      continue
    }

    const { data: rawNewTotal, error: topupErr } = await supabase.rpc('topup_credential', {
      p_credential_id: cred.id,
      p_user_id: cred.user_id,
      p_gb: cred.auto_topup_amount_gb,
    })

    if (topupErr) {
      // By far the most likely cause here is insufficient account
      // balance to cover the configured amount — the credential and
      // amount are otherwise fixed, valid config that already passed
      // set_auto_topup()'s own checks when it was saved. Don't re-alert
      // on every single cron tick for the same exhausted account (this
      // runs every ~5 min); alert once, then stay quiet until either the
      // balance recovers (handled by the `remaining > threshold` branch
      // above, once a manual top-up or purchase clears it) or this gets
      // reconfigured (set_auto_topup() clears the flag on any save).
      console.error('[auto-topup] failed for credential', cred.id, topupErr.message)
      if (!cred.auto_topup_insufficient_alerted_at) {
        const { data: profile } = await supabase
          .from('profiles').select('email, full_name').eq('id', cred.user_id).single()
        if (profile?.email) {
          await sendEmail({
            to: profile.email,
            subject: `Auto-allocate couldn't top up your proxy — insufficient balance`,
            html: `
              <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
                <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
                  style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
                <h2 style="text-align:center;color:#111;">Auto-allocate needs more bandwidth</h2>
                <p style="color:#444;text-align:center;">
                  Hi ${escapeHtml(profile.full_name?.split(' ')[0]) || 'there'},
                  one of your proxy sessions is running low and auto-allocate is enabled on it,
                  but your account balance isn't enough to cover the top-up amount you configured.
                  The session will keep working until its current allocation runs out.
                </p>
                <div style="text-align:center;margin:32px 0;">
                  <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/buy"
                     style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                    Buy more bandwidth →
                  </a>
                </div>
              </div>
            `,
          }).catch(() => {})
        }
        await supabase.from('proxy_credentials')
          .update({ auto_topup_insufficient_alerted_at: new Date().toISOString() })
          .eq('id', cred.id)
        // Same once-then-quiet de-dupe as the email: this flag clears when
        // the balance recovers or the config is re-saved.
        await dispatchWebhook(cred.user_id, 'auto_topup_failed', {
          credential_id: cred.id, reason: 'insufficient_balance',
          gb_allocated: cred.gb_allocated, gb_used: cred.gb_used, amount_gb: cred.auto_topup_amount_gb,
        })
        insufficientAlerts++
      }
      continue
    }

    triggered++
    const newTotal = Number(rawNewTotal)

    // DB side already committed atomically inside topup_credential() —
    // this PATCH just brings Geonode's live cap up to match. Same
    // "reservation is the source of truth, this is best-effort
    // reconciliation" reasoning as the manual topup route: a failure
    // here needs human eyes but shouldn't be treated as the top-up
    // itself having failed.
    if (Number.isFinite(newTotal)) {
      try {
        await updateSubUserTrafficLimit(cred.geonode_sub_user_id!, newTotal * 1024)
      } catch (e) {
        console.error('[auto-topup] DB committed but Geonode PATCH failed — queued for automatic retry', cred.id, e)
        await markLimitSyncNeeded(supabase, cred.id)
      }
    }

    await dispatchWebhook(cred.user_id, 'auto_topup_triggered', {
      credential_id: cred.id, gb_added: cred.auto_topup_amount_gb, gb_allocated: Number.isFinite(newTotal) ? newTotal : null,
    })

    await supabase.from('proxy_credentials')
      .update({ auto_topup_last_triggered_at: new Date().toISOString(), auto_topup_insufficient_alerted_at: null })
      .eq('id', cred.id)
  }

  return { checked: candidates?.length ?? 0, triggered, insufficient_alerts: insufficientAlerts }
}
