import { createAdminClient } from '@/lib/supabase/server'
import { sendEmailSafe } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'
import { logSecurityEvent } from '@/lib/securityEvents'
import { performAccountDeletion, countInFlightPayments, purgeAccountSecrets } from '@/lib/accountDeletion'
import { deletionReminderEmail, deletionCompleteEmail } from '@/lib/accountDeletionEmail'
import { DELETION_ALERT_AFTER_ATTEMPTS, DELETION_REMINDER_HOURS } from '@/lib/deletionSchedule'
import { scrubSupplier } from '@/lib/supplierGuard'
import { escapeHtml } from '@/lib/email'

// Hourly 'deletions' task:
//   1. runs deletions whose cool-off has ended (customer-scheduled, see
//      app/api/user/delete-account),
//   2. sends the one reminder inside the last 24 hours,
//   3. retries deletions that finished with leftovers (a supplier sub-user or a secret
//      that could not be removed at the time),
//   4. settles the bandwidth accounting of released credentials that missed it.
// Each deletion talks to the supplier, and a Worker invocation has a bounded subrequest
// budget shared with the rest of the hourly chain — so a few per run; the rest follow
// next hour. Never throws: it runs in front of the stock watchdogs.
const MAX_DELETIONS_PER_RUN = 5
const MAX_CLEANUPS_PER_RUN = 10
const MAX_REMINDERS_PER_RUN = 50

// One retry of the leftovers of a finished deletion (also what the admin's "retry cleanup now"
// button runs). Records the outcome on the profile and tells the admin once, when the retries
// reach DELETION_ALERT_AFTER_ATTEMPTS.
export async function retryAccountCleanup(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  userId: string,
  attemptsSoFar: number,
): Promise<{ cleared: boolean; warnings: string[] }> {
  const purge = await purgeAccountSecrets(supabase, userId)
  const attempts = attemptsSoFar + 1
  if (purge.warnings.length === 0) {
    await supabase.from('profiles').update({ deletion_cleanup_pending: false, deletion_cleanup_notes: null, deletion_attempts: 0, deletion_last_attempt_at: null }).eq('id', userId)
    return { cleared: true, warnings: [] }
  }
  await supabase.from('profiles').update({
    deletion_attempts: attempts, deletion_cleanup_notes: purge.warnings.join('\n').slice(0, 4000), deletion_last_attempt_at: new Date().toISOString(),
  }).eq('id', userId)
  if (attempts === DELETION_ALERT_AFTER_ATTEMPTS && process.env.ADMIN_EMAIL) {
    await sendEmailSafe({
      to: process.env.ADMIN_EMAIL,
      subject: '[ACCOUNT DELETION] cleanup of a deleted account keeps failing',
      html: `<p>Account <code>${userId}</code> was deleted, but ${purge.warnings.length} cleanup step(s) still fail after ${attempts} retries:</p>
             <pre style="white-space:pre-wrap">${purge.warnings.map((w) => escapeHtml(w)).join('\n')}</pre>
             <p><a href="${appUrl()}/admin/users/${userId}">Open the account</a></p>`,
    })
  }
  return { cleared: false, warnings: purge.warnings }
}

