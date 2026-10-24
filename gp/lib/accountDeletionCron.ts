import { createAdminClient } from '@/lib/supabase/server'
import { sendEmailSafe } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'
import { logSecurityEvent } from '@/lib/securityEvents'
import { performAccountDeletion, countInFlightPayments, purgeAccountSecrets } from '@/lib/accountDeletion'
import { deletionReminderEmail, deletionCompleteEmail } from '@/lib/accountDeletionEmail'
import { DELETION_ALERT_AFTER_ATTEMPTS, DELETION_REMINDER_HOURS } from '@/lib/deletionSchedule'

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

export async function runAccountDeletions() {
  const out: Record<string, unknown> = { executed: 0, postponed: 0, failed: 0, reminded: 0, cleanup_retried: 0, cleanup_cleared: 0, settled: 0 }
  const problems: string[] = []
  try {
    const supabase = await createAdminClient()
    const nowIso = new Date().toISOString()

    // ── 1. Due deletions ──────────────────────────────────────────────
    const { data: due, error: dueErr } = await supabase.from('profiles')
      .select('id').eq('is_deleted', false).not('deletion_scheduled_at', 'is', null)
      .lte('deletion_scheduled_at', nowIso).order('deletion_scheduled_at', { ascending: true }).limit(MAX_DELETIONS_PER_RUN)
    if (dueErr) problems.push(`could not read due deletions: ${dueErr.message}`)

    for (const { id } of due ?? []) {
      try {
        const { data: before } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle()
        if (!before || before.is_deleted) continue

        const recordFailure = async (reason: string) => {
          const attempts = Number(before.deletion_attempts ?? 0) + 1
          await supabase.from('profiles').update({ deletion_attempts: attempts, deletion_last_error: reason.slice(0, 500) }).eq('id', id)
          if (attempts === DELETION_ALERT_AFTER_ATTEMPTS && process.env.ADMIN_EMAIL) {
            await sendEmailSafe({
              to: process.env.ADMIN_EMAIL,
              subject: '[ACCOUNT DELETION] a scheduled deletion keeps failing',
              html: `<p>The scheduled deletion of account <code>${id}</code> has failed ${attempts} hourly attempts in a row.</p>
                     <p><strong>Latest reason:</strong> ${reason.replace(/</g, '&lt;')}</p>
                     <p>It keeps retrying every hour. <a href="${appUrl()}/admin/users/${id}">Open the user</a></p>`,
            })
          }
        }

        const flight = await countInFlightPayments(supabase, id)
        if (flight.error) { out.postponed = Number(out.postponed) + 1; await recordFailure(`payment check failed: ${flight.error}`); continue }
        if (flight.count > 0) { out.postponed = Number(out.postponed) + 1; await recordFailure('a payment is still being processed'); continue }

        const result = await performAccountDeletion(supabase, id, { before })
        if (!result.ok) {
          if (result.stage === 'already_deleted') continue
          out.failed = Number(out.failed) + 1
          problems.push(`scheduled deletion of ${id} failed at ${result.stage}: ${result.error}`)
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
      .select('id, email, full_name, deletion_scheduled_at').eq('is_deleted', false)
      .not('deletion_scheduled_at', 'is', null).gt('deletion_scheduled_at', nowIso).lte('deletion_scheduled_at', windowEnd)
      .is('deletion_reminder_sent_at', null).limit(MAX_REMINDERS_PER_RUN)
    if (remindErr) problems.push(`could not read reminders: ${remindErr.message}`)
    for (const p of toRemind ?? []) {
      try {
        const { data: claimed } = await supabase.from('profiles')
          .update({ deletion_reminder_sent_at: nowIso }).eq('id', p.id).is('deletion_reminder_sent_at', null).select('id')
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
      .order('deleted_at', { ascending: true }).limit(MAX_CLEANUPS_PER_RUN)
    if (leftErr) problems.push(`could not read pending cleanups: ${leftErr.message}`)
    for (const l of leftovers ?? []) {
      try {
        out.cleanup_retried = Number(out.cleanup_retried) + 1
        const purge = await purgeAccountSecrets(supabase, l.id)
        const attempts = Number(l.deletion_attempts ?? 0) + 1
        if (purge.warnings.length === 0) {
          out.cleanup_cleared = Number(out.cleanup_cleared) + 1
          await supabase.from('profiles').update({ deletion_cleanup_pending: false, deletion_cleanup_notes: null, deletion_attempts: 0 }).eq('id', l.id)
        } else {
          await supabase.from('profiles').update({ deletion_attempts: attempts, deletion_cleanup_notes: purge.warnings.join('\n').slice(0, 4000) }).eq('id', l.id)
          problems.push(`cleanup of deleted account ${l.id} still has ${purge.warnings.length} problem(s)`)
          if (attempts === DELETION_ALERT_AFTER_ATTEMPTS && process.env.ADMIN_EMAIL) {
            await sendEmailSafe({
              to: process.env.ADMIN_EMAIL,
              subject: '[ACCOUNT DELETION] cleanup of a deleted account keeps failing',
              html: `<p>Account <code>${l.id}</code> was deleted, but ${purge.warnings.length} cleanup step(s) still fail after ${attempts} retries:</p>
                     <pre style="white-space:pre-wrap">${purge.warnings.map((w) => w.replace(/</g, '&lt;')).join('\n')}</pre>`,
            })
          }
        }
      } catch (e: any) { problems.push(`cleanup of ${l.id} threw: ${String(e?.message ?? e)}`) }
    }

    // ── 4. Released credentials whose accounting settle did not land ───
    const { data: unsettled } = await supabase.from('proxy_credentials')
      .select('id').eq('suspended_reason', 'deleted').is('settled_at', null).limit(100)
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
