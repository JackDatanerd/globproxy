import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, sendEmailSafe, escapeHtml } from '@/lib/email'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { lastCompletedCycle, formatCycleLabel } from '@/lib/payoutCycle'
import { formatGb, formatUsd } from '@/lib/format'
import { sendInviteResolutionNotices } from '@/lib/resellerAllocation'
import { dispatchWebhook } from '@/lib/webhooks'

// Scheduled work for section 7 (resellers & affiliates). Both entry points
// catch their own failures and report them as `{ error }` so the cron heartbeat
// records them; neither may throw into the cron chain.

// Every 5 minutes: tell both sides about reseller invitations the database
// resolved on its own (claimed when the invited address confirmed, or expired).
export async function runInviteNotices() {
  try {
    return await sendInviteResolutionNotices(await createAdminClient())
  } catch (e: any) {
    console.error('[cron invites] failed:', e)
    return { error: String(e?.message ?? e) }
  }
}

// Hourly (every step is idempotent): (1) unclaimed invitations give their stock back, (2) resellers whose
// stock fell below their own threshold are told once, (3) on the two days each
// month a payout cycle becomes payable (the 20th and the 5th) the admin gets a
// reminder with what is waiting — payout day used to depend on someone
// remembering it.
export async function runResellerMaintenance() {
  const out: Record<string, unknown> = {}
  try {
    const supabase = await createAdminClient()

    // Invitations whose address was already a confirmed account (the signup
    // triggers only fire at the moment of confirmation).
    const { data: swept, error: sweepErr } = await supabase.rpc('claim_all_due_pending_transfers')
    if (sweepErr) console.error('[cron resellers] claim sweep failed', sweepErr)
    out.invitations_claimed = Number(swept ?? 0)

    const { data: expired, error: expErr } = await supabase.rpc('expire_pending_reseller_transfers')
    if (expErr) console.error('[cron resellers] expire failed', expErr)
    out.invitations_expired = (expired as unknown[] | null)?.length ?? 0

    const { data: low, error: lowErr } = await supabase.rpc('reseller_low_stock_due')
    if (lowErr) console.error('[cron resellers] low-stock query failed', lowErr)
    let alerted = 0
    for (const r of (low ?? []) as { out_reseller_id: string; out_email: string; out_name: string | null; out_available_gb: number; out_threshold_gb: number }[]) {
      if (!r.out_email || r.out_email.startsWith('[')) continue
      // Stamp first: if the send fails we'd rather miss one alert than mail a
      // reseller every day.
      const { data: won } = await supabase.from('profiles')
        .update({ reseller_low_stock_alerted_at: new Date().toISOString() })
        .eq('id', r.out_reseller_id).is('reseller_low_stock_alerted_at', null).select('id')
      if (!won?.length) continue
      // Same moment, machine-readable: lets an integration restock or page someone.
      await dispatchWebhook(r.out_reseller_id, 'reseller_low_stock', {
        available_gb: Number(r.out_available_gb), low_stock_gb: Number(r.out_threshold_gb),
      }, { defer: true })
      await sendEmail({
        to: r.out_email,
        subject: `Low bandwidth stock: ${formatGb(Number(r.out_available_gb))} left`,
        html: adminNoticeHtml({
          heading: 'Your reseller stock is running low',
          bodyHtml: `Hi ${escapeHtml(String(r.out_name ?? '').split(' ')[0]) || 'there'}, you have <strong>${escapeHtml(formatGb(Number(r.out_available_gb)))}</strong> available to allocate — below the
            ${escapeHtml(formatGb(Number(r.out_threshold_gb)))} alert level you set. Top up before your next client order. You can change or turn off this alert on your reseller dashboard.`,
          cta: { href: `${appUrl()}/dashboard`, label: 'Buy more bandwidth →' },
        }),
      }).catch((e) => console.error('[cron resellers] low-stock email failed', e))
      alerted++
    }
    out.low_stock_alerts = alerted

    out.payout_reminder = await sendPayoutReminder(supabase)
  } catch (e: any) {
    console.error('[cron resellers] failed:', e)
    return { ...out, error: String(e?.message ?? e) }
  }
  return out
}

async function sendPayoutReminder(supabase: Awaited<ReturnType<typeof createAdminClient>>) {
  const today = new Date().toISOString().slice(0, 10)
  const cycle = lastCompletedCycle()
  // On or after payable day (not only ON it): a missed day no longer means no reminder;
  // the stamp below keeps it to one per cycle.
  if (today < cycle.payableFrom) return { sent: false, reason: 'not a payout day' }
  if (new Date().getUTCHours() < 6) return { sent: false, reason: 'too early in the day' } // hourly task; send at working hours

  const KEY = 'payout_reminder_sent_for'
  const { data: prev } = await supabase.from('platform_settings').select('value').eq('key', KEY).maybeSingle()
  if (prev?.value === cycle.cycleEnd) return { sent: false, reason: 'already sent' }

  // Totals computed in SQL (a fetched list was capped by PostgREST and by a limit).
  const { data: totals, error: totalsErr } = await supabase.rpc('affiliate_payout_reminder_totals', { p_cycle_end: cycle.cycleEnd })
  if (totalsErr) { console.error('[cron resellers] reminder totals failed', totalsErr); return { sent: false, reason: 'totals query failed', error: String(totalsErr.message ?? totalsErr) } }
  const t = (Array.isArray(totals) ? totals[0] : totals) as { out_affiliates?: number; out_total_usd?: number; out_deductions_usd?: number } | null
  const people = { size: Number(t?.out_affiliates ?? 0) }
  const total = Number(t?.out_total_usd ?? 0)
  const deductions = Number(t?.out_deductions_usd ?? 0)
  const { count: pendingPayouts } = await supabase.from('affiliate_payouts').select('id', { count: 'exact', head: true }).eq('status', 'pending')

  // Nothing to stamp (and nothing lost) when there is nobody to tell.
  if (!process.env.ADMIN_EMAIL) return { sent: false, reason: 'no ADMIN_EMAIL' }
  // Stamp before sending so two overlapping runs cannot both send, then take the
  // stamp back if the provider did not accept the message: it used to count as
  // "sent" regardless, so a provider hiccup on payout day meant no reminder at all.
  await supabase.from('platform_settings').upsert({ key: KEY, value: cycle.cycleEnd, updated_at: new Date().toISOString() })
  const delivered = await sendEmailSafe({
    to: process.env.ADMIN_EMAIL,
    subject: `Affiliate payouts are due: ${formatCycleLabel(cycle)}`,
    html: adminNoticeHtml({
      heading: 'Affiliate payout day',
      bodyHtml: `The <strong>${escapeHtml(formatCycleLabel(cycle))}</strong> cycle is payable from today. ${people.size} affiliate${people.size === 1 ? ' has' : 's have'} <strong>${escapeHtml(formatUsd(total))}</strong> waiting
        to be batched${deductions > 0 ? ` (with ${escapeHtml(formatUsd(deductions))} of refund deductions to net off)` : ''}. ${pendingPayouts ?? 0} payout${pendingPayouts === 1 ? ' is' : 's are'} already created and waiting to be sent.
        Run the cycle, then send and mark the payouts paid.`,
      cta: { href: `${appUrl()}/admin/affiliates`, label: 'Open Affiliates →' },
    }),
  })
  if (!delivered) {
    await supabase.from('platform_settings').delete().eq('key', KEY)
    return { sent: false, reason: 'email not delivered — will retry next hour', error: 'payout reminder email was not delivered' }
  }
  return { sent: true, cycle_end: cycle.cycleEnd, affiliates: people.size }
}
