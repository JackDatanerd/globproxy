import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// Shown when the hold came from a lost dispute (source 'dispute_lost').
export const PAYMENT_HOLD_MESSAGE =
  'New purchases are on hold for this account after a payment dispute that was decided against it. Please contact support@globproxy.com and we will review it.'

// Shown when an admin placed the hold by hand: it must NOT claim a dispute was lost.
export const PAYMENT_HOLD_ADMIN_MESSAGE =
  'New purchases are on hold for this account while we review it. Please contact support@globproxy.com and we will help.'

export function paymentHoldMessage(source: string | null | undefined): string {
  return source === 'admin' ? PAYMENT_HOLD_ADMIN_MESSAGE : PAYMENT_HOLD_MESSAGE
}

// The hold row (null when there is none). A failed read is logged and treated as "no hold" so a
// database blip never blocks every purchase — the same trade-off hasPaymentHold always made.
export async function getPaymentHold(supabase: Admin, userId: string): Promise<{ source: string } | null> {
  const { data, error } = await supabase.from('payment_holds').select('source').eq('user_id', userId).maybeSingle()
  if (error) console.error('[payment-hold] lookup failed', error)
  return data ? { source: String((data as any).source ?? 'dispute_lost') } : null
}

export async function hasPaymentHold(supabase: Admin, userId: string): Promise<boolean> {
  return !!(await getPaymentHold(supabase, userId))
}

// Puts the account on hold. Resolves true when a hold was placed, false when the account was
// ALREADY on hold, and THROWS when the write itself failed — those two used to look identical
// (both `false`), so a database or foreign-key error was reported as "already on hold".
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
  if (error) { console.error('[payment-hold] could not place', userId, error); throw new Error(error.message) }
  return (data?.length ?? 0) > 0
}

export async function clearPaymentHold(supabase: Admin, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('payment_holds').delete().eq('user_id', userId).select('user_id')
  if (error) throw error
  return (data?.length ?? 0) > 0
}
