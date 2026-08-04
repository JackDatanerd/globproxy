import { createAdminClient } from '@/lib/supabase/server'
import { syncAllUsage, syncUserUsage } from '@/lib/usageSync'
import { NextResponse } from 'next/server'

// POST { user_id?: string }
// user_id omitted → full sync (same as the cron 'usage' task).
// user_id present → just that user's active credentials, for resolving a
// balance dispute or confirming a fix without waiting for the next cron tick.
export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: { user: caller } } = await supabase.auth.getUser(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: cp } = await supabase.from('profiles').select('role').eq('id', caller.id).single()
  if (cp?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { user_id } = await req.json().catch(() => ({ user_id: undefined }))

  try {
    const result = user_id ? await syncUserUsage(user_id) : await syncAllUsage()
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    console.error('Admin usage sync failed:', err)
    return NextResponse.json({ error: err.message ?? 'Sync failed' }, { status: 500 })
  }
}
