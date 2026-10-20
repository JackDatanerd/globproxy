'use client'
import { createClient } from '@/lib/supabase/client'

// One place for every admin-panel button to call an /api/admin/* route.
// Previously each component hand-rolled getSession + fetch + res.json():
// a missing session sent "Bearer undefined", and a network failure or a
// non-JSON error body threw out of the handler and left the button stuck
// on its loading state forever.
export async function adminPost<T = any>(
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  try {
    const { data: { session } } = await createClient().auth.getSession()
    if (!session?.access_token) {
      return { ok: false, status: 401, data: { error: 'Your session has expired — refresh the page and sign in again.' } as any }
    }
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body ?? {}),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok && !data?.error, status: res.status, data }
  } catch {
    return { ok: false, status: 0, data: { error: 'Network error — check your connection and try again.' } as any }
  }
}

// GET counterpart for the few panels that load their data from an admin
// route (instead of reading tables from the browser with the user's JWT,
// which would sidestep the TOTP step-up the routes enforce).
export async function adminGet<T = any>(
  path: string
): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  try {
    const { data: { session } } = await createClient().auth.getSession()
    if (!session?.access_token) {
      return { ok: false, status: 401, data: { error: 'Your session has expired — refresh the page and sign in again.' } as any }
    }
    const res = await fetch(path, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: 'no-store',
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok && !data?.error, status: res.status, data }
  } catch {
    return { ok: false, status: 0, data: { error: 'Network error — check your connection and try again.' } as any }
  }
}