export async function runAccountDeletions() {
  const out: Record<string, unknown> = { executed: 0, postponed: 0, failed: 0, reminded: 0, cleanup_retried: 0, cleanup_cleared: 0, settled: 0 }
  const problems: string[] = []
  try {
    const supabase = await createAdminClient()
    const nowIso = new Date().toISOString()

    // ── 1. Due deletions ──────────────────────────────────────────────
    const { data: due, error: dueErr } = await supabase.from('profiles')
      
      .select('id').or('is_deleted.is.null,is_deleted.eq.false').not('deletion_scheduled_at', 'is', null)
      .lte('deletion_scheduled_at', nowIso)
      // Accounts not yet tried this cycle first, then the ones that failed longest ago: a
      // deletion that keeps failing (a payment stuck in flight, a supplier error) used to sit
      // at the front of the queue every hour, and MAX_DELETIONS_PER_RUN of them blocked every
      // other customer's erasure.
      .order('deletion_last_attempt_at', { ascending: true, nullsFirst: true })
      .order('deletion_scheduled_at', { ascending: true }).limit(MAX_DELETIONS_PER_RUN)
    if (dueErr) problems.push(`could not read due deletions: ${dueErr.message}`)

    for (const { id } of due ?? []) {
      try {
        const { data: before } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle()
        if (!before || before.is_deleted) continue
        // Cancelled since the list above was read (each account before this one took a trip to
        // the supplier). The claim below re-checks it atomically; this saves the round trips.
        if (!before.deletion_scheduled_at || new Date(before.deletion_scheduled_at).getTime() > Date.now()) continue

        const recordFailure = async (reason: string) => {
          const attempts = Number(before.deletion_attempts ?? 0) + 1
          await supabase.from('profiles').update({
            deletion_attempts: attempts, deletion_last_error: scrubSupplier(reason).slice(0, 500), deletion_last_attempt_at: new Date().toISOString(),
          }).eq('id', id)
          if (attempts === DELETION_ALERT_AFTER_ATTEMPTS && process.env.ADMIN_EMAIL) {
            await sendEmailSafe({
              to: process.env.ADMIN_EMAIL,
              subject: '[ACCOUNT DELETION] a scheduled deletion keeps failing',
              html: `<p>The scheduled deletion of account <code>${id}</code> has failed ${attempts} hourly attempts in a row.</p>
                     <p><strong>Latest reason:</strong> ${escapeHtml(scrubSupplier(reason))}</p>
                     <p>It keeps retrying every hour. <a href="${appUrl()}/admin/users/${id}">Open the user</a></p>`,
            })
          }
        }

        // Held while suspended (see performAccountDeletion): reported on the admin deletion queue
        // through deletion_last_error, and the admin is told once after DELETION_ALERT_AFTER_ATTEMPTS.
        if (before.is_suspended) { out.postponed = Number(out.postponed) + 1; await recordFailure('the account is suspended — deletion on hold until it is unsuspended or deleted by an admin'); continue }

        const flight = await countInFlightPayments(supabase, id)
        if (flight.error) { out.postponed = Number(out.postponed) + 1; await recordFailure(`payment check failed: ${flight.error}`); continue }
        if (flight.count > 0) { out.postponed = Number(out.postponed) + 1; await recordFailure('a payment is still being processed'); continue }

        const result = await performAccountDeletion(supabase, id, { before, onlyIfDue: true })
        if (!result.ok) {
          if (result.stage === 'already_deleted' || result.stage === 'not_due') continue
          if (result.stage === 'suspended') { out.postponed = Number(out.postponed) + 1; await recordFailure('the account is suspended — deletion on hold until it is unsuspended or deleted by an admin'); continue }
          out.failed = Number(out.failed) + 1
          problems.push(scrubSupplier(`scheduled deletion of ${id} failed at ${result.stage}: ${result.error}`))
          await recordFailure(`${result.stage}: ${result.error}`)
          continue
        }
        out.executed = Number(out.executed) + 1
        await logSecurityEvent({ userId: id, event: 'account_deleted', meta: { via: 'scheduled' }, admin: supabase })
        if (before.email && !String(before.email).startsWith('[')) {
          const mail = deletionCompleteEmail(before.full_name)
          const sent = await sendEmailSafe({ to: before.email, ...mail })
          if (!sent) console.error('[deletions] completion e-mail was not delivered', id)
        }
      } catch (e: any) {
        out.failed = Number(out.failed) + 1
        problems.push(`scheduled deletion of ${id} threw: ${String(e?.message ?? e)}`)
        console.error('[deletions] deletion threw', id, e)
      }
    }

    // ── 2. Reminders (claim first so two overlapping runs cannot both e-mail) ──
    const windowEnd = new Date(Date.now() + DELETION_REMINDER_HOURS * 3600_000).toISOString()
    const { data: toRemind, error: remindErr } = await supabase.from('profiles')
      .select('id, email, full_name, deletion_scheduled_at').or('is_deleted.is.null,is_deleted.eq.false')
      .not('deletion_scheduled_at', 'is', null).gt('deletion_scheduled_at', nowIso).lte('deletion_scheduled_at', windowEnd)
      .is('deletion_reminder_sent_at', null).or('is_suspended.is.null,is_suspended.eq.false').limit(MAX_REMINDERS_PER_RUN)
    if (remindErr) problems.push(`could not read reminders: ${remindErr.message}`)
    for (const p of toRemind ?? []) {
      try {
        // The claim also requires the deletion to still be scheduled for the moment this row was
        // read: a customer who cancelled (or cancelled and re-scheduled) while this loop was busy
        // with an earlier account must not get a "deleted tomorrow" e-mail for a deletion that
        // no longer exists.
        const { data: claimed } = await supabase.from('profiles')
          .update({ deletion_reminder_sent_at: nowIso }).eq('id', p.id).or('is_deleted.is.null,is_deleted.eq.false')
          .eq('deletion_scheduled_at', p.deletion_scheduled_at).is('deletion_reminder_sent_at', null).select('id')
        if (!claimed?.length || !p.email || String(p.email).startsWith('[')) continue
        const mail = deletionReminderEmail(p.full_name, p.deletion_scheduled_at)
        const sent = await sendEmailSafe({ to: p.email, ...mail })
        if (sent) out.reminded = Number(out.reminded) + 1
        else {
          await supabase.from('profiles').update({ deletion_reminder_sent_at: null }).eq('id', p.id) // try again next hour
          problems.push('a deletion reminder e-mail was not accepted by the mail provider')
        }
      } catch (e: any) { problems.push(`reminder for ${p.id} threw: ${String(e?.message ?? e)}`) }
    }

    // ── 3. Leftovers of finished deletions ────────────────────────────
    const { data: leftovers, error: leftErr } = await supabase.from('profiles')
      .select('id, deletion_attempts').eq('is_deleted', true).eq('deletion_cleanup_pending', true)
      .order('deletion_last_attempt_at', { ascending: true, nullsFirst: true })
      .order('deleted_at', { ascending: true }).limit(MAX_CLEANUPS_PER_RUN)
    if (leftErr) problems.push(`could not read pending cleanups: ${leftErr.message}`)
    for (const l of leftovers ?? []) {
      try {
        out.cleanup_retried = Number(out.cleanup_retried) + 1
        const r = await retryAccountCleanup(supabase, l.id, Number(l.deletion_attempts ?? 0))
        if (r.cleared) out.cleanup_cleared = Number(out.cleanup_cleared) + 1
        else problems.push(`cleanup of deleted account ${l.id} still has ${r.warnings.length} problem(s)`)
      } catch (e: any) { problems.push(scrubSupplier(`cleanup of ${l.id} threw: ${String(e?.message ?? e)}`)) }
    }

    // ── 4. Released credentials whose accounting settle did not land ───
    // Only credentials that no longer point at a supplier sub-user. One that still carries an
    // id / reserved username has a sub-user that could not be released and may still be
    // consuming traffic: settling it now would zero its usage and mark it settled, so the
    // live usage read at the eventual release would be thrown away ('already_settled').
    // releaseUpstreamSubUsers settles it, with the live figure, once the release lands.
    const { data: unsettled, error: unsettledErr } = await supabase.from('proxy_credentials')
      .select('id').eq('suspended_reason', 'deleted').is('settled_at', null)
      .is('upstream_sub_user_id', null).is('provision_username', null).limit(100)
    if (unsettledErr) problems.push(`could not read unsettled credentials: ${unsettledErr.message}`)
    for (const c of unsettled ?? []) {
      const { error } = await supabase.rpc('settle_released_credential', { p_credential_id: c.id, p_live_used_gb: null })
      if (error) problems.push(`could not settle credential ${c.id}: ${error.message}`)
      else out.settled = Number(out.settled) + 1
    }
  } catch (e: any) {
    console.error('[cron deletions] failed', e)
    problems.push(String(e?.message ?? e))
  }
  // Reported as `error` so the heartbeat records the run as failed (lib/cronHealth).
  return { ...out, ...(problems.length ? { error: problems.slice(0, 5).join('; ') } : {}) }
}
