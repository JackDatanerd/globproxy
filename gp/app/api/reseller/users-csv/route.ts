import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireMfaVerified } from '@/lib/mfa'
import { toCsv, csvResponse } from '@/lib/csv'
import { NextResponse } from 'next/server'

const PAGE = 500
const MAX_ROWS = 20_000

// Client roster export for the signed-in reseller: one row per client with what
// they were sent, what was reclaimed and how much of it they've used. Same
// scoped, paginated RPC as the Sub-users page.
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (!['reseller', 'admin'].includes(profile?.role ?? '')) {
    return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
  }
  const mfaCheck = await requireMfaVerified(req, user.id)
  if (mfaCheck) return mfaCheck
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 100)
  const admin = await createAdminClient()
  const rows: any[] = []
  for (let off = 0; off < MAX_ROWS; off += PAGE) {
    const { data, error } = await admin.rpc('reseller_client_roster', {
      p_reseller_id: user.id, p_search: q || null, p_limit: PAGE, p_offset: off,
    })
    if (error) return NextResponse.json({ error: 'Export failed' }, { status: 500 })
    rows.push(...((data as any[]) ?? []))
    if (!data || (data as any[]).length < PAGE) break
  }

  const csv = toCsv(rows, [
    { header: 'Client email', value: r => (r.is_deleted ? '[deleted]' : r.email) },
    { header: 'Client name', value: r => (r.is_deleted ? '' : r.full_name ?? '') },
    { header: 'Account', value: r => (r.is_deleted ? 'deleted' : r.is_suspended ? 'suspended' : 'active') },
    { header: 'Transfers', value: r => String(r.transfer_count) },
    { header: 'GB sent', value: r => Number(r.total_received_gb).toFixed(3) },
    { header: 'GB reclaimed', value: r => Number(r.total_reclaimed_gb).toFixed(3) },
    { header: 'Net GB', value: r => (Number(r.total_received_gb) - Number(r.total_reclaimed_gb)).toFixed(3) },
    { header: 'GB used', value: r => (r.client_used_gb == null ? '' : Number(r.client_used_gb).toFixed(3)) },
    { header: 'GB unassigned', value: r => (r.client_available_gb == null ? '' : Number(r.client_available_gb).toFixed(3)) },
    { header: 'Last transfer (UTC)', value: r => r.last_transfer_at ?? '' },
    { header: 'Last note', value: r => r.last_note ?? '' },
  ])
  return csvResponse(csv, 'globproxy-clients')
}
