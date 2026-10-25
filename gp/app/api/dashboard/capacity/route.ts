import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

// GET /api/dashboard/capacity — one supplier-neutral yes/no for the New session
// form: is network capacity tight right now, so a new session may be queued?
// It reads the stock snapshot the platform already keeps (written by the admin
// stock sync) and returns ONLY the boolean — never a figure, never a name. An
// absent or stale snapshot reads as "not constrained" (no warning is better
// than a wrong one).
const FRESH_MS = 6 * 3600_000

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const admin = await createAdminClient()
    const { data } = await admin.from('platform_settings').select('value').like('key', '%_stock').limit(1).maybeSingle()  // the one stock-snapshot row; matched by suffix so this file never spells the stored key (it names the supplier)
    if (!data?.value) return NextResponse.json({ constrained: false })
    const stock = typeof data.value === 'string' ? JSON.parse(data.value) : data.value
    const fresh = stock?.last_synced && Date.now() - new Date(stock.last_synced).getTime() < FRESH_MS
    const constrained = !!fresh && (stock.covered === false || Number(stock.available_gb) <= 0)
    return NextResponse.json({ constrained }, { headers: { 'Cache-Control': 'private, max-age=60' } })
  } catch {
    return NextResponse.json({ constrained: false })
  }
}
