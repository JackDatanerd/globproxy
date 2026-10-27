import { createAdminClient } from '@/lib/supabase/server'
import { listAllSubUsers, getSubUserUsage, updateSubUserTrafficLimit, deleteSubUser, type SubUserSnapshot } from '@/lib/upstream'
import { runAutoTopups } from '@/lib/autoTopup'
import { fetchAllRows } from '@/lib/dbPaging'
import { recordUsageDeltas } from '@/lib/usageLedger'
import { syncCredentialLimit, expectedLimitMb, suspendedCapMb, loadSuspendedUserIds, UPSTREAM_MISSING_GRACE_MS } from '@/lib/credentials'
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
// every upstream PATCH / Supabase write / email counts against it, so each
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

type UsageChange = { id: string; gb_used: number; user_id: string | null; delta: number }

function buildChanges(creds: CredRow[], usageMap: Map<string, number>): UsageChange[] {
  return creds
    .map(cred => ({
      id: cred.id,
      user_id: cred.user_id ?? null,
      gb_used: cred.upstream_sub_user_id ? usageMap.get(cred.upstream_sub_user_id) : undefined,
      prevGbUsed: cred.gb_used ?? 0,
    }))
    // Only write rows that actually changed (skip both "Upstream didn't
    // return this sub-user" and "unchanged within float noise").
    .filter((c): c is { id: string; user_id: string | null; gb_used: number; prevGbUsed: number } =>
      c.gb_used !== undefined && Math.abs(c.gb_used - c.prevGbUsed) > 0.0005
    )
    .map(({ id, user_id, gb_used, prevGbUsed }) => ({ id, user_id, gb_used, delta: gb_used - prevGbUsed }))
}

export { recordUsageDeltas }

// Rows per bulk_update_credential_usage call. One giant jsonb payload for a big fleet
// can exceed the statement timeout / request size and fail as a whole — every row's
// usage then stays stale while the rest of the sync looks fine.
const BULK_UPDATE_CHUNK = 500

async function applyChanges(
  supabase: AdminClient,
  changes: UsageChange[]
) {
  let bulkOk = true
  for (let i = 0; i < changes.length; i += BULK_UPDATE_CHUNK) {
    const chunk = changes.slice(i, i + BULK_UPDATE_CHUNK)
    const { data: written, error } = await supabase.rpc('bulk_update_credential_usage', { updates: chunk.map(({ id, gb_used }) => ({ id, gb_used })) })
    if (error) {
      bulkOk = false
      console.error('bulk_update_credential_usage failed:', error)
    } else {
      // Credited only for rows that were actually written, and only for what this write
      // changed: the function returns the gb_used it replaced, which can differ from the snapshot
      // this run read minutes earlier (a live refresh or another sync moved it in between —
      // crediting the snapshot delta then counted that slice twice). An empty result means the
      // function predates migration 0100: fall back to the snapshot delta.
      const replaced = new Map<string, number>()
      if (Array.isArray(written)) for (const w of written as { id: string; prev: number | string }[]) replaced.set(w.id, Number(w.prev))
      await recordUsageDeltas(supabase, chunk.filter(c => c.user_id).map(c => {
        const prev = replaced.get(c.id)
        return { user_id: c.user_id as string, gb: prev === undefined ? c.delta : c.gb_used - prev }
      }))
    }
  }
  // Always recalc, even with zero changes — a previous partial failure
  // should still get corrected on the next call.
  const { error: recalcErr } = await supabase.rpc('recalculate_bandwidth_accounts')
  if (recalcErr) console.error('recalculate_bandwidth_accounts failed:', recalcErr)
  // "Usage sync is healthy" means the per-credential usage WAS WRITTEN and the account
  // totals were recalculated from it. The recalculation alone succeeding on top of a
  // failed write used to stamp the freshness marker while every gb_used stayed stale.
  return { recalcOk: !recalcErr, bulkOk, healthy: bulkOk && !recalcErr }
}

