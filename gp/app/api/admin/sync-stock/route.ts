import { authorizeAdmin } from '@/lib/adminAuth'
import { computeStockStatus } from '@/lib/stockStatus'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response

  try {
    const stock = await computeStockStatus(auth.supabase)
    // The upsert error used to be ignored: the response (and the panel)
    // showed fresh stock even when nothing had been saved.
    const { error } = await auth.supabase
      .from('platform_settings')
      .upsert({ key: 'upstream_stock', value: JSON.stringify(stock) }, { onConflict: 'key' })
    if (error) return NextResponse.json({ error: `Stock computed but could not be saved: ${error.message}` }, { status: 500 })
    return NextResponse.json({ stock })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
