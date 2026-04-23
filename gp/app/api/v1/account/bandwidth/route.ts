import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: bw } = await supabase.from('bandwidth_accounts').select('total_gb,used_gb,available_gb').eq('user_id', user.id).single()
  return NextResponse.json({ total_gb: bw?.total_gb ?? 0, used_gb: bw?.used_gb ?? 0, available_gb: bw?.available_gb ?? 0, expires: 'never' })
}