// Full sync — every active credential across every user. This is what the
// cron task runs every ~5 minutes, and what the admin "sync all" button
// triggers on demand.
//
// If upstream's listing is INCOMPLETE (outage, revoked key, timeout) this
// still applies whatever it did get — that is safe, absence just means "no
// update" — but it does NOT stamp the freshness marker, does NOT run
// auto-top-ups on stale usage, and finishes by THROWING so the cron/admin
// caller sees a failure. It used to return normally with recalcOk=true, so a
// total upstream outage looked healthy and the staleness watchdog (which
// reads that marker) never fired.
// `admin` is injectable only so tests can drive this with a fake client; callers omit it.
export async function syncAllUsage(admin?: AdminClient) {
  const supabase = admin ?? await createAdminClient()

  // Paginated: PostgREST silently truncates a plain select at 1000 rows.
  const { rows: creds, error: credsErr } = await fetchAllRows<any>((from, to) =>
    supabase
      .from('proxy_credentials')
      .select('id, user_id, label, status, created_by, upstream_sub_user_id, gb_used, gb_allocated, auto_topup_enabled, auto_topup_insufficient_alerted_at, exhausted_alerted_at, low_alerted_pct, upstream_missing_since')
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
  const { recalcOk, bulkOk, healthy } = await applyChanges(supabase, changes)

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
    if (healthy) {
      // Per-session "usage as of" marker: the cron sync never set it, so the API/dashboard
      // reported a stale or empty usage_synced_at for every session that wasn't manually
      // refreshed. Stamped for sessions whose figure was actually read this run; best effort
      // and bounded (200 ids per write, at most 10 writes) so it can't eat the subrequest budget.
      try {
        const nowIso = new Date().toISOString()
        const ids = active.filter(c => usageMap.has(String(c.upstream_sub_user_id))).map(c => c.id)
        for (let i = 0, n = 0; i < ids.length && n < 10; i += 200, n++) {
          const { error } = await supabase.from('proxy_credentials').update({ usage_synced_at: nowIso }).in('id', ids.slice(i, i + 200))
          if (error) { console.error('[usage-sync] could not stamp usage_synced_at', error); break }
        }
      } catch (e) { console.error('[usage-sync] usage_synced_at stamp failed', e) }
      await supabase.from('platform_settings')
        .upsert({ key: 'usage_last_synced_at', value: new Date().toISOString() }, { onConflict: 'key' })
    }
  }

  const summary = {
    updated_credentials: changes.length,
    recalc_ok: recalcOk,
    usage_write_ok: bulkOk,
    upstream_listing_complete: complete,
    limits_reconciled: limitsReconciled,
    missing_upstream: missingUpstream,
    orphan_sub_users: orphanCount,
    exhaustion_notices: exhaustedNotified,
    low_bandwidth_notices: lowNotified,
    auto_topup: autoTopup,
  }

  if (!complete) {
    throw new Error(`Upstream sub-user listing was incomplete — usage NOT marked fresh (applied ${changes.length} partial updates)`)
  }
  if (!healthy) {
    throw new Error(`Usage sync could not write usage (${!bulkOk ? 'per-credential update failed' : 'account recalculation failed'}) — usage NOT marked fresh`)
  }
  return summary
}

// ─── Limit reconciliation ────────────────────────────────────────────────
// Brings upstream's live trafficLimitMB back in line with what the database
// says the customer owns. Drift comes from: a top-up whose PATCH failed or
// landed out of order, auto-top-up PATCH failures, a credential created
// before a top-up finished provisioning, or a manual change on upstream's
// dashboard. Before this existed, a failed PATCH was only logged
// ("needs manual reconciliation") and nothing ever retried — and auto-top-up
// couldn't self-heal because the DB already showed plenty of remaining GB.
//
// Suspended owners get the opposite treatment: their cap is held at
// (used + headroom), which is what makes admin suspension actually cut
// traffic off for any credential lib/adminProxy.ts failed to disable.
// Bounded by ATTEMPTS, not successes: a provider whose PATCH endpoint is failing (while
// the listing still works) used to be hammered once per drifted credential — each failed
// call can hold the Worker for the full request timeout — until the invocation died and
// took the notices, auto-top-ups and the freshness stamp down with it. A few failures in
// a row also end the pass: the next tick tries again.
const MAX_CONSECUTIVE_LIMIT_FAILURES = 3

