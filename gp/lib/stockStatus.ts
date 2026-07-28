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
  const exposureGb = Math.max(0, totalAllocated - totalUsed)

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
