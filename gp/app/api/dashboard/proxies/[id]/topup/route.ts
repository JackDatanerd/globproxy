import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { parseGbAmount } from '@/lib/apiValidation'
import { topupCredential } from '@/lib/credentials'
import { NextResponse } from 'next/server'

// Adds GB to a credential the user already owns, instead of requiring a
// brand-new credential every time they run out. Deliberately additive —
// "create a new one" stays available; some customers want a disposable,
// capped credential and shouldn't have it silently made extendable.
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const gb = parseGbAmount(body?.gb_amount)
  if (!gb.ok) return NextResponse.json({ error: gb.error }, { status: 400 })

  const admin = await createAdminClient()
  const result = await topupCredential(admin, user.id, id, gb.value, 'dashboard')
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })

  return NextResponse.json({ success: true, gb_allocated: result.data.gb_allocated, warning: result.data.warning })
}
