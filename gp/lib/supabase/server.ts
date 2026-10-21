import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

type CookieToSet = {
  name: string
  value: string
  options?: Record<string, any>
}

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet: CookieToSet[]) => {
          try {
            toSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            /* server component — safe to ignore */
          }
        },
      },
    }
  )
}

// Every service-role query goes through this. Without a ceiling a hung database
// connection holds the Worker request open until the platform kills it — and a route
// killed half-way through a multi-step write is worse than one that fails fast and
// reports. Generous on purpose: it bounds time-to-response-headers only, and the
// slowest legitimate admin queries here finish in a few seconds.
const ADMIN_DB_TIMEOUT_MS = 25_000

function adminFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const outer = init?.signal
  const onOuterAbort = () => ctrl.abort(outer?.reason)
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason)
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timer = setTimeout(() => ctrl.abort(new Error(`Database request timed out after ${ADMIN_DB_TIMEOUT_MS}ms`)), ADMIN_DB_TIMEOUT_MS)
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onOuterAbort)
  })
}

export async function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: { fetch: adminFetch },
    }
  )
}
