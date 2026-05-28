import { createAdminClient } from '@/lib/supabase/server'
import { getAccountBalance } from '@/lib/geonode'
import { NextResponse } from 'next/server'

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
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const balance = await getAccountBalance()
    const stock = {
      available_gb: balance.available_gb,
      total_gb: balance.total_gb,
      last_synced: new Date().toISOString(),
    }
    await supabase
      .from('platform_settings')
      .upsert({ key: 'geonode_stock', value: JSON.stringify(stock) }, { onConflict: 'key' })
    return NextResponse.json({ stock })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
