import { createAdminClient } from '@/lib/supabase/server'
import { listAllSubUsers, getSubUserUsage, updateSubUserTrafficLimit, deleteSubUser, type SubUserSnapshot } from '@/lib/geonode'
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

type CredRow = { id: string; user_id?: string | null; upstream_sub_user_id: string | null; gb_used: number | null }

// Per-run ceilings. Cloudflare Workers caps subrequests per invocation and
// every Geonode PATCH / Supabase write / email counts against it, so each
// optional side-effect is bounded; whatever is left over is picked up on the
// next 5-minute tick.
const MAX_LIMIT_PATCHES_PER_RUN = 15
const MAX_EXHAUSTION_NOTICES_PER_RUN = 8
const MAX_LOW_NOTICES_PER_RUN = 8
// E-mails are capped hard (inbox protection, provider quota). WEBHOOKS are not
// e-mail: they used to ride the same caps, so a reseller with hundreds of
// sessions crossing a threshold together heard about one session per tick (an
// 8-per-run global cap for exhaustion, one per customer per tick for low).
// Webhooks now carry every crossing, up to this many per run; the rest follow on
// the next tick. Each is only a database insert here — delivery is deferred.
const MAX_WEBHOOK_EVENTS_PER_RUN = 60
const UPSTREAM_MISSING_GRACE_MS = 10 * 60_000 // listing may lag a just-created sub-user

type UsageChange = { id: string; gb_used: number; user_id: string | null; delta: number }

function buildChanges(creds: CredRow[], usageMap: Map<string, number>): UsageChange[] {
  return creds
    .map(cred => ({
      id: cred.id,
      user_id: cred.user_id ?? null,
      gb_used: cred.upstream_sub_user_id ? usageMap.get(cred.upstream_sub_user_id) : undefined,
      prevGbUsed: cred.gb_used ?? 0,
    }))
    // Only write rows that actually changed (skip both "Geonode didn't
    // return this sub-user" and "unchanged within float noise").
    .filter((c): c is { id: string; user_id: string | null; gb_used: number; prevGbUsed: number } =>
      c.gb_used !== undefined && Math.abs(c.gb_used - c.prevGbUsed) > 0.0005
    )
    .map(({ id, user_id, gb_used, prevGbUsed }) => ({ id, user_id, gb_used, delta: gb_used - prevGbUsed }))
}

// Credits GB consumed since the last sync to today's (UTC) account-level bucket
// (usage_daily, migration 0062) — what lets usage history cover deleted sessions
// and accounts with many sessions without a supplier call per session. Only
// growth counts (a lower reading is a counter reset, not negative usage). Never throws.
export async function recordUsageDeltas(supabase: AdminClient, rows: { user_id: string; gb: number }[]) {
  const byUser = new Map<string, number>()
  for (const r of rows) if (r.user_id && r.gb > 0) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + r.gb)
  if (byUser.size === 0) return
  try {
    const { error } = await supabase.rpc('record_usage_deltas', {
      p_rows: [...byUser].map(([user_id, gb]) => ({ user_id, gb: Math.round(gb * 10000) / 10000 })),
    })
    if (error) console.error('[usage-sync] record_usage_deltas failed:', error)
  } catch (e) { console.error('[usage-sync] record_usage_deltas threw:', e) }
}

