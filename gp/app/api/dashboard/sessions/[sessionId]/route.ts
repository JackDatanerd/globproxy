import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'

export async function PATCH(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const body = await req.json().catch(() => ({}))
  const update: Record<string, any> = {}

  if (typeof body.label === 'string') update.label = body.label.trim().slice(0, 100) || 'Session'
  if (typeof body.pinned === 'boolean') update.pinned = body.pinned
  if (typeof body.collapsed === 'boolean') update.collapsed = body.collapsed
  if (body.terminate === true) update.terminated_at = new Date().toISOString()

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('proxy_sessions')
    .update(update)
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .select()
    .maybeSingle()

  if (error) {
    console.error('[dashboard/sessions/[sessionId]] db error:', error)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  // .single() turned "not yours / already deleted" into a 500 with Postgres'
  // "JSON object requested, multiple (or no) rows returned" text.
  if (!data) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  return NextResponse.json({ session: data })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { data: deletedRows, error } = await supabase
    .from('proxy_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .select('id')

  if (error) {
    console.error('[dashboard/sessions/[sessionId]] db error:', error)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  if (!deletedRows || deletedRows.length === 0) {
    return NextResponse.json({ error: 'Delete was blocked — nothing was removed.' }, { status: 404 })
  }
  return NextResponse.json({ success: true })
}
