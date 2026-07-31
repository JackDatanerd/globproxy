import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Shared gate for every app/api/v1/* route.
//
// Previously each v1 route duplicated this check and none of them checked
// is_suspended. Combined with the admin panel bypassing /api/admin/suspend-user
// (see AdminUserControls.tsx / AdminResellerActions.tsx fix), a suspended
// reseller's existing token kept working against the v1 API indefinitely.
// /api/v1/account/bandwidth also had no role/api_access check at all —
// any authenticated 'user' role account (not just resellers) could hit it.
export type ApiAuthResult =
  | { ok: true; user: { id: string; email?: string }; supabase: Awaited<ReturnType<typeof createAdminClient>> }
  | { ok: false; response: NextResponse }

export async function requireApiAccess(req: Request): Promise<ApiAuthResult> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  const supabase = await createAdminClient()

  if (!token) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, api_access, is_suspended')
    .eq('id', user.id)
    .single()

  if (profile?.is_suspended) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'This account has been suspended. Contact support@globproxy.com.' }, { status: 403 }),
    }
  }

  if (profile?.role === 'user') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'API access is not enabled for your account. Apply at globproxy.com/reseller.' },
        { status: 403 }
      ),
    }
  }

  if (!profile?.api_access && profile?.role !== 'admin') {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'API access is not enabled for your account. Apply at globproxy.com/reseller.' },
        { status: 403 }
      ),
    }
  }

  return { ok: true, user, supabase }
}
