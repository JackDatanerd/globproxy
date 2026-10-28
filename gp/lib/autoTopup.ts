import { appUrl } from '@/lib/appUrl'
import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { dispatchWebhook } from '@/lib/webhooks'
import { syncCredentialLimit, loadSuspendedUserIds } from '@/lib/credentials'
import { fetchAllRows } from '@/lib/dbPaging'
import { MAX_GB_PER_CREDENTIAL } from '@/lib/apiValidation'

// Runs right after usage-sync writes fresh gb_used for every active
// credential (see lib/usageSync.ts) — this is deliberately NOT a
// separate cron task: it needs gb_used to already reflect real upstream
// consumption, and piggybacking on the ~5-minute usage-sync cadence means
// a credential is topped up well before it actually runs dry.
//
// The decision AND the top-up happen inside ONE database transaction:
// auto_topup_credential() (migrations 0046 + 0048) locks the credential row,
// re-checks "is this still due" against the current gb_allocated/gb_used,
// and only then calls topup_credential(). The candidate list below is just a
// cheap pre-filter on a snapshot. Previously the due-check ran here on the
// snapshot and topup_credential() applied it unconditionally, so two
// overlapping runs (cron tick + admin "sync now", or two ticks) that both
// saw the same snapshot each topped the credential up.

// Each attempted top-up costs several subrequests (RPC, limit PATCH,
// bookkeeping, a webhook insert, possibly an email). Bounded per run; anything
// left over is still due on the next 5-minute tick. Credentials that are
// already flagged (alerted) and whose owner still has no balance are skipped
// WITHOUT an RPC and don't count — they used to cost one RPC every tick,
// unbounded, forever.
const MAX_TOPUPS_PER_RUN = 12
const MIN_PARTIAL_GB = 0.01 // below this the balance can't fund even a minimum top-up

type AlertKind = 'insufficient' | 'partial' | 'session_limit'
type Supa = Awaited<ReturnType<typeof createAdminClient>>

const WRAP = (inner: string) => `
  <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
    <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
      style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
    ${inner}
  </div>`
const CTA = (href: string, label: string) => `
  <div style="text-align:center;margin:32px 0;">
    <a href="${appUrl()}${href}"
       style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
      ${label}
    </a>
  </div>`

