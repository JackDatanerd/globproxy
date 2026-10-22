import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { lastCompletedCycle, formatCycleLabel } from '@/lib/payoutCycle'
import { formatGb, formatUsd } from '@/lib/format'
import { sendInviteResolutionNotices } from '@/lib/resellerAllocation'

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
  if (today !== cycle.payableFrom) return { sent: false, reason: 'not a payout day' }
  if (new Date().getUTCHours() < 6) return { sent: false, reason: 'too early in the day' } // hourly task; send at working hours

  const KEY = 'payout_reminder_sent_for'
  const { data: prev } = await supabase.from('platform_settings').select('value').eq('key', KEY).maybeSingle()
  if (prev?.value === cycle.cycleEnd) return { sent: false, reason: 'already sent' }

  // Unbatched commissions that this cycle run would pick up, and the open deductions.
  const { data: comms } = await supabase.from('affiliate_commissions')
    .select('referrer_id, commission_amount_usd')
    .is('payout_id', null).eq('status', 'pending').lte('created_at', `${cycle.cycleEnd}T23:59:59.999Z`).limit(20000)
  const people = new Set((comms ?? []).map((c: any) => c.referrer_id))
  const total = (comms ?? []).reduce((s: number, c: any) => s + Number(c.commission_amount_usd), 0)
  const { data: adj } = await supabase.from('affiliate_adjustments')
    .select('amount_usd').is('payout_id', null).is('waived_at', null).limit(20000)
  const deductions = -((adj ?? []).reduce((s: number, a: any) => s + Number(a.amount_usd), 0))
  const { count: pendingPayouts } = await supabase.from('affiliate_payouts').select('id', { count: 'exact', head: true }).eq('status', 'pending')

  // Stamp before sending: one reminder per cycle, even if the send is retried.
  await supabase.from('platform_settings').upsert({ key: KEY, value: cycle.cycleEnd, updated_at: new Date().toISOString() })
  if (!process.env.ADMIN_EMAIL) return { sent: false, reason: 'no ADMIN_EMAIL' }
  await sendEmail({
    to: process.env.ADMIN_EMAIL,
    subject: `Affiliate payouts are due: ${formatCycleLabel(cycle)}`,
    html: adminNoticeHtml({
      heading: 'Affiliate payout day',
      bodyHtml: `The <strong>${escapeHtml(formatCycleLabel(cycle))}</strong> cycle is payable from today. ${people.size} affiliate${people.size === 1 ? ' has' : 's have'} <strong>${escapeHtml(formatUsd(total))}</strong> waiting
        to be batched${deductions > 0 ? ` (with ${escapeHtml(formatUsd(deductions))} of refund deductions to net off)` : ''}. ${pendingPayouts ?? 0} payout${pendingPayouts === 1 ? ' is' : 's are'} already created and waiting to be sent.
        Run the cycle, then send and mark the payouts paid.`,
      cta: { href: `${appUrl()}/admin/affiliates`, label: 'Open Affiliates →' },
    }),
  }).catch((e) => console.error('[cron resellers] payout reminder failed', e))
  return { sent: true, cycle_end: cycle.cycleEnd, affiliates: people.size }
}
