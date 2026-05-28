import { createAdminClient } from '@/lib/supabase/server'
import { getAccountBalance } from '@/lib/geonode'
import { NextResponse } from 'next/server'

// FIXED: was the debug build — no auth check, no DB write.
// This is the production version: verifies admin role, calls Geonode,
// writes to platform_settings. getAccountBalance() now throws on failure
// so errors surface here instead of silently writing {0, 0} to the DB.

export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profile?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const balance = await getAccountBalance()

    const stock = {
      available_gb: balance.available_gb,
      total_gb: balance.total_gb,
      last_synced: new Date().toISOString(),
    }

    const { error: upsertErr } = await supabase
      .from('platform_settings')
      .upsert({ key: 'geonode_stock', value: JSON.stringify(stock) }, { onConflict: 'key' })

    if (upsertErr) {
      return NextResponse.json({ error: `DB write failed: ${upsertErr.message}` }, { status: 500 })
    }

    return NextResponse.json({ success: true, stock })
  } catch (err: any) {
    // getAccountBalance() throws with the real Geonode error message,
    // so this surfaces bad API keys / wrong reseller IDs directly to the admin UI.
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
