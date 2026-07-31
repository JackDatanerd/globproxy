import { requireApiAccess } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  // Previously this route had no role/api_access gate at all — any
  // authenticated account, including plain 'user' role with no API
  // subscription, could hit it. Bringing it in line with the other v1
  // routes' gating.
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  const { data: bw } = await supabase.from('bandwidth_accounts').select('total_gb,used_gb,available_gb').eq('user_id', user.id).single()
  return NextResponse.json({ total_gb: bw?.total_gb ?? 0, used_gb: bw?.used_gb ?? 0, available_gb: bw?.available_gb ?? 0, expires: 'never' })
}
