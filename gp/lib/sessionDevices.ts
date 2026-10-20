import { createAdminClient } from '@/lib/supabase/server'
import { requestMeta } from '@/lib/securityEvents'

/** The `session_id` claim of a Supabase access token (= auth.sessions.id). */
export function sessionIdFromJwt(accessToken: string | undefined): string | null {
  try {
    const payload = accessToken?.split('.')[1]
    if (!payload) return null
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof json?.session_id === 'string' ? json.session_id : null
  } catch {
    return null
  }
}

/**
 * Remember which browser a login session belongs to. Sign-in happens on the
 * server, so auth.sessions only holds the Worker's IP / user-agent; this
 * table (migration 0052) keeps the visitor's real ones for the "Where you're
 * signed in" card. Best-effort: never allowed to break a sign-in.
 */
export async function recordSessionDevice(userId: string, accessToken: string | undefined, req: Request): Promise<void> {
  try {
    const sessionId = sessionIdFromJwt(accessToken)
    if (!sessionId) return
    const { ip, ua } = requestMeta(req)
    const admin = await createAdminClient()
    const { error } = await admin.from('login_sessions').upsert(
      { session_id: sessionId, user_id: userId, ip, user_agent: ua ? ua.slice(0, 400) : null },
      { onConflict: 'session_id', ignoreDuplicates: true },
    )
    if (error) console.error('[sessionDevices] record failed', error.message)
  } catch (e) {
    console.error('[sessionDevices] record threw', e)
  }
}

export async function sessionDevices(userId: string): Promise<Map<string, { ip: string | null; user_agent: string | null }>> {
  const out = new Map<string, { ip: string | null; user_agent: string | null }>()
  try {
    const admin = await createAdminClient()
    const { data } = await admin.from('login_sessions').select('session_id, ip, user_agent').eq('user_id', userId)
    for (const r of data ?? []) out.set(r.session_id as string, { ip: (r.ip as string | null) ?? null, user_agent: (r.user_agent as string | null) ?? null })
  } catch (e) {
    console.error('[sessionDevices] list failed', e)
  }
  return out
}
