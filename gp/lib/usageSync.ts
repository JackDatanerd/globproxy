import { createAdminClient } from '@/lib/supabase/server'
import { listAllSubUsers, getSubUserUsage, updateSubUserTrafficLimit, type SubUserSnapshot } from '@/lib/geonode'
import { runAutoTopups } from '@/lib/autoTopup'
import { fetchAllRows } from '@/lib/dbPaging'
import { syncCredentialLimit, expectedLimitMb, suspendedCapMb, loadSuspendedUserIds } from '@/lib/credentials'
import { dispatchWebhook } from '@/lib/webhooks'
import { sendEmail, escapeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'

// Extracted from app/api/cron/[task]/route.ts's runUsageSync() so the admin
// "sync now" button (app/api/admin/sync-usage) and the Cloudflare-cron-driven
// task hit the exact same code path — two separate implementations of "how
// do we reconcile gb_used" is how they'd quietly drift apart over time.

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>

type CredRow = { id: string; geonode_sub_user_id: string | null; gb_used: number | null }

// Per-run ceilings. Cloudflare Workers caps subrequests per invocation and
// every Geonode PATCH / Supabase write / email counts against it, so each
// optional side-effect is bounded; whatever is left over is picked up on the
// next 5-minute tick.
const MAX_LIMIT_PATCHES_PER_RUN = 15
const MAX_EXHAUSTION_NOTICES_PER_RUN = 8

function buildChanges(creds: CredRow[], usageMap: Map<string, number>) {
  return creds
    .map(cred => ({
      id: cred.id,
      gb_used: cred.geonode_sub_user_id ? usageMap.get(cred.geonode_sub_user_id) : undefined,
      prevGbUsed: cred.gb_used ?? 0,
    }))
    // Only write rows that actually changed (skip both "Geonode didn't
    // return this sub-user" and "unchanged within float noise").
    .filter((c): c is { id: string; gb_used: number; prevGbUsed: number } =>
      c.gb_used !== undefined && Math.abs(c.gb_used - c.prevGbUsed) > 0.0005
    )
    .map(({ id, gb_used }) => ({ id, gb_used }))
}

async function applyChanges(
  supabase: AdminClient,
  changes: { id: string; gb_used: number }[]
) {
  if (changes.length > 0) {
    const { error } = await supabase.rpc('bulk_update_credential_usage', { updates: changes })
    if (error) console.error('bulk_update_credential_usage failed:', error)
  }
  // Always recalc, even with zero changes — a previous partial failure
  // should still get corrected on the next call.
  const { error: recalcErr } = await supabase.rpc('recalculate_bandwidth_accounts')
  if (recalcErr) console.error('recalculate_bandwidth_accounts failed:', recalcErr)
  // recalculate_bandwidth_accounts is the step that actually writes the
  // numbers stock-exposure math and customer-facing balances depend on —
  // its success (not bulk_update's) is what "usage sync is healthy" means.
  return { recalcOk: !recalcErr }
}

// Full sync — every active credential across every user. This is what the
// cron task runs every ~5 minutes, and what the admin "sync all" button
// triggers on demand.
//
// If Geonode's listing is INCOMPLETE (outage, revoked key, timeout) this
// still applies whatever it did get — that is safe, absence just means "no
// update" — but it does NOT stamp the freshness marker, does NOT run
// auto-top-ups on stale usage, and finishes by THROWING so the cron/admin
// caller sees a failure. It used to return normally with recalcOk=true, so a
// total Geonode outage looked healthy and the staleness watchdog (which
// reads that marker) never fired.
// `admin` is injectable only so tests can drive this with a fake client; callers omit it.
export async function syncAllUsage(admin?: AdminClient) {
  const supabase = admin ?? await createAdminClient()

  // Paginated: PostgREST silently truncates a plain select at 1000 rows.
  const { rows: creds, error: credsErr } = await fetchAllRows<any>((from, to) =>
    supabase
      .from('proxy_credentials')
      .select('id, user_id, label, status, geonode_sub_user_id, gb_used, gb_allocated, auto_topup_enabled, exhausted_alerted_at')
      .not('geonode_sub_user_id', 'is', null)
      .order('id')
      .range(from, to)
  )
  if (credsErr) throw new Error(`Could not load credentials for usage sync: ${credsErr}`)

  const { subUsers, complete } = await listAllSubUsers()
  const usageMap = new Map<string, number>()
  for (const [id, snap] of subUsers) usageMap.set(id, snap.usedGb)

  const active = creds.filter(c => c.status === 'active')
  const changes = buildChanges(active, usageMap)
  const { recalcOk } = await applyChanges(supabase, changes)

  let limitsReconciled = 0
  let missingUpstream = 0
  let orphanCount = 0
  let exhaustedNotified = 0
  let autoTopup: Awaited<ReturnType<typeof runAutoTopups>> | null = null

  if (complete) {
    const suspendedUsers = await loadSuspendedUserIds(supabase)
    limitsReconciled = await reconcileLimits(supabase, active, subUsers, suspendedUsers)
    missingUpstream = reportMissingUpstream(active, subUsers)
    orphanCount = await sweepOrphans(supabase, creds, subUsers)
    exhaustedNotified = await notifyExhaustion(supabase, active, usageMap, suspendedUsers)

    // Auto-allocate: run after gb_used is fresh so "remaining GB" reflects
    // real current usage. Failures are logged/alerted internally and never
    // throw, so one credential's problem can't block the rest.
    autoTopup = await runAutoTopups(undefined, supabase)

    // Stamp the freshness marker ONLY on a genuine, complete success.
    if (recalcOk) {
      await supabase.from('platform_settings')
        .upsert({ key: 'usage_last_synced_at', value: new Date().toISOString() }, { onConflict: 'key' })
    }
  }

  const summary = {
    updated_credentials: changes.length,
    recalc_ok: recalcOk,
    geonode_listing_complete: complete,
    limits_reconciled: limitsReconciled,
    missing_upstream: missingUpstream,
    orphan_sub_users: orphanCount,
    exhaustion_notices: exhaustedNotified,
    auto_topup: autoTopup,
  }

  if (!complete) {
    throw new Error(`Geonode sub-user listing was incomplete — usage NOT marked fresh (applied ${changes.length} partial updates)`)
  }
  return summary
}

// ─── Limit reconciliation ────────────────────────────────────────────────
// Brings Geonode's live trafficLimitMB back in line with what the database
// says the customer owns. Drift comes from: a top-up whose PATCH failed or
// landed out of order, auto-top-up PATCH failures, a credential created
// before a top-up finished provisioning, or a manual change on Geonode's
// dashboard. Before this existed, a failed PATCH was only logged
// ("needs manual reconciliation") and nothing ever retried — and auto-top-up
// couldn't self-heal because the DB already showed plenty of remaining GB.
//
// Suspended owners get the opposite treatment: their cap is held at
// (used + headroom), which is what makes admin suspension actually cut
// traffic off for any credential lib/adminProxy.ts failed to disable.
async function reconcileLimits(
  supabase: AdminClient,
  active: any[],
  subUsers: Map<string, SubUserSnapshot>,
  suspendedUsers: Set<string>
): Promise<number> {
  let patched = 0
  for (const c of active) {
    if (patched >= MAX_LIMIT_PATCHES_PER_RUN) break
    const snap = subUsers.get(String(c.geonode_sub_user_id))
    if (!snap || snap.limitMb === null) continue // not on Geonode, or no limit reported — nothing to compare

    try {
      if (suspendedUsers.has(c.user_id)) {
        const cap = suspendedCapMb(snap.usedMb)
        if (snap.limitMb > cap + 1) {
          await updateSubUserTrafficLimit(c.geonode_sub_user_id, cap)
          patched++
        }
        continue
      }

      const expected = expectedLimitMb(Number(c.gb_allocated))
      // ±1 MB tolerates rounding between GB (4dp) and whole MB.
      if (Math.abs(snap.limitMb - expected) > 1) {
        // syncCredentialLimit re-reads gb_allocated immediately before the
        // PATCH, so a top-up that committed after this run's snapshot is not
        // overwritten with a stale number.
        const warning = await syncCredentialLimit(supabase, c.id)
        if (!warning) patched++
      }
    } catch (e) {
      console.error('[usage-sync] limit reconcile failed for', c.id, e)
    }
  }
  if (patched > 0) console.log(`[usage-sync] reconciled ${patched} Geonode limit(s)`)
  return patched
}

// Active credentials whose sub-user no longer exists on Geonode (deleted
// there directly, or by a failed-then-retried delete). Reported, not
// auto-fixed: deleting/refunding automatically on the strength of "absent
// from a listing" is exactly the kind of irreversible guess to avoid.
function reportMissingUpstream(active: any[], subUsers: Map<string, SubUserSnapshot>): number {
  const missing = active.filter(c => !subUsers.has(String(c.geonode_sub_user_id)))
  if (missing.length > 0) {
    console.error(`[usage-sync] ${missing.length} active credential(s) have no sub-user on Geonode:`, missing.slice(0, 20).map(c => c.id))
  }
  return missing.length
}

// Sub-users that exist on Geonode, carry our naming prefix, and have no row
// in the database under ANY status. They are real, working, untracked
// proxies (a crash between the upstream create and the DB insert, or a
// failed cleanup). To avoid flagging one whose DB insert is merely in
// flight, an id must be seen as an orphan on TWO consecutive runs before it
// is reported. Results land in platform_settings.geonode_orphans and the
// admin is emailed once per incident.
async function sweepOrphans(
  supabase: AdminClient,
  allCreds: any[],
  subUsers: Map<string, SubUserSnapshot>
): Promise<number> {
  const knownIds = new Set(allCreds.map(c => String(c.geonode_sub_user_id)))
  const candidates: string[] = []
  for (const [id, snap] of subUsers) {
    if (snap.username && snap.username.startsWith('gp_') && !knownIds.has(id)) candidates.push(id)
  }

  const { data: rows } = await supabase
    .from('platform_settings')
    .select('key, value')
    .in('key', ['geonode_orphan_candidates', 'geonode_orphans_alerted_at'])
  const settings = Object.fromEntries((rows ?? []).map((r: any) => [r.key, r.value]))

  let previous: string[] = []
  try { previous = JSON.parse(settings.geonode_orphan_candidates ?? '[]') } catch { /* reset */ }
  const prevSet = new Set(previous)
  const persistent = candidates.filter(id => prevSet.has(id))

  await supabase.from('platform_settings').upsert([
    { key: 'geonode_orphan_candidates', value: JSON.stringify(candidates.slice(0, 500)) },
    { key: 'geonode_orphans', value: JSON.stringify({ count: persistent.length, ids: persistent.slice(0, 100), detected_at: new Date().toISOString() }) },
  ], { onConflict: 'key' })

  if (persistent.length === 0) {
    if (settings.geonode_orphans_alerted_at) {
      await supabase.from('platform_settings').delete().eq('key', 'geonode_orphans_alerted_at')
    }
    return 0
  }

  console.error(`[usage-sync] ${persistent.length} orphan Geonode sub-user(s) with no local record:`, persistent.slice(0, 20))
  if (!settings.geonode_orphans_alerted_at && process.env.ADMIN_EMAIL) {
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `[ORPHAN SUB-USERS] ${persistent.length} Geonode sub-user(s) have no local record`,
      html: `<p>${persistent.length} sub-user(s) on Geonode carry the <code>gp_</code> prefix but have no
             <code>proxy_credentials</code> row (seen on two consecutive usage syncs). They are live,
             untracked proxies — usually the result of a crash between the Geonode create and the database insert.</p>
             <p><strong>Geonode sub-user ids (first 20):</strong> ${escapeHtml(persistent.slice(0, 20).join(', '))}</p>
             <p>Review and delete them in Geonode, or re-attach them if they belong to a customer. Full list:
             <code>platform_settings.geonode_orphans</code>.</p>`,
    }).catch((e) => console.error('[usage-sync] orphan alert email failed', e))
    await supabase.from('platform_settings')
      .upsert({ key: 'geonode_orphans_alerted_at', value: new Date().toISOString() }, { onConflict: 'key' })
  }
  return persistent.length
}