// Claim-then-notify: the flag is set FIRST with a guarded update, so two
// overlapping runs can't both send, and a customer is told once per episode
// (the flag clears when the session is healthy again or the config is re-saved).
async function alertOnce(
  supabase: Supa,
  cred: any,
  kind: AlertKind,
  detail: { added_gb?: number } = {}
): Promise<boolean> {
  const { data: claimed } = await supabase.from('proxy_credentials')
    .update({ auto_topup_insufficient_alerted_at: new Date().toISOString(), auto_topup_alert_kind: kind })
    // One notice per KIND per episode (migration 0083): the three notices used to share a
    // single flag, so after e.g. "insufficient balance" a later "partial" or "session limit"
    // situation was swallowed silently. A row flagged before 0083 has no kind and keeps the
    // old behaviour (suppressed) until the flag clears.
    .eq('id', cred.id).or(`auto_topup_insufficient_alerted_at.is.null,auto_topup_alert_kind.neq.${kind}`).select('id')
  if (!claimed?.length) return false

  const { data: profile } = await supabase
    .from('profiles').select('email, full_name').eq('id', cred.user_id).single()
  if (profile?.email) {
    const name = escapeHtml(profile.full_name?.split(' ')[0]) || 'there'
    const label = escapeHtml(cred.label || 'Unnamed')
    const msg = {
      insufficient: {
        subject: `Auto-allocate couldn't top up your proxy — insufficient balance`,
        html: WRAP(`<h2 style="text-align:center;color:#111;">Auto-allocate needs more bandwidth</h2>
          <p style="color:#444;text-align:center;">Hi ${name}, your session <strong>${label}</strong> is running low and
          auto-allocate is on, but your account balance has no bandwidth left to add. The session will keep
          working until its current allocation runs out.</p>${CTA('/dashboard/buy', 'Buy more bandwidth →')}`),
      },
      partial: {
        subject: `Auto-allocate only partly topped up your proxy`,
        html: WRAP(`<h2 style="text-align:center;color:#111;">Auto-allocate added less than configured</h2>
          <p style="color:#444;text-align:center;">Hi ${name}, your session <strong>${label}</strong> was running low, so we added
          ${(detail.added_gb ?? 0).toFixed(2)} GB — everything your account balance could cover, which is less than the
          ${Number(cred.auto_topup_amount_gb).toFixed(2)} GB you set. Buy more bandwidth and the next top-up will be
          in full.</p>${CTA('/dashboard/buy', 'Buy more bandwidth →')}`),
      },
      session_limit: {
        subject: `Auto-allocate can't top up your proxy — session size limit reached`,
        html: WRAP(`<h2 style="text-align:center;color:#111;">Session size limit reached</h2>
          <p style="color:#444;text-align:center;">Hi ${name}, your session <strong>${label}</strong> is running low but a single
          session can hold at most 100,000 GB, so the configured top-up can't be added. Lower the auto-allocate
          amount, or create another session for new traffic.</p>${CTA('/dashboard/proxies', 'Open my sessions →')}`),
      },
    }[kind]
    await sendEmail({ to: profile.email, subject: msg.subject, html: msg.html })
      .catch((e) => console.error('[auto-topup] alert email failed', cred.id, e))
  }

  await dispatchWebhook(cred.user_id, 'auto_topup_failed', {
    credential_id: cred.id,
    reason: kind === 'insufficient' ? 'insufficient_balance' : kind === 'partial' ? 'partial_funding' : 'session_limit',
    gb_allocated: cred.gb_allocated, gb_used: cred.gb_used, amount_gb: cred.auto_topup_amount_gb,
    ...(kind === 'partial' ? { gb_added: detail.added_gb ?? 0 } : {}),
  }, { defer: true })
  return true
}

