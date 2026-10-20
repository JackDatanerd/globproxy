import { appUrl } from '@/lib/appUrl'
import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { dispatchWebhook } from '@/lib/webhooks'
import { syncCredentialLimit, loadSuspendedUserIds } from '@/lib/credentials'
import { fetchAllRows } from '@/lib/dbPaging'

// Runs right after usage-sync writes fresh gb_used for every active
// credential (see lib/usageSync.ts) — this is deliberately NOT a
// separate cron task: it needs gb_used to already reflect real Geonode
// consumption, and piggybacking on the ~5-minute usage-sync cadence means
// a credential is topped up well before it actually runs dry.
//
// The decision AND the top-up happen inside ONE database transaction:
// auto_topup_credential() (migration 0046) locks the credential row,
// re-checks "is this still due" against the current gb_allocated/gb_used,
// and only then calls topup_credential(). The candidate list below is just a
// cheap pre-filter on a snapshot. Previously the due-check ran here on the
// snapshot and topup_credential() applied it unconditionally, so two
// overlapping runs (cron tick + admin "sync now", or two ticks) that both
// saw the same snapshot each topped the credential up.

// Each triggered top-up costs several subrequests (RPC, limit PATCH,
// bookkeeping, a webhook, possibly an email). Bounded per run; anything left
// over is still due on the next 5-minute tick.
const MAX_TOPUPS_PER_RUN = 12

// `admin` is injectable only so tests can drive this with a fake client; callers omit it.
export async function runAutoTopups(userId?: string, admin?: Awaited<ReturnType<typeof createAdminClient>>) {
  const supabase = admin ?? await createAdminClient()

  // Admin-suspended accounts must not keep spending their balance.
  const suspendedUsers = await loadSuspendedUserIds(supabase)

  // Paginated: PostgREST silently truncates a plain select at 1000 rows.
  const { rows: allCandidates, error: fetchErr } = await fetchAllRows<any>((from, to) => {
    let q = supabase
      .from('proxy_credentials')
      .select('id, user_id, label, gb_allocated, gb_used, auto_topup_threshold_gb, auto_topup_amount_gb, auto_topup_insufficient_alerted_at')
      .eq('auto_topup_enabled', true)
      .eq('status', 'active')
      .is('created_by', null) // reseller-allocated credentials are never eligible — same rule the RPC enforces
      .not('upstream_sub_user_id', 'is', null)
      .order('id')
    if (userId) q = q.eq('user_id', userId)
    return q.range(from, to)
  })
  if (fetchErr) {
    console.error('[auto-topup] failed to load candidates:', fetchErr)
    return { checked: 0, triggered: 0, insufficient_alerts: 0, errors: 1, deferred: 0 }
  }
  const candidates = allCandidates.filter(c => !suspendedUsers.has(c.user_id))

  let triggered = 0
  let insufficientAlerts = 0
  let errors = 0
  let deferred = 0

  for (const cred of candidates) {
    const remaining = (cred.gb_allocated ?? 0) - (cred.gb_used ?? 0)
    const threshold = cred.auto_topup_threshold_gb ?? 0

    if (remaining > threshold) {
      // Back above threshold — clear any stale alert flag so a future dip
      // re-alerts instead of staying silently suppressed.
      if (cred.auto_topup_insufficient_alerted_at) {
        await supabase.from('proxy_credentials')
          .update({ auto_topup_insufficient_alerted_at: null })
          .eq('id', cred.id)
      }
      continue
    }

    if (triggered + insufficientAlerts >= MAX_TOPUPS_PER_RUN) { deferred++; continue }

    const { data: rawNewTotal, error: topupErr } = await supabase.rpc('auto_topup_credential', {
      p_credential_id: cred.id,
      p_user_id: cred.user_id,
    })

    if (topupErr) {
      const msg = topupErr.message ?? ''
      // ONLY a genuine balance shortfall earns the "insufficient balance"
      // email. Every other failure used to be reported that way too — a
      // credential deleted mid-run, a status change, a misconfigured
      // threshold — telling customers to buy bandwidth they didn't need.
      if (!msg.includes('Insufficient')) {
        errors++
        console.error('[auto-topup] failed for credential', cred.id, topupErr.code, msg)
        continue
      }

      console.error('[auto-topup] insufficient balance for credential', cred.id)
      // One alert per shortfall, not one every 5 minutes. The flag is
      // cleared when the balance recovers or the config is re-saved.
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
                  <a href="${appUrl()}/dashboard/buy"
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
        // Same once-then-quiet de-dupe as the email.
        await dispatchWebhook(cred.user_id, 'auto_topup_failed', {
          credential_id: cred.id, reason: 'insufficient_balance',
          gb_allocated: cred.gb_allocated, gb_used: cred.gb_used, amount_gb: cred.auto_topup_amount_gb,
        })
        insufficientAlerts++
      }
      continue
    }

    // NULL = the RPC re-checked under the lock and nothing was due (another
    // run got there first, or the credential changed). Not an error.
    if (rawNewTotal === null || rawNewTotal === undefined) continue

    triggered++
    const newTotal = Number(rawNewTotal)

    // DB side already committed atomically. Bring Geonode's live cap up to
    // the CURRENT database value. A failure is flagged for the cron retry
    // (syncCredentialLimit → markLimitSyncNeeded) and healed by the usage-sync
    // reconciler even if the flag is lost.
    await syncCredentialLimit(supabase, cred.id)

    await dispatchWebhook(cred.user_id, 'auto_topup_triggered', {
      credential_id: cred.id, gb_added: cred.auto_topup_amount_gb, gb_allocated: Number.isFinite(newTotal) ? newTotal : null,
    })

    await supabase.from('proxy_credentials')
      .update({ auto_topup_last_triggered_at: new Date().toISOString(), auto_topup_insufficient_alerted_at: null })
      .eq('id', cred.id)
  }

  return { checked: candidates.length, triggered, insufficient_alerts: insufficientAlerts, errors, deferred }
}