// Per-credential exhaustion notice. The existing 80%/95% alerts are
// account-level and run once a day; a single session hitting its cap with
// auto-allocate OFF previously produced no signal at all — the customer's
// scraper just started failing. Fires once per exhaustion (re-arms when the
// credential has headroom again) as an email + a `session_exhausted` webhook.
async function notifyExhaustion(
  supabase: AdminClient,
  active: any[],
  usageMap: Map<string, number>,
  suspendedUsers: Set<string>
): Promise<number> {
  const EPS = 0.0005
  const rearm: string[] = []
  const due: any[] = []

  for (const c of active) {
    const used = usageMap.get(String(c.geonode_sub_user_id)) ?? Number(c.gb_used ?? 0)
    const exhausted = used >= Number(c.gb_allocated) - EPS
    if (!exhausted) {
      if (c.exhausted_alerted_at) rearm.push(c.id)
      continue
    }
    if (c.exhausted_alerted_at || c.auto_topup_enabled || suspendedUsers.has(c.user_id)) continue
    due.push({ ...c, used })
  }

  if (rearm.length > 0) {
    await supabase.from('proxy_credentials').update({ exhausted_alerted_at: null }).in('id', rearm.slice(0, 200))
  }

  let sent = 0
  for (const c of due.slice(0, MAX_EXHAUSTION_NOTICES_PER_RUN)) {
    const { data: profile } = await supabase
      .from('profiles').select('email, full_name').eq('id', c.user_id).single()
    if (profile?.email) {
      await sendEmail({
        to: profile.email,
        subject: `Your proxy session ran out of bandwidth — GlobProxy`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
            <h2 style="text-align:center;color:#111;">Session out of bandwidth</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(profile.full_name?.split(' ')[0]) || 'there'}, your session
              <strong>${escapeHtml(c.label || 'Unnamed')}</strong> has used its full
              ${Number(c.gb_allocated).toFixed(2)} GB allocation and has stopped connecting.
              Top it up from your dashboard to resume, or turn on auto-allocate so this doesn't happen again.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${appUrl()}/dashboard/proxies"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Open my sessions →
              </a>
            </div>
          </div>`,
      }).catch((e) => console.error('[usage-sync] exhaustion email failed', c.id, e))
    }
    await dispatchWebhook(c.user_id, 'session_exhausted', {
      credential_id: c.id,
      label: c.label ?? null,
      gb_allocated: Number(c.gb_allocated),
      gb_used: c.used,
    }).catch((e) => console.error('[webhooks] session_exhausted dispatch threw', c.id, e))
    await supabase.from('proxy_credentials')
      .update({ exhausted_alerted_at: new Date().toISOString() })
      .eq('id', c.id)
    sent++
  }
  return sent
}

// Scoped sync — one user's active credentials only. For the admin
// per-user "sync this user now" button. A single user's active-credential
// count is capped (100), well under the subrequest ceiling that forced the
// bulk approach above, so a per-credential loop against getSubUserUsage is
// fine here.
export async function syncUserUsage(userId: string) {
  const supabase = await createAdminClient()
  const { data: creds } = await supabase
    .from('proxy_credentials')
    .select('id, geonode_sub_user_id, gb_used')
    .eq('status', 'active')
    .eq('user_id', userId)
    .not('geonode_sub_user_id', 'is', null)

  const usageMap = new Map<string, number>()
  let failures = 0
  for (const c of creds ?? []) {
    if (!c.geonode_sub_user_id) continue
    try {
      usageMap.set(c.geonode_sub_user_id, await getSubUserUsage(c.geonode_sub_user_id))
    } catch (e) {
      // Non-fatal per credential — a transient failure on one sub-user
      // shouldn't block reconciling the rest of this user's credentials.
      failures++
      console.error('Live usage fetch failed for', c.geonode_sub_user_id, e)
    }
  }

  const changes = buildChanges(creds ?? [], usageMap)
  const { recalcOk } = await applyChanges(supabase, changes)
  // Settles this user's auto-top-ups immediately rather than waiting for the
  // next full tick — but not on a partial read of their usage.
  const autoTopup = failures === 0 ? await runAutoTopups(userId) : null
  return { updated_credentials: changes.length, recalc_ok: recalcOk, usage_fetch_failures: failures, auto_topup: autoTopup }
}
