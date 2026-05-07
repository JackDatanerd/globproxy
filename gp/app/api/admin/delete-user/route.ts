import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createAdminClient()
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: { user: caller } } = await supabase.auth.getUser(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: cp } = await supabase.from('profiles').select('role').eq('id', caller.id).single()
  if (cp?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { user_id } = await req.json()
  if (!user_id) return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  const { data: tp } = await supabase.from('profiles').select('role').eq('id', user_id).single()
  if (tp?.role === 'admin') return NextResponse.json({ error: 'Cannot delete admin accounts' }, { status: 403 })
  const { error } = await supabase.auth.admin.deleteUser(user_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
