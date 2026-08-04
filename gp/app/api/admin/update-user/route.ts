import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Handles the role-change and API-access actions from AdminUserControls.tsx
// ("Make reseller", "Make regular user", "Grant/Revoke API access").
// Previously these wrote straight to `profiles` from the browser with no
// server-side route at all — functionally fine given RLS, but with no
// audit point and no consistent place to add side effects (e.g. killing
// sessions on a role downgrade) the way suspend-user already does.
export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: { user: caller } } = await supabase.auth.getUser(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: cp } = await supabase.from('profiles').select('role').eq('id', caller.id).single()
  if (cp?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { user_id, action } = await req.json() as {
    user_id?: string
    action?: 'make_reseller' | 'make_user' | 'toggle_api_access'
  }
  if (!user_id || !action) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })

  const { data: target } = await supabase.from('profiles').select('role, api_access').eq('id', user_id).single()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'admin') return NextResponse.json({ error: 'Cannot modify an admin account' }, { status: 403 })

  let updates: Record<string, any>
  switch (action) {
    case 'make_reseller':
      updates = { role: 'reseller', reseller_status: 'approved' }
      break
    case 'make_user':
      // Also clear reseller_status so a demoted account doesn't sit around
      // with a stale 'approved' status that no longer means anything.
      updates = { role: 'user', reseller_status: null }
      break
    case 'toggle_api_access':
      updates = { api_access: !target.api_access }
      break
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  const { error } = await supabase.from('profiles').update(updates).eq('id', user_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Previously tried to kill the target's session here via
  // auth.admin.signOut(user_id, 'others') — same bug as suspend-user had:
  // signOut() takes a session JWT, not a user_id (see auth-js's own type
  // signature), so this always failed silently and did nothing. Unlike
  // suspend-user, this isn't a ban — the user should still be able to log
  // in as whatever they now are — so ban_duration isn't the right fix
  // here. Turns out no fix is needed: every authorization check in this
  // app (RLS policies, requireApiAccess, every admin/*  route) reads
  // role/api_access/is_suspended fresh from `profiles` per request rather
  // than trusting a JWT claim, so a downgraded user's still-live session
  // is already fully constrained by the new values the moment this
  // update() above commits — there's nothing a stale token lets them do
  // that the fresh DB read wouldn't already block.

  return NextResponse.json({ success: true, updates })
}
