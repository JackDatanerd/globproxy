import { getAccountBalance } from '@/lib/upstream'
import { fetchAllRows } from '@/lib/dbPaging'

export interface StockStatus {
  available_gb: number              // Upstream availableForAllocationMB — what can still be carved out for new sub-users
  total_gb: number
  total_allocated_gb: number        // Σ gb_allocated over active credentials (informational)
  total_used_gb: number             // Σ gb_used over active credentials (informational)
  committed_unused_gb: number       // Σ max(0, allocated - used) — ALREADY deducted from available_gb by upstream
  unallocated_balances_gb: number   // customer balances not yet given to any credential
  pending_allocated_gb: number      // reserved by credentials that have no upstream sub-user yet
  paused_resume_gb: number          // headroom of customer-paused sessions: released upstream while paused, re-taken from available_gb on resume
  exposure_gb: number               // unallocated_balances + pending + paused_resume — the GB still to be carved out of available_gb
  covered: boolean
  last_synced: string
}

// WHAT "EXPOSURE" MEANS HERE (changed — the old formula was wrong).
//
// available_gb is upstream's availableForAllocationMB = totalMB minus what is
// ALREADY allocated to sub-users (see getAccountBalance). Every GB inside an
// active credential's limit has therefore already been taken out of that
// figure. The old exposure was Σ(allocated - used) over active credentials —
// GB that are already deducted — compared against that same already-reduced
// pool, so it counted the same GB twice (false alarms) while missing the
// claims that are really still to be satisfied from it:
//
//   1. unallocated customer balances — GB customers paid for and may turn
//      into new sessions at any moment (bandwidth_accounts.available_gb:
//      total_gb - allocated_gb), and
//   2. pending credentials — GB reserved against a customer's balance whose
//      Upstream sub-user hasn't been created yet; provisioning will have to
//      carve them out of available_gb.
//
//   3. customer-paused sessions — pausing caps the live limit at what was used, which
//      hands the unused headroom BACK to available_gb; the customer can resume at any
//      moment and the full allocation has to be carved out again. Admin- and
//      account-suspended sessions only return through an admin action, so they are not counted.
//
// Exposure = (1) + (2) + (3). `covered` means the remaining unsold-to-upstream pool
// can honour every one of them.
export async function computeStockStatus(supabase: any): Promise<StockStatus> {
  const balance = await getAccountBalance()

  const active = await fetchAllRows<{ gb_allocated: number | null; gb_used: number | null }>((from, to) =>
    supabase.from('proxy_credentials').select('gb_allocated, gb_used').eq('status', 'active').order('id').range(from, to)
  )
  const pausedAll = await fetchAllRows<{ user_id: string; gb_allocated: number | null; gb_used: number | null }>((from, to) =>
    supabase.from('proxy_credentials').select('user_id, gb_allocated, gb_used').eq('status', 'suspended').eq('suspended_reason', 'customer').order('id').range(from, to)
  )
  const pendingAll = await fetchAllRows<{ user_id: string; gb_allocated: number | null }>((from, to) =>
    supabase.from('proxy_credentials').select('user_id, gb_allocated').eq('status', 'pending').order('id').range(from, to)
  )
  const accountsAll = await fetchAllRows<{ user_id: string; available_gb: number | null }>((from, to) =>
    supabase.from('bandwidth_accounts').select('user_id, available_gb').gt('available_gb', 0).order('user_id').range(from, to)
  )
  // Suspended and deleted accounts can't turn their balance (or a pending
  // reservation) into live sessions, so counting them overstated exposure and
  // raised false "not covered" alarms — deleted accounts keep their balance
  // row forever.
  const inactive = await fetchAllRows<{ id: string }>((from, to) =>
    supabase.from('profiles').select('id').or('is_suspended.eq.true,is_deleted.eq.true').order('id').range(from, to)
  )
  // A truncated read would silently UNDERSTATE exposure — the dangerous
  // direction for an alerting metric. Fail loudly instead.
  if (active.error || pausedAll.error || pendingAll.error || accountsAll.error || inactive.error) {
    throw new Error(`Stock status read failed: ${active.error ?? pausedAll.error ?? pendingAll.error ?? accountsAll.error ?? inactive.error}`)
  }
  const inactiveIds = new Set(inactive.rows.map(r => r.id))
  const pending = { rows: pendingAll.rows.filter(c => !inactiveIds.has(c.user_id)) }
  const paused = { rows: pausedAll.rows.filter(c => !inactiveIds.has(c.user_id)) }
  const accounts = { rows: accountsAll.rows.filter(a => !inactiveIds.has(a.user_id)) }

  const sum = (xs: number[]) => xs.reduce((s, n) => s + n, 0)
  const totalAllocated = sum(active.rows.map(c => Number(c.gb_allocated ?? 0)))
  const totalUsed = sum(active.rows.map(c => Number(c.gb_used ?? 0)))
  // Clamped PER CREDENTIAL: a credential over its own cap (upstream's
  // trafficUsedMB can exceed trafficLimitMB) must not offset another's headroom.
  const committedUnused = sum(active.rows.map(c => Math.max(0, Number(c.gb_allocated ?? 0) - Number(c.gb_used ?? 0))))
  const unallocatedBalances = sum(accounts.rows.map(a => Number(a.available_gb ?? 0)))
  const pendingAllocated = sum(pending.rows.map(c => Number(c.gb_allocated ?? 0)))
  const pausedResume = sum(paused.rows.map(c => Math.max(0, Number(c.gb_allocated ?? 0) - Number(c.gb_used ?? 0))))
  const exposure = unallocatedBalances + pendingAllocated + pausedResume

  return {
    available_gb: balance.available_gb,
    total_gb: balance.total_gb,
    total_allocated_gb: totalAllocated,
    total_used_gb: totalUsed,
    committed_unused_gb: committedUnused,
    unallocated_balances_gb: unallocatedBalances,
    pending_allocated_gb: pendingAllocated,
    paused_resume_gb: pausedResume,
    exposure_gb: exposure,
    covered: balance.available_gb >= exposure,
    last_synced: new Date().toISOString(),
  }
}