// `admin` is injectable only so tests can drive this with a fake client; callers omit it.
export async function runAutoTopups(userId?: string, admin?: Supa) {
  const supabase = admin ?? await createAdminClient()

  // Admin-suspended accounts must not keep spending their balance.
  const suspendedUsers = await loadSuspendedUserIds(supabase)

  // Paginated: PostgREST silently truncates a plain select at 1000 rows.
  const { rows: allCandidates, error: fetchErr } = await fetchAllRows<any>((from, to) => {
    let q = supabase
      .from('proxy_credentials')
      .select('id, user_id, label, gb_allocated, gb_used, auto_topup_threshold_gb, auto_topup_amount_gb, auto_topup_insufficient_alerted_at, auto_topup_alert_kind')
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
    return { checked: 0, triggered: 0, partial: 0, insufficient_alerts: 0, skipped_no_balance: 0, errors: 1, deferred: 0 }
  }
  const candidates = allCandidates.filter(c => !suspendedUsers.has(c.user_id))

  // One batched balance read for owners that are already flagged, so a
  // credential stuck on "no balance" costs nothing per tick until they buy more.
  const available = new Map<string, number>()
  const flaggedOwners = [...new Set(candidates.filter(c => c.auto_topup_insufficient_alerted_at).map(c => c.user_id as string))]
  for (let i = 0; i < flaggedOwners.length; i += 100) {
    const { data: accts } = await supabase
      .from('bandwidth_accounts').select('user_id, total_gb, allocated_gb')
      .in('user_id', flaggedOwners.slice(i, i + 100))
    for (const a of accts ?? []) available.set(a.user_id, Number(a.total_gb) - Number(a.allocated_gb))
  }

  let triggered = 0
  let partialCount = 0
  let insufficientAlerts = 0
  let skippedNoBalance = 0
  let errors = 0
  let deferred = 0
  let attempts = 0

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

    // A single session holds at most MAX_GB_PER_CREDENTIAL. A top-up that
    // can't fit used to fail on EVERY tick forever with nothing but a log
    // line; tell the customer once instead and don't even call the database.
    if (Number(cred.gb_allocated) + Number(cred.auto_topup_amount_gb) > MAX_GB_PER_CREDENTIAL) {
      // Already told for this episode (flag set with this kind, or set before kinds existed):
      // alertOnce would match nothing, but it is still a database call per stuck session per tick
      // OUTSIDE the per-run cap — thousands of them eat the Worker's subrequest budget.
      const alreadyTold = cred.auto_topup_insufficient_alerted_at && (!cred.auto_topup_alert_kind || cred.auto_topup_alert_kind === 'session_limit')
      if (!alreadyTold && await alertOnce(supabase, cred, 'session_limit')) insufficientAlerts++
      continue
    }

    // Already alerted and the owner still can't fund even a minimum top-up.
    if (cred.auto_topup_insufficient_alerted_at && (available.get(cred.user_id) ?? 0) < MIN_PARTIAL_GB) {
      skippedNoBalance++
      continue
    }

    if (attempts >= MAX_TOPUPS_PER_RUN) { deferred++; continue }
    attempts++

    const { data: rpcData, error: topupErr } = await supabase.rpc('auto_topup_credential', {
      p_credential_id: cred.id,
      p_user_id: cred.user_id,
    })

    if (topupErr) {
      const msg = topupErr.message ?? ''
      // ONLY a genuine balance shortfall earns the "insufficient balance"
      // email. Every other failure used to be reported that way too — a
      // credential deleted mid-run, a status change, a misconfigured
      // threshold — telling customers to buy bandwidth they didn't need.
      if (msg.includes('Insufficient')) {
        console.error('[auto-topup] insufficient balance for credential', cred.id)
        if (await alertOnce(supabase, cred, 'insufficient')) insufficientAlerts++
        continue
      }
      if (topupErr.code === '23514') {
        if (await alertOnce(supabase, cred, 'session_limit')) insufficientAlerts++
        continue
      }
      errors++
      console.error('[auto-topup] failed for credential', cred.id, topupErr.code, msg)
      continue
    }

    // An empty result = the RPC re-checked under the lock and nothing was due
    // (another run got there first, or the credential changed). Not an error.
    const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
      { new_total?: number | string; added_gb?: number | string; partial?: boolean } | null | undefined
    if (!row || row.new_total === null || row.new_total === undefined) continue

    triggered++
    const newTotal = Number(row.new_total)
    const added = Number(row.added_gb ?? cred.auto_topup_amount_gb)

    // DB side already committed atomically. Bring the live cap up to the
    // CURRENT database value. A failure is flagged for the cron retry
    // (syncCredentialLimit → markLimitSyncNeeded) and healed by the usage-sync
    // reconciler even if the flag is lost.
    await syncCredentialLimit(supabase, cred.id)

    await dispatchWebhook(cred.user_id, 'auto_topup_triggered', {
      credential_id: cred.id, gb_added: added, gb_allocated: Number.isFinite(newTotal) ? newTotal : null,
      partial: !!row.partial,
    }, { defer: true })

    if (row.partial) {
      // Funded with what the balance could cover (less than configured): tell
      // the customer once; the flag stays set until they're fully funded again.
      partialCount++
      await supabase.from('proxy_credentials')
        .update({ auto_topup_last_triggered_at: new Date().toISOString() })
        .eq('id', cred.id)
      await alertOnce(supabase, cred, 'partial', { added_gb: added })
    } else {
      await supabase.from('proxy_credentials')
        .update({ auto_topup_last_triggered_at: new Date().toISOString(), auto_topup_insufficient_alerted_at: null })
        .eq('id', cred.id)
    }
  }

  return {
    checked: candidates.length, triggered, partial: partialCount, insufficient_alerts: insufficientAlerts,
    skipped_no_balance: skippedNoBalance, errors, deferred,
  }
}
