import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export const PAYMENT_HOLD_MESSAGE =
  'New purchases are on hold for this account after a payment dispute that was decided against it. Please contact support@globproxy.com and we will review it.'

// A lost chargeback puts the account on hold: buy -> use -> chargeback must not repeat. An
// open dispute pauses purchases separately (lib/checkout.ts); this is the lasting half,
// cleared only by an admin (Admin -> user, or POST /api/admin/payment-hold). Like the
// dispute pause it is a secondary control: if the lookup fails it is logged and the
// purchase proceeds rather than turning a DB hiccup into a checkout outage.
export async function hasPaymentHold(supabase: Admin, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('payment_holds').select('user_id').eq('user_id', userId).maybeSingle()
  if (error) console.error('[payment-hold] lookup failed', error)
  return !!data
}

// Idempotent: a second hold for the same account keeps the first reason.
export async function placePaymentHold(
  supabase: Admin,
  userId: string,
  p: { reason: string; source: 'dispute_lost' | 'admin'; orderId?: string | null; createdBy?: string | null },
): Promise<boolean> {
  const { data, error } = await supabase.from('payment_holds')
    .upsert({
      user_id: userId, reason: p.reason.slice(0, 300), source: p.source,
      order_id: p.orderId ?? null, created_by: p.createdBy ?? null,
    }, { onConflict: 'user_id', ignoreDuplicates: true })
    .select('user_id')
  if (error) { console.error('[payment-hold] could not place', userId, error); return false }
  return (data?.length ?? 0) > 0
}

export async function clearPaymentHold(supabase: Admin, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('payment_holds').delete().eq('user_id', userId).select('user_id')
  if (error) throw error
  return (data?.length ?? 0) > 0
}
