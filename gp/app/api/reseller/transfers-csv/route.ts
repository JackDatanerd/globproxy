import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireMfaVerified } from '@/lib/mfa'
import { toCsv, csvResponse } from '@/lib/csv'
import { NextResponse } from 'next/server'

const PAGE = 1000
const MAX_ROWS = 50_000

// Full transfer history export for the signed-in reseller. Reads through the
// service role scoped to reseller_id = the authenticated user (resellers no
// longer have RLS read access to client profile rows — migration 0039).
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

  const admin = await createAdminClient()
  const rows: any[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await admin
      .from('reseller_transfers')
      .select('id, gb_amount, reclaimed_gb, status, note, created_at, recipient:recipient_id(email, full_name)')
      .eq('reseller_id', user.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }) // stable paging: bulk claims share one created_at
      .range(from, from + PAGE - 1)
    if (error) return NextResponse.json({ error: 'Export failed' }, { status: 500 })
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }

  // Open invitations (reserved, not yet delivered) go in the same file so the
  // export reconciles with the stock figure on the dashboard.
  const { data: invites } = await admin
    .from('reseller_pending_transfers')
    .select('id, recipient_email, gb_amount, note, created_at')
    .eq('reseller_id', user.id).eq('status', 'pending').order('created_at', { ascending: false }).limit(1000)
  for (const i of invites ?? []) {
    rows.push({ id: i.id, gb_amount: i.gb_amount, reclaimed_gb: 0, status: 'invited (awaiting sign-up)', note: i.note, created_at: i.created_at, recipient: { email: i.recipient_email, full_name: '' } })
  }

  const csv = toCsv(rows, [
    { header: 'Date (UTC)', value: r => r.created_at },
    { header: 'Client email', value: r => (r.recipient as any)?.email ?? '' },
    { header: 'Client name', value: r => (r.recipient as any)?.full_name ?? '' },
    { header: 'GB transferred', value: r => Number(r.gb_amount).toFixed(3) },
    { header: 'GB reclaimed', value: r => Number(r.reclaimed_gb ?? 0).toFixed(3) },
    { header: 'Net GB', value: r => (Number(r.gb_amount) - Number(r.reclaimed_gb ?? 0)).toFixed(3) },
    { header: 'Status', value: r => r.status },
    { header: 'Note', value: r => r.note ?? '' },
    { header: 'Transfer ID', value: r => r.id },
  ])
  return csvResponse(csv, 'globproxy-transfers')
}