async function reconcileLimits(
  supabase: AdminClient,
  active: any[],
  subUsers: Map<string, SubUserSnapshot>,
  suspendedUsers: Set<string>
): Promise<number> {
  let patched = 0
  let attempts = 0
  let consecutiveFailures = 0
  for (const c of active) {
    if (attempts >= MAX_LIMIT_PATCHES_PER_RUN || consecutiveFailures >= MAX_CONSECUTIVE_LIMIT_FAILURES) break
    const snap = subUsers.get(String(c.upstream_sub_user_id))
    if (!snap || snap.limitMb === null) continue // not on upstream, or no limit reported — nothing to compare

    try {
      if (suspendedUsers.has(c.user_id)) {
        if (snap.usedMb === null) continue // unknown usage — don't guess a cap
        const cap = suspendedCapMb(snap.usedMb)
        if (snap.limitMb > cap + 1) {
          attempts++
          await updateSubUserTrafficLimit(c.upstream_sub_user_id, cap)
          patched++
          consecutiveFailures = 0
        }
        continue
      }

      const expected = expectedLimitMb(Number(c.gb_allocated))
      // ±1 MB tolerates rounding between GB (4dp) and whole MB.
      if (Math.abs(snap.limitMb - expected) > 1) {
        attempts++
        // syncCredentialLimit re-reads gb_allocated immediately before the
        // PATCH, so a top-up that committed after this run's snapshot is not
        // overwritten with a stale number.
        const warning = await syncCredentialLimit(supabase, c.id)
        if (!warning) { patched++; consecutiveFailures = 0 } else consecutiveFailures++
      }
    } catch (e) {
      consecutiveFailures++
      console.error('[usage-sync] limit reconcile failed for', c.id, e)
    }
  }
  if (patched > 0) console.log(`[usage-sync] reconciled ${patched} upstream limit(s)`)
  if (consecutiveFailures >= MAX_CONSECUTIVE_LIMIT_FAILURES) console.error('[usage-sync] limit reconcile stopped after repeated failures — retrying next tick')
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

// Sub-users that exist on upstream, carry our naming prefix, and have no row
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
// platform_settings.upstream_orphan_candidates is { id: firstSeenISO } (older runs
// stored a plain id array — still read). Results land in
// platform_settings.upstream_orphans and the admin is emailed once per incident.
const ORPHAN_REPORT_KEY = 'upstream_orphans'
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
    .in('key', ['upstream_orphan_candidates', 'upstream_orphans_alerted_at'])
  const settings = Object.fromEntries((rows ?? []).map((r: any) => [r.key, r.value]))

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  let previous: Record<string, string> = {}
  try {
    const parsed = JSON.parse(settings.upstream_orphan_candidates ?? '{}')
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
    { key: 'upstream_orphan_candidates', value: JSON.stringify(Object.fromEntries(Object.entries(remainingCandidates).slice(0, 500))) },
    { key: ORPHAN_REPORT_KEY, value: JSON.stringify({ count: stillPersistent.length, ids: stillPersistent.slice(0, 100), detected_at: nowIso, reclaimed_last_run: reclaimed.length }) },
  ], { onConflict: 'key' })

  if (stillPersistent.length === 0) {
    if (settings.upstream_orphans_alerted_at) {
      await supabase.from('platform_settings').delete().eq('key', 'upstream_orphans_alerted_at')
    }
    return 0
  }

  console.error(`[usage-sync] ${stillPersistent.length} orphan upstream sub-user(s) with no local record:`, stillPersistent.slice(0, 20))
  if (!settings.upstream_orphans_alerted_at && process.env.ADMIN_EMAIL) {
    await sendEmail({
      to: process.env.ADMIN_EMAIL,
      subject: `[ORPHAN SUB-USERS] ${stillPersistent.length} upstream sub-user(s) have no local record`,
      html: `<p>${stillPersistent.length} sub-user(s) on upstream carry the <code>gp_</code> prefix but have no
             <code>proxy_credentials</code> row (seen on two consecutive usage syncs). They are live,
             untracked proxies — usually the result of a crash between the upstream create and the database insert,
             or a create whose response was never received.</p>
             <p>Ones with zero traffic are deleted automatically after ${ORPHAN_RECLAIM_AFTER_MS / 3_600_000}h (their limit returns to your pool);
             ones with any usage stay for you to review.</p>
             <p><strong>upstream sub-user ids (first 20):</strong> ${escapeHtml(stillPersistent.slice(0, 20).join(', '))}</p>
             <p>Full list: <code>platform_settings.upstream_orphans</code>.</p>`,
    }).catch((e) => console.error('[usage-sync] orphan alert email failed', e))
    await supabase.from('platform_settings')
      .upsert({ key: 'upstream_orphans_alerted_at', value: nowIso }, { onConflict: 'key' })
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

// The two session notices share one e-mail path so a notice that was claimed in one
// tick but not e-mailed (cap reached) can be sent by the next tick from the
// *_email_due flag (migration 0079) with exactly the same wording.
//
// A reseller-allocated session (created_by set) cannot be topped up or have
// auto-allocate turned on by its holder, so those two suggestions are replaced by
// "contact your reseller" instead of pointing at buttons that answer 403.
async function sendExhaustionEmail(supabase: AdminClient, c: any, used?: number) {
  const { email, name } = await firstName(supabase, c.user_id)
  if (!email) return
  const reseller = !!c.created_by
  const autoStuck = !reseller && !!c.auto_topup_enabled // enabled but flagged: it could not top this session up
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
          ${reseller
            ? 'This allocation was made by your reseller — contact them to have it increased.'
            : autoStuck
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

async function sendLowEmail(supabase: AdminClient, c: any, tier: number, usedGb: number) {
  const { email, name, lowEmails } = await firstName(supabase, c.user_id)
  if (!email || !lowEmails) return
  const remaining = Math.max(0, Number(c.gb_allocated) - usedGb)
  const reseller = !!c.created_by
  await sendEmail({
    to: email,
    subject: `Your proxy session is ${tier}% used — GlobProxy`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
        <h2 style="text-align:center;color:#111;">Session running low</h2>
        <p style="color:#444;text-align:center;">
          Hi ${name}, your session <strong>${escapeHtml(c.label || 'Unnamed')}</strong> has used
          ${tier}% of its ${Number(c.gb_allocated).toFixed(2)} GB allocation —
          about ${remaining.toFixed(2)} GB left. ${reseller
            ? 'This allocation was made by your reseller — contact them if you need more.'
            : 'Top it up from your dashboard, or turn on auto-allocate so it never stops mid-job.'}
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
    await supabase.from('proxy_credentials')
      .update({ exhausted_alerted_at: null, exhausted_email_due: false }).in('id', rearm.slice(0, 200))
  }

  let sent = 0
  let emailsSent = 0
  for (const c of due.slice(0, MAX_WEBHOOK_EVENTS_PER_RUN)) {
    const emailDue = emailsSent < MAX_EXHAUSTION_NOTICES_PER_RUN
    // Claim BEFORE sending (guarded on the flag still being empty), like the
    // low-bandwidth notice: the admin "sync all" button runs this outside the cron
    // lock, so two overlapping runs could otherwise both email and both fire the webhook.
    // A session that gets no e-mail slot this tick is marked owed one (migration 0079):
    // the flag that stops repeats is set either way, so without that mark it was
    // never e-mailed at all.
    const { data: claimed } = await supabase.from('proxy_credentials')
      .update({ exhausted_alerted_at: new Date().toISOString(), exhausted_email_due: !emailDue })
      .eq('id', c.id).is('exhausted_alerted_at', null).select('id')
    if (!claimed?.length) continue
    if (emailDue) { emailsSent++; await sendExhaustionEmail(supabase, c) }
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

  // E-mails owed from earlier ticks, within what is left of this tick's allowance.
  if (emailsSent < MAX_EXHAUSTION_NOTICES_PER_RUN) {
    const { data: owed } = await supabase.from('proxy_credentials')
      .select('id, user_id, label, created_by, gb_allocated, auto_topup_enabled')
      .eq('status', 'active').eq('exhausted_email_due', true).not('exhausted_alerted_at', 'is', null)
      .limit(MAX_EXHAUSTION_NOTICES_PER_RUN - emailsSent)
    for (const c of owed ?? []) {
      const { data: took } = await supabase.from('proxy_credentials')
        .update({ exhausted_email_due: false }).eq('id', c.id).eq('exhausted_email_due', true).select('id')
      if (!took?.length) continue
      if (suspendedUsers.has(c.user_id)) continue
      await sendExhaustionEmail(supabase, c)
    }
  }
  return sent
}

// Per-session "running low" notice at 80% and 95% used. Before this a single
// session only produced a signal at 100% — too late for a scraper mid-job.
// One notice per tier crossed (warn then urgent — 80 then 95 unless the customer chose
// others); the flag re-arms when usage falls back under the warn level (a top-up / release). At most one EMAIL per customer per run
// (the rest are owed one — low_email_due — and go out on the following ticks), and
// the webhook carries every crossing. Skipped for sessions auto-allocate is
// genuinely covering and for suspended owners; 100% is notifyExhaustion's job.
async function notifyLowBandwidth(
  supabase: AdminClient,
  active: any[],
  usageMap: Map<string, number>,
  suspendedUsers: Set<string>
): Promise<number> {
  const rearm: string[] = []
  const due: any[] = []

  // Each customer picks their own heads-up / about-to-stop levels (Settings → E-mail
  // notifications; defaults 80 / 95). Unreadable rows (column not migrated, query error) fall
  // back to the defaults so alerts never go silent.
  const limits = new Map<string, { warn: number; urgent: number }>()
  const owners = [...new Set(active.map((c) => String(c.user_id)))]
  for (let i = 0; i < owners.length; i += 200) {
    const { data, error } = await supabase.from('profiles')
      .select('id, usage_warn_pct, usage_urgent_pct').in('id', owners.slice(i, i + 200))
    if (error) { console.error('[usage-sync] could not read alert thresholds, using defaults', error); break }
    for (const r of data ?? []) {
      const warn = Number((r as any).usage_warn_pct), urgent = Number((r as any).usage_urgent_pct)
      if (Number.isFinite(warn) && Number.isFinite(urgent) && warn >= 50 && warn < urgent && urgent <= 99) {
        limits.set(String((r as any).id), { warn, urgent })
      }
    }
  }

  for (const c of active) {
    const allocated = Number(c.gb_allocated)
    if (!(allocated > 0)) continue
    const used = usageMap.get(String(c.upstream_sub_user_id)) ?? Number(c.gb_used ?? 0)
    const pct = (used / allocated) * 100
    const lim = limits.get(String(c.user_id)) ?? { warn: 80, urgent: 95 }
    const tier = pct >= lim.urgent ? lim.urgent : pct >= lim.warn ? lim.warn : 0
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
    await supabase.from('proxy_credentials')
      .update({ low_alerted_pct: null, low_email_due: false }).in('id', rearm.slice(0, 200))
  }

  let sent = 0
  const emailed = new Set<string>()
  let emailsSent = 0
  for (const c of due) {
    if (sent >= MAX_WEBHOOK_EVENTS_PER_RUN) break
    // E-mail: one per customer per tick and a capped number overall. The
    // webhook below is NOT subject to either limit.
    const emailDue = !emailed.has(c.user_id) && emailsSent < MAX_LOW_NOTICES_PER_RUN

    // Claim before sending: a duplicate notice is worse than a lost one. Guarded on
    // the tier still being the one this run saw, so two overlapping runs (the admin
    // "sync all" button is outside the cron lock) cannot both claim the same crossing.
    let claim = supabase.from('proxy_credentials')
      .update({ low_alerted_pct: c.tier, low_email_due: !emailDue }).eq('id', c.id)
    claim = c.low_alerted_pct ? claim.eq('low_alerted_pct', c.low_alerted_pct) : claim.is('low_alerted_pct', null)
    const { data: claimed } = await claim.select('id')
    if (!claimed?.length) continue

    if (emailDue) {
      emailed.add(c.user_id); emailsSent++
      await sendLowEmail(supabase, c, c.tier, c.used)
    }
    await dispatchWebhook(c.user_id, 'session_low', {
      credential_id: c.id,
      label: c.label ?? null,
      threshold_pct: c.tier,
      used_pct: Math.round(c.pct * 100) / 100,
      gb_allocated: Number(c.gb_allocated),
      gb_used: c.used,
      gb_remaining: Math.round(Math.max(0, Number(c.gb_allocated) - c.used) * 10000) / 10000,
    }, { defer: true }).catch((e) => console.error('[webhooks] session_low dispatch threw', c.id, e))
    sent++
  }

  // Owed e-mails (claimed in an earlier tick without an e-mail slot), still one per
  // customer per tick.
  if (emailsSent < MAX_LOW_NOTICES_PER_RUN) {
    const { data: owed } = await supabase.from('proxy_credentials')
      .select('id, user_id, label, created_by, gb_allocated, gb_used, low_alerted_pct, upstream_sub_user_id')
      .eq('status', 'active').eq('low_email_due', true).not('low_alerted_pct', 'is', null)
      .limit(MAX_LOW_NOTICES_PER_RUN * 2)
    for (const c of owed ?? []) {
      if (emailsSent >= MAX_LOW_NOTICES_PER_RUN) break
      if (emailed.has(c.user_id)) continue
      const { data: took } = await supabase.from('proxy_credentials')
        .update({ low_email_due: false }).eq('id', c.id).eq('low_email_due', true).select('id')
      if (!took?.length) continue
      if (suspendedUsers.has(c.user_id)) continue
      emailed.add(c.user_id); emailsSent++
      const used = usageMap.get(String(c.upstream_sub_user_id)) ?? Number(c.gb_used ?? 0)
      await sendLowEmail(supabase, c, Number(c.low_alerted_pct), used)
    }
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
  const { data: creds, error: credsErr } = await supabase
    .from('proxy_credentials')
    .select('id, user_id, upstream_sub_user_id, gb_used')
    .eq('status', 'active')
    .eq('user_id', userId)
    .not('upstream_sub_user_id', 'is', null)
  // An unreadable list is not "this user has nothing to sync": say so instead of
  // reporting a clean, empty run.
  if (credsErr) throw new Error(`Could not load credentials for usage sync: ${credsErr.message}`)

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
  const { recalcOk, bulkOk } = await applyChanges(supabase, changes)
  // Settles this user's auto-top-ups immediately rather than waiting for the
  // next full tick — but not on a partial read of their usage.
  const autoTopup = failures === 0 ? await runAutoTopups(userId) : null
  return { updated_credentials: changes.length, recalc_ok: recalcOk, usage_write_ok: bulkOk, usage_fetch_failures: failures, auto_topup: autoTopup }
}

// Untracked supplier-side proxies found by the orphan sweep, for the admin credentials page.
export async function readOrphanReport(supabase: AdminClient): Promise<{ count: number; ids: string[] } | null> {
  const { data } = await supabase.from('platform_settings').select('value').eq('key', ORPHAN_REPORT_KEY).maybeSingle()
  try {
    const o = data?.value ? JSON.parse(data.value) : null
    return o && o.count > 0 ? { count: Number(o.count), ids: Array.isArray(o.ids) ? o.ids.map(String) : [] } : null
  } catch { return null }
}
