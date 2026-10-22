import { createAdminClient, createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { listApiActivity } from '@/lib/apiActivity'
import { requireActiveUser } from '@/lib/apiAuth'

// Mutating API calls made with this account's keys (last 30 days) — "what did
// that key do?" after a suspected leak. ?key_id=&limit=&before=<ISO>
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Middleware excludes /api, so a suspended or deleted account's unexpired
  // session would otherwise still read its key activity.
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  const url = new URL(req.url)
  const r = await listApiActivity(await createAdminClient(), user.id, {
    keyId: url.searchParams.get('key_id'), limit: Number(url.searchParams.get('limit')) || undefined, before: url.searchParams.get('before'), beforeId: url.searchParams.get('before_id'),
  })
  if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status })
  return NextResponse.json(r.data)
}