async function applyChanges(
  supabase: AdminClient,
  changes: UsageChange[]
) {
  if (changes.length > 0) {
    const { error } = await supabase.rpc('bulk_update_credential_usage', { updates: changes.map(({ id, gb_used }) => ({ id, gb_used })) })
    if (error) console.error('bulk_update_credential_usage failed:', error)
    else await recordUsageDeltas(supabase, changes.filter(c => c.user_id).map(c => ({ user_id: c.user_id as string, gb: c.delta })))
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
      .select('id, user_id, label, status, upstream_sub_user_id, gb_used, gb_allocated, auto_topup_enabled, auto_topup_insufficient_alerted_at, exhausted_alerted_at, low_alerted_pct, upstream_missing_since')
      .not('upstream_sub_user_id', 'is', null)
      .order('id')
      .range(from, to)
  )
  if (credsErr) throw new Error(`Could not load credentials for usage sync: ${credsErr}`)

  const { subUsers, complete } = await listAllSubUsers()
  const usageMap = new Map<string, number>()
  // A sub-user whose usage figure the provider omitted is simply left out:
  // absence means "no update", never "0 GB used".
  for (const [id, snap] of subUsers) if (snap.usedGb !== null) usageMap.set(id, snap.usedGb)

  const active = creds.filter(c => c.status === 'active')
  const changes = buildChanges(active, usageMap)
  const { recalcOk } = await applyChanges(supabase, changes)

  let limitsReconciled = 0
  let missingUpstream = 0
  let orphanCount = 0
  let exhaustedNotified = 0
  let lowNotified = 0
  let autoTopup: Awaited<ReturnType<typeof runAutoTopups>> | null = null

  if (complete) {
    const suspendedUsers = await loadSuspendedUserIds(supabase)
    limitsReconciled = await reconcileLimits(supabase, active, subUsers, suspendedUsers)
    missingUpstream = await trackMissingUpstream(supabase, active, subUsers)
    orphanCount = await sweepOrphans(supabase, creds, subUsers)
    exhaustedNotified = await notifyExhaustion(supabase, active, usageMap, suspendedUsers)
    lowNotified = await notifyLowBandwidth(supabase, active, usageMap, suspendedUsers)

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
    low_bandwidth_notices: lowNotified,
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
    const snap = subUsers.get(String(c.upstream_sub_user_id))
    if (!snap || snap.limitMb === null) continue // not on Geonode, or no limit reported — nothing to compare

    try {
      if (suspendedUsers.has(c.user_id)) {
        if (snap.usedMb === null) continue // unknown usage — don't guess a cap
        const cap = suspendedCapMb(snap.usedMb)
        if (snap.limitMb > cap + 1) {
          await updateSubUserTrafficLimit(c.upstream_sub_user_id, cap)
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

// Active credentials whose sub-user no longer exists upstream (deleted there
// directly, or by a failed-then-retried delete). Reported, not auto-fixed:
// deleting/refunding automatically on the strength of "absent from a
// listing" is exactly the kind of irreversible guess to avoid.
//
// Previously this only wrote a console line, so the customer's session was
// silently dead while the dashboard said "active". Now: the first complete
// listing that lacks a sub-user stamps proxy_credentials.upstream_missing_since
// (the dashboard shows a "needs attention" notice), and once it has stayed
// missing past a grace period (the listing can lag a just-created sub-user)
// the admin gets ONE email per incident. Clears itself when it reappears.
async function trackMissingUpstream(
  supabase: AdminClient,
  active: any[],
  subUsers: Map<string, SubUserSnapshot>
): Promise<number> {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const isMissing = (c: any) => !subUsers.has(String(c.upstream_sub_user_id))
  const missing = active.filter(isMissing)

  const recovered = active.filter((c) => c.upstream_missing_since && !isMissing(c))
  if (recovered.length > 0) {
    await supabase.from('proxy_credentials').update({ upstream_missing_since: null })
      .in('id', recovered.slice(0, 200).map((c) => c.id))
  }
  const fresh = missing.filter((c) => !c.upstream_missing_since)
  if (fresh.length > 0) {
    await supabase.from('proxy_credentials').update({ upstream_missing_since: nowIso })
      .in('id', fresh.slice(0, 200).map((c) => c.id)).is('upstream_missing_since', null)
  }

  const persistent = missing.filter(
    (c) => c.upstream_missing_since && nowMs - Date.parse(c.upstream_missing_since) >= UPSTREAM_MISSING_GRACE_MS
  )
  const { data: row } = await supabase
    .from('platform_settings').select('value').eq('key', 'upstream_missing_alerted_at').maybeSingle()

  if (persistent.length === 0) {
    if (row?.value) await supabase.from('platform_settings').delete().eq('key', 'upstream_missing_alerted_at')
    return missing.length
  }

  console.error(`[usage-sync] ${persistent.length} active credential(s) have no sub-user upstream:`, persistent.slice(0, 20).map((c) => c.id))
  if (!row?.value && process.env.ADMIN_EMAIL) {
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `[MISSING UPSTREAM] ${persistent.length} active session(s) have no live proxy behind them`,
      html: `<p>${persistent.length} credential(s) are marked <strong>active</strong> but their sub-user no longer exists at the
             proxy provider (seen on consecutive complete listings for over ${Math.round(UPSTREAM_MISSING_GRACE_MS / 60000)} minutes).
             Those customers' sessions do not work, and their dashboards now show a "needs attention" notice.</p>
             <p><strong>Credential ids (first 20):</strong> ${escapeHtml(persistent.slice(0, 20).map((c) => c.id).join(', '))}</p>
             <p>Nothing was changed automatically. Re-provision or refund them from the admin panel.</p>`,
    }).catch((e) => console.error('[usage-sync] missing-upstream alert email failed', e))
    await supabase.from('platform_settings')
      .upsert({ key: 'upstream_missing_alerted_at', value: nowIso }, { onConflict: 'key' })
  }
  return missing.length
}

// Sub-users that exist on Geonode, carry our naming prefix, and have no row
// in the database under ANY status. They are real, working, untracked
// proxies (a crash between the upstream create and the DB insert, a failed
// cleanup, or a create whose response we never saw). Each one holds a full
// traffic limit out of the reseller pool, so they are not just reported:
//
//  * one whose username is the saved provisioning identity of a PENDING credential
//    is not an orphan at all — the next retry adopts it (createOrAdoptSubUser);
//  * to avoid flagging one whose DB insert is merely in flight, an id must be seen
//    as an orphan on TWO consecutive runs before it is reported;
//  * a reported one that has stayed orphaned for ORPHAN_RECLAIM_AFTER_MS with
//    ZERO traffic is deleted upstream (no customer was ever handed it), a few per
//    run, which returns its limit to the pool. One with any usage is left for a human.
//
// platform_settings.geonode_orphan_candidates is { id: firstSeenISO } (older runs
// stored a plain id array — still read). Results land in
// platform_settings.geonode_orphans and the admin is emailed once per incident.
const ORPHAN_RECLAIM_AFTER_MS = 24 * 3_600_000
const MAX_ORPHAN_RECLAIMS_PER_RUN = 5

async function sweepOrphans(
  supabase: AdminClient,
  allCreds: any[],
  subUsers: Map<string, SubUserSnapshot>
): Promise<number> {
  const knownIds = new Set(allCreds.map(c => String(c.upstream_sub_user_id)))
  const { data: pendingRows } = await supabase
    .from('proxy_credentials').select('provision_username').eq('status', 'pending').not('provision_username', 'is', null)
  const adoptable = new Set((pendingRows ?? []).map((r: any) => r.provision_username as string))

  const candidates: string[] = []
  for (const [id, snap] of subUsers) {
    if (snap.username && snap.username.startsWith('gp_') && !knownIds.has(id) && !adoptable.has(snap.username)) candidates.push(id)
  }

  const { data: rows } = await supabase
    .from('platform_settings')
    .select('key, value')
    .in('key', ['geonode_orphan_candidates', 'geonode_orphans_alerted_at'])
  const settings = Object.fromEntries((rows ?? []).map((r: any) => [r.key, r.value]))

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  let previous: Record<string, string> = {}
  try {
    const parsed = JSON.parse(settings.geonode_orphan_candidates ?? '{}')
    if (Array.isArray(parsed)) for (const id of parsed) previous[String(id)] = nowIso
    else if (parsed && typeof parsed === 'object') previous = parsed
  } catch { /* reset */ }

  const firstSeen: Record<string, string> = {}
  for (const id of candidates) firstSeen[id] = previous[id] ?? nowIso
  const persistent = candidates.filter(id => previous[id] !== undefined)

  // Reclaim: long-lived, never-used orphans only.
  const reclaimed: string[] = []
  for (const id of persistent) {
    if (reclaimed.length >= MAX_ORPHAN_RECLAIMS_PER_RUN) break
    const snap = subUsers.get(id)
    if (!snap || snap.usedMb !== 0) continue // any traffic (or unknown usage) -> a human decides
    if (nowMs - Date.parse(firstSeen[id]) < ORPHAN_RECLAIM_AFTER_MS) continue
    try {
      await deleteSubUser(id)
      reclaimed.push(id)
    } catch (e: any) {
      if (e?.status === 404) reclaimed.push(id) // already gone
      else console.error('[usage-sync] could not reclaim orphan sub-user', id, e)
    }
  }
  if (reclaimed.length > 0) console.warn(`[usage-sync] reclaimed ${reclaimed.length} untracked, unused sub-user(s):`, reclaimed)
  const reclaimedSet = new Set(reclaimed)
  const remainingCandidates = Object.fromEntries(Object.entries(firstSeen).filter(([id]) => !reclaimedSet.has(id)))
  const stillPersistent = persistent.filter(id => !reclaimedSet.has(id))

  await supabase.from('platform_settings').upsert([
    { key: 'geonode_orphan_candidates', value: JSON.stringify(Object.fromEntries(Object.entries(remainingCandidates).slice(0, 500))) },
    { key: 'geonode_orphans', value: JSON.stringify({ count: stillPersistent.length, ids: stillPersistent.slice(0, 100), detected_at: nowIso, reclaimed_last_run: reclaimed.length }) },
  ], { onConflict: 'key' })

  if (stillPersistent.length === 0) {
    if (settings.geonode_orphans_alerted_at) {
      await supabase.from('platform_settings').delete().eq('key', 'geonode_orphans_alerted_at')
    }
    return 0
  }

  console.error(`[usage-sync] ${stillPersistent.length} orphan Geonode sub-user(s) with no local record:`, stillPersistent.slice(0, 20))
  if (!settings.geonode_orphans_alerted_at && process.env.ADMIN_EMAIL) {
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `[ORPHAN SUB-USERS] ${stillPersistent.length} Geonode sub-user(s) have no local record`,
      html: `<p>${stillPersistent.length} sub-user(s) on Geonode carry the <code>gp_</code> prefix but have no
             <code>proxy_credentials</code> row (seen on two consecutive usage syncs). They are live,
             untracked proxies — usually the result of a crash between the Geonode create and the database insert,
             or a create whose response was never received.</p>
             <p>Ones with zero traffic are deleted automatically after ${ORPHAN_RECLAIM_AFTER_MS / 3_600_000}h (their limit returns to your pool);
             ones with any usage stay for you to review.</p>
             <p><strong>Geonode sub-user ids (first 20):</strong> ${escapeHtml(stillPersistent.slice(0, 20).join(', '))}</p>
             <p>Full list: <code>platform_settings.geonode_orphans</code>.</p>`,
    }).catch((e) => console.error('[usage-sync] orphan alert email failed', e))
    await supabase.from('platform_settings')
      .upsert({ key: 'geonode_orphans_alerted_at', value: nowIso }, { onConflict: 'key' })
  }
  return stillPersistent.length
}

// A credential whose auto-allocate is genuinely going to act. Once the
// insufficient-balance / partial-funding flag is set, auto-allocate can NOT be
// relied on to keep the session alive, so it must NOT suppress the
// exhaustion / low-bandwidth notices (it used to: that customer got one
// "insufficient balance" email, possibly days earlier, and then silence at the
// moment the session actually died).
const autoTopupCovering = (c: any) => !!c.auto_topup_enabled && !c.auto_topup_insufficient_alerted_at

async function firstName(supabase: AdminClient, userId: string) {
  // Ask for the opt-out column first; if migration 0063 isn't applied yet that
  // select errors, and treating the error as "no profile" would silently stop
  // EVERY notice e-mail (exhaustion included) until the migration runs — so
  // fall back to the columns that have always existed.
  let { data: profile, error } = await supabase
    .from('profiles').select('email, full_name, low_bandwidth_emails').eq('id', userId).single()
  if (error) {
    ;({ data: profile } = await supabase
      .from('profiles').select('email, full_name').eq('id', userId).single() as any)
  }
  const p = profile as any
  return {
    email: p?.email as string | undefined,
    name: escapeHtml(p?.full_name?.split(' ')[0]) || 'there',
    // Opt-out for the advisory "running low" e-mail only (migration 0063).
    // Anything unknown (column not migrated yet, null) keeps today's behaviour.
    lowEmails: p?.low_bandwidth_emails !== false,
  }
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
    const used = usageMap.get(String(c.upstream_sub_user_id)) ?? Number(c.gb_used ?? 0)
    const exhausted = used >= Number(c.gb_allocated) - EPS
    if (!exhausted) {
      if (c.exhausted_alerted_at) rearm.push(c.id)
      continue
    }
    if (c.exhausted_alerted_at || autoTopupCovering(c) || suspendedUsers.has(c.user_id)) continue
    due.push({ ...c, used })
  }

  if (rearm.length > 0) {
    await supabase.from('proxy_credentials').update({ exhausted_alerted_at: null }).in('id', rearm.slice(0, 200))
  }

  let sent = 0
  for (const [idx, c] of due.slice(0, MAX_WEBHOOK_EVENTS_PER_RUN).entries()) {
    const emailDue = idx < MAX_EXHAUSTION_NOTICES_PER_RUN
    // Claim BEFORE sending (guarded on the flag still being empty), like the
    // low-bandwidth notice: the admin "sync all" button runs this outside the cron
    // lock, so two overlapping runs could otherwise both email and both fire the webhook.
    const { data: claimed } = await supabase.from('proxy_credentials')
      .update({ exhausted_alerted_at: new Date().toISOString() })
      .eq('id', c.id).is('exhausted_alerted_at', null).select('id')
    if (!claimed?.length) continue
    const { email, name } = emailDue ? await firstName(supabase, c.user_id) : { email: null, name: '' }
    const autoStuck = !!c.auto_topup_enabled // enabled but flagged: it could not top this session up
    if (email) {
      await sendEmail({
        to: email,
        subject: `Your proxy session ran out of bandwidth — GlobProxy`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
            <h2 style="text-align:center;color:#111;">Session out of bandwidth</h2>
            <p style="color:#444;text-align:center;">
              Hi ${name}, your session
              <strong>${escapeHtml(c.label || 'Unnamed')}</strong> has used its full
              ${Number(c.gb_allocated).toFixed(2)} GB allocation and has stopped connecting.
              ${autoStuck
                ? 'Auto-allocate is on but your account balance has no bandwidth left to add — buy more and the session will be topped up automatically.'
                : 'Top it up from your dashboard to resume, or turn on auto-allocate so this doesn\'t happen again.'}
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${appUrl()}${autoStuck ? '/dashboard/buy' : '/dashboard/proxies'}"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                ${autoStuck ? 'Buy bandwidth →' : 'Open my sessions →'}
              </a>
            </div>
          </div>`,
      }).catch((e) => console.error('[usage-sync] exhaustion email failed', c.id, e))
    }
    // defer: delivered by the 'webhooks' task, so a customer's slow endpoint
    // can't hold up this sync for everyone else.
    await dispatchWebhook(c.user_id, 'session_exhausted', {
      credential_id: c.id,
      label: c.label ?? null,
      gb_allocated: Number(c.gb_allocated),
      gb_used: c.used,
    }, { defer: true }).catch((e) => console.error('[webhooks] session_exhausted dispatch threw', c.id, e))
    sent++
  }
  return sent
}

// Per-session "running low" notice at 80% and 95% used. Before this a single
// session only produced a signal at 100% — too late for a scraper mid-job.
// One notice per tier crossed (80 then 95); the flag re-arms when usage falls
// back under 80% (a top-up / release). At most one EMAIL per customer per run
// (others stay due for the next 5-minute tick), and the webhook carries every
// crossing. Skipped for sessions auto-allocate is genuinely covering and for
// suspended owners; 100% is notifyExhaustion's job.
async function notifyLowBandwidth(
  supabase: AdminClient,
  active: any[],
  usageMap: Map<string, number>,
  suspendedUsers: Set<string>
): Promise<number> {
  const rearm: string[] = []
  const due: any[] = []

  for (const c of active) {
    const allocated = Number(c.gb_allocated)
    if (!(allocated > 0)) continue
    const used = usageMap.get(String(c.upstream_sub_user_id)) ?? Number(c.gb_used ?? 0)
    const pct = (used / allocated) * 100
    const tier = pct >= 95 ? 95 : pct >= 80 ? 80 : 0
    if (tier === 0) {
      if (c.low_alerted_pct) rearm.push(c.id)
      continue
    }
    if (pct >= 99.95) continue // exhausted — handled separately
    if (autoTopupCovering(c) || suspendedUsers.has(c.user_id)) continue
    if (c.low_alerted_pct && c.low_alerted_pct >= tier) continue
    due.push({ ...c, used, pct, tier })
  }

  if (rearm.length > 0) {
    await supabase.from('proxy_credentials').update({ low_alerted_pct: null }).in('id', rearm.slice(0, 200))
  }

  let sent = 0
  const emailed = new Set<string>()
  let emailsSent = 0
  for (const c of due) {
    if (sent >= MAX_WEBHOOK_EVENTS_PER_RUN) break
    // E-mail: one per customer per tick and a capped number overall. The
    // webhook below is NOT subject to either limit.
    const emailDue = !emailed.has(c.user_id) && emailsSent < MAX_LOW_NOTICES_PER_RUN
    if (emailDue) { emailed.add(c.user_id); emailsSent++ }

    // Claim before sending: a duplicate notice is worse than a lost one.
    const { data: claimed } = await supabase.from('proxy_credentials')
      .update({ low_alerted_pct: c.tier }).eq('id', c.id).select('id')
    if (!claimed?.length) continue

    const remaining = Math.max(0, Number(c.gb_allocated) - c.used)
    const { email, name, lowEmails } = emailDue ? await firstName(supabase, c.user_id) : { email: null, name: '', lowEmails: false }
    if (email && lowEmails) {
      await sendEmail({
        to: email,
        subject: `Your proxy session is ${c.tier}% used — GlobProxy`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
            <h2 style="text-align:center;color:#111;">Session running low</h2>
            <p style="color:#444;text-align:center;">
              Hi ${name}, your session <strong>${escapeHtml(c.label || 'Unnamed')}</strong> has used
              ${c.tier}% of its ${Number(c.gb_allocated).toFixed(2)} GB allocation —
              about ${remaining.toFixed(2)} GB left. Top it up from your dashboard, or turn on auto-allocate
              so it never stops mid-job.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${appUrl()}/dashboard/proxies"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Open my sessions →
              </a>
            </div>
          </div>`,
      }).catch((e) => console.error('[usage-sync] low-bandwidth email failed', c.id, e))
    }
    await dispatchWebhook(c.user_id, 'session_low', {
      credential_id: c.id,
      label: c.label ?? null,
      threshold_pct: c.tier,
      used_pct: Math.round(c.pct * 100) / 100,
      gb_allocated: Number(c.gb_allocated),
      gb_used: c.used,
      gb_remaining: Math.round(remaining * 10000) / 10000,
    }, { defer: true }).catch((e) => console.error('[webhooks] session_low dispatch threw', c.id, e))
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
    .select('id, user_id, upstream_sub_user_id, gb_used')
    .eq('status', 'active')
    .eq('user_id', userId)
    .not('upstream_sub_user_id', 'is', null)

  const usageMap = new Map<string, number>()
  let failures = 0
  for (const c of creds ?? []) {
    if (!c.upstream_sub_user_id) continue
    try {
      usageMap.set(c.upstream_sub_user_id, await getSubUserUsage(c.upstream_sub_user_id))
    } catch (e) {
      // Non-fatal per credential — a transient failure on one sub-user
      // shouldn't block reconciling the rest of this user's credentials.
      failures++
      console.error('Live usage fetch failed for', c.upstream_sub_user_id, e)
    }
  }

  const changes = buildChanges(creds ?? [], usageMap)
  const { recalcOk } = await applyChanges(supabase, changes)
  // Settles this user's auto-top-ups immediately rather than waiting for the
  // next full tick — but not on a partial read of their usage.
  const autoTopup = failures === 0 ? await runAutoTopups(userId) : null
  return { updated_credentials: changes.length, recalc_ok: recalcOk, usage_fetch_failures: failures, auto_topup: autoTopup }
}
