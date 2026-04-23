import { createAdminClient } from '@/lib/supabase/server'
import { getSubUserUsage } from '@/lib/geonode'
import { NextResponse } from 'next/server'

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await context.params
  const { data: cred } = await supabase.from('proxy_credentials').select('*').eq('id', id).eq('user_id', user.id).single()
  if (!cred) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let usedGb = cred.gb_used
  if (cred.status === 'active' && cred.geonode_username) {
    try {
      usedGb = await getSubUserUsage(cred.geonode_username)
      await supabase.from('proxy_credentials').update({ gb_used: usedGb }).eq('id', cred.id)
    } catch {}
  }
  return NextResponse.json({ id: cred.id, label: cred.label, status: cred.status, gb_allocated: cred.gb_allocated, gb_used: usedGb, gb_remaining: Math.max(0, cred.gb_allocated - usedGb), country: cred.country, city: cred.city })
}
