import { getAccountBalance } from '@/lib/geonode'

export interface StockStatus {
  available_gb: number
  total_gb: number
  total_allocated_gb: number
  total_used_gb: number
  exposure_gb: number
  covered: boolean
  last_synced: string
}

// Exposure = total allocated (promised to customers) minus total actually
// used, across active credentials — what you'd need in hand right now if
// every customer drew down their full remaining allocation at once. This is
// the number that matters for a usage-based deduction model, not just a flat
// "stock below X" floor.
export async function computeStockStatus(supabase: any): Promise<StockStatus> {
  const balance = await getAccountBalance()

  const { data: activeCreds } = await supabase
    .from('proxy_credentials')
    .select('gb_allocated, gb_used')
    .eq('status', 'active')

  const totalAllocated = activeCreds?.reduce((s: number, c: any) => s + (c.gb_allocated ?? 0), 0) ?? 0
  const totalUsed = activeCreds?.reduce((s: number, c: any) => s + (c.gb_used ?? 0), 0) ?? 0
  // Clamp PER CREDENTIAL before summing, not the aggregate. Nothing in
  // usageSync.ts caps gb_used at gb_allocated when writing a sync (Geonode's
  // own trafficUsedMB can itself exceed trafficLimitMB — confirmed live on
  // the account, e.g. a sub-user at 53.29MB used against a 51MB limit), and
  // nothing auto-suspends a credential once it's over. If any single
  // credential is over its own cap, summing (allocated - used) at the
  // aggregate level lets that credential's negative remainder silently
  // cancel out another credential's real remaining exposure — understating
  // the number this metric exists to get right. A customer who's already
  // over their cap contributes 0 future draw risk; it can't offset a
  // different customer who genuinely still has headroom to pull.
  const exposureGb = activeCreds?.reduce(
    (s: number, c: any) => s + Math.max(0, (c.gb_allocated ?? 0) - (c.gb_used ?? 0)),
    0
  ) ?? 0

  return {
    available_gb: balance.available_gb,
    total_gb: balance.total_gb,
    total_allocated_gb: totalAllocated,
    total_used_gb: totalUsed,
    exposure_gb: exposureGb,
    covered: balance.available_gb >= exposureGb,
    last_synced: new Date().toISOString(),
  }
}
