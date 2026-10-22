import type { AdminSupabase } from '@/lib/adminAuth'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { formatCycleLabel } from '@/lib/payoutCycle'
import { formatUsd } from '@/lib/format'

// E-mails to affiliates about money events that used to be silent: a payout
// being queued, a payout being cancelled, and a commission shrinking (or being
// recovered) because the order behind it was refunded. All best-effort — the
// ledger change has already committed — and none of them name the referred
// customer. They never mention suppliers; only GlobProxy amounts.

type Person = { email: string | null; full_name: string | null; is_deleted?: boolean | null }

async function loadPerson(supabase: AdminSupabase, id: string): Promise<Person | null> {
  const { data } = await supabase.from('profiles').select('email, full_name, is_deleted').eq('id', id).maybeSingle()
  if (!data?.email || data.is_deleted || String(data.email).startsWith('[')) return null
  return data as Person
}

const first = (p: Person) => escapeHtml(String(p.full_name ?? '').split(' ')[0]) || 'there'

export async function notifyPayoutQueued(
  supabase: AdminSupabase, referrerId: string,
  p: { amount_usd: number; cycle_start: string; cycle_end: string; method: string }
): Promise<void> {
  const who = await loadPerson(supabase, referrerId)
  if (!who) return
  const methodLabel = p.method === 'usdt' ? 'USDT (TRC20)' : p.method === 'mpesa' ? 'M-Pesa' : 'bank transfer'
  await sendEmailSafe({
    to: who.email!,
    subject: 'Your GlobProxy affiliate payout is being prepared',
    html: adminNoticeHtml({
      heading: 'Payout queued',
      bodyHtml: `Hi ${first(who)}, your affiliate payout of <strong>${escapeHtml(formatUsd(p.amount_usd))}</strong> for ${escapeHtml(formatCycleLabel(p))} has been queued and will be sent via ${methodLabel}. You'll get another email as soon as it has been sent.`,
      cta: { href: `${appUrl()}/dashboard/referrals`, label: 'View your payout history →' },
    }),
  })
}

export async function notifyPayoutVoided(
  supabase: AdminSupabase, referrerId: string, p: { amount_usd: number; cycle_start: string; cycle_end: string }, reason: string
): Promise<void> {
  const who = await loadPerson(supabase, referrerId)
  if (!who) return
  await sendEmailSafe({
    to: who.email!,
    subject: 'Your GlobProxy affiliate payout was cancelled',
    html: adminNoticeHtml({
      heading: 'Payout cancelled',
      bodyHtml: `Hi ${first(who)}, the pending payout of <strong>${escapeHtml(formatUsd(p.amount_usd))}</strong> for ${escapeHtml(formatCycleLabel(p))} was cancelled (${escapeHtml(reason)}).
        Nothing was lost: the commissions are back in your balance and will be included in your next payout. Check your payout method is correct.`,
      cta: { href: `${appUrl()}/dashboard/referrals`, label: 'Check your payout method →' },
    }),
  })
}

// One commission, before and after a refund landed on its order.
export type CommissionSnapshot = { status: string; commission_amount_usd: number }

export async function snapshotCommission(supabase: AdminSupabase, orderId: string): Promise<(CommissionSnapshot & { referrer_id: string; id: string }) | null> {
  const { data } = await supabase.from('affiliate_commissions')
    .select('id, referrer_id, status, commission_amount_usd').eq('order_id', orderId).maybeSingle()
  return data ? { id: data.id, referrer_id: data.referrer_id, status: data.status, commission_amount_usd: Number(data.commission_amount_usd) } : null
}

export async function notifyCommissionRefunded(
  supabase: AdminSupabase, orderId: string, before: (CommissionSnapshot & { referrer_id: string; id: string }) | null
): Promise<void> {
  try {
    if (!before) return
    const after = await snapshotCommission(supabase, orderId)
    if (!after) return
    let line: string
    if (before.status === 'paid') {
      const { data: adj } = await supabase.from('affiliate_adjustments')
        .select('amount_usd').eq('commission_id', before.id)
      const owed = -((adj ?? []).reduce((s, a: any) => s + Number(a.amount_usd), 0))
      if (owed <= 0) return
      line = `A customer's order behind a commission we already paid you was refunded, so <strong>${escapeHtml(formatUsd(owed))}</strong> will be deducted from your upcoming payouts (it is netted against new commissions — you never need to pay anything back directly).`
    } else {
      const cut = before.commission_amount_usd - after.commission_amount_usd
      if (cut <= 0) return
      line = after.commission_amount_usd <= 0
        ? `A customer's order was fully refunded, so its <strong>${escapeHtml(formatUsd(before.commission_amount_usd))}</strong> commission was removed from your balance.`
        : `A customer's order was partly refunded, so a commission was reduced by <strong>${escapeHtml(formatUsd(cut))}</strong> (now ${escapeHtml(formatUsd(after.commission_amount_usd))}).`
    }
    const who = await loadPerson(supabase, before.referrer_id)
    if (!who) return
    await sendEmailSafe({
      to: who.email!,
      subject: 'A referral commission was adjusted after a refund',
      html: adminNoticeHtml({
        heading: 'Commission adjusted',
        bodyHtml: `Hi ${first(who)}, ${line}`,
        cta: { href: `${appUrl()}/dashboard/referrals`, label: 'See your balance →' },
      }),
    })
  } catch (e) {
    console.error('[affiliateNotify] commission-refund notice failed (non-fatal)', orderId, e)
  }
}

export async function notifyClawbackWaived(supabase: AdminSupabase, referrerId: string, amountUsd: number): Promise<void> {
  const who = await loadPerson(supabase, referrerId)
  if (!who) return
  await sendEmailSafe({
    to: who.email!,
    subject: 'A deduction on your GlobProxy affiliate balance was waived',
    html: adminNoticeHtml({
      heading: 'Deduction waived',
      bodyHtml: `Hi ${first(who)}, a ${escapeHtml(formatUsd(Math.abs(amountUsd)))} deduction that was going to be taken from your upcoming payouts has been waived. Nothing further will be deducted for it.`,
      cta: { href: `${appUrl()}/dashboard/referrals`, label: 'See your balance →' },
    }),
  })
}
