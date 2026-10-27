'use client'
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // The browser client rewrites the session cookie whenever it refreshes the token. Without
      // this the rewrite drops the Secure attribute the server set (http://localhost dev keeps
      // working: Secure only when the page itself is https).
      cookieOptions: { secure: typeof window !== 'undefined' && window.location.protocol === 'https:' },
    }
  )
}
