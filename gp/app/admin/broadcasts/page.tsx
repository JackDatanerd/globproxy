import { createAdminClient } from '@/lib/supabase/server'
import { loadMpesaConfig } from '@/lib/fx'
import BroadcastComposer from '@/components/admin/BroadcastComposer'
import BroadcastList, { type BroadcastItem } from '@/components/admin/BroadcastList'

// Message customers: everyone, a group, or a pasted list — by e-mail and/or a dashboard banner.
// Delivery runs from the 5-minute cron (lib/broadcast.ts); this page shows how each one is going.
export default async function AdminBroadcastsPage() {
  const supabase = await createAdminClient()

  const { data: rows, error } = await supabase.from('broadcasts')
    .select('id, subject, kind, status, created_at, send_email, show_banner, banner_ends_at, recipient_count')
    .order('created_at', { ascending: false }).limit(15)

  const counts: Record<string, Record<string, number>> = {}
  if (rows?.length) {
    const { data: prog } = await supabase.rpc('broadcast_progress', { p_ids: rows.map(r => r.id) })
    for (const p of (prog ?? []) as Array<{ broadcast_id: string; status: string; n: number }>) {
      (counts[p.broadcast_id] ??= {})[p.status] = Number(p.n)
    }
  }
  const items: BroadcastItem[] = (rows ?? []).map(r => ({ ...r, counts: counts[r.id] ?? {} }))

  // For the launch template only: the M-Pesa offer's real percentage and deadline. Tolerant — no offer is fine.
  let promo: { enabled: boolean; percent: number; endsAt: string } | null = null
  try {
    const cfg = await loadMpesaConfig(supabase)
    if (cfg.promo) promo = { enabled: cfg.promo.enabled, percent: cfg.promo.percent, endsAt: cfg.promo.endsAt }
  } catch { /* the template just has no discount in it */ }

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="font-display font-bold text-2xl text-ink">Broadcasts</h1>
        <p className="text-muted text-sm mt-1">
          Message all customers, a group, or specific people by e-mail and/or a banner on their dashboard. E-mails go out in batches of 100
          every few minutes (about 400 per run) — or press &ldquo;Send a few batches now&rdquo;.
        </p>
      </div>

      <BroadcastComposer promo={promo} />

      <h2 className="font-display font-bold text-base text-ink mb-3">Recent broadcasts</h2>
      {error ? <p className="text-sm text-red-600">Could not load broadcasts: {error.message}</p> : <BroadcastList items={items} />}
    </div>
  )
}
