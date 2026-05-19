import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ResellerUsersList from './ResellerUsersList'

export default async function ResellerUsersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  // ── 1. Reseller's bandwidth account ────────────────────────────────────
  const { data: bw } = await supabase
    .from('bandwidth_accounts')
    .select('total_gb, used_gb')
    .eq('user_id', user.id)
    .single()

  // ── 2. All transfers this reseller has made ─────────────────────────────
  const { data: transfers } = await supabase
    .from('reseller_transfers')
    .select('recipient_id, gb_amount, activated_at')
    .eq('reseller_id', user.id)
    .order('activated_at', { ascending: false })

  // ── 3. Unique recipient IDs ─────────────────────────────────────────────
  const recipientIds = Array.from(
    new Set((transfers ?? []).map(t => t.recipient_id))
  )

  // ── 4. Fetch profiles for those recipients ──────────────────────────────
  let profiles: { id: string; email: string; full_name: string | null }[] = []
  if (recipientIds.length > 0) {
    const { data: p } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .in('id', recipientIds)
    if (p) profiles = p
  }

  // ── 5. Aggregate into unique client list ────────────────────────────────
  const clientsMap = new Map<string, {
    id: string
    email: string
    full_name: string | null
    total_gb_received: number
    latest_transfer: string
  }>()

  for (const t of transfers ?? []) {
    const existing = clientsMap.get(t.recipient_id)
    if (!existing) {
      const pInfo = profiles.find(p => p.id === t.recipient_id)
      clientsMap.set(t.recipient_id, {
        id: t.recipient_id,
        email: pInfo?.email ?? 'Unknown User',
        full_name: pInfo?.full_name ?? null,
        total_gb_received: Number(t.gb_amount),
        latest_transfer: t.activated_at,
      })
    } else {
      existing.total_gb_received += Number(t.gb_amount)
    }
  }

  const clientsList = Array.from(clientsMap.values())
  const availableGb = Math.max(0, (bw?.total_gb ?? 0) - (bw?.used_gb ?? 0))

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">Your Clients</h1>
          <p className="text-muted text-sm mt-1">Transfer bandwidth directly to client balances</p>
        </div>
        <div className="text-right">
          <div className="text-xs font-mono text-muted">Available stock</div>
          <div className="font-display font-bold text-accent">{availableGb.toFixed(1)} GB</div>
        </div>
      </div>

      <ResellerUsersList
        clients={clientsList}
        availableGb={availableGb}
      />
    </div>
  )
}
