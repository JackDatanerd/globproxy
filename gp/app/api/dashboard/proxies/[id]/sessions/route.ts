import { createClient } from '@/lib/supabase/server'
import { genSessionId } from '@/lib/proxyEndpoint'
import { NextResponse } from 'next/server'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('proxy_sessions')
    .select('id, session_token, label, pinned, collapsed, terminated_at, created_at')
    .eq('credential_id', id)
    .eq('user_id', user.id)
    .is('terminated_at', null)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sessions: data })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Confirm the credential belongs to this user and is actually sticky —
  // named sessions only make sense for sticky, rotating has no session concept.
  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('id, session_type')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!cred) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (cred.session_type !== 'sticky') {
    return NextResponse.json({ error: 'Sessions only apply to sticky credentials' }, { status: 400 })
  }

  const body = await req.json().catch(() => ({}))
  const label = (body.label || '').trim() || 'Session'

  const { data, error } = await supabase.from('proxy_sessions').insert({
    credential_id: id,
    user_id: user.id,
    session_token: genSessionId(), // fixed at creation — this IS the point of a persisted session
    label,
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ session: data }, { status: 201 })
}
