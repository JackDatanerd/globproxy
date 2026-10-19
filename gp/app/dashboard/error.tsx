'use client'
import { useEffect } from 'react'
import Link from 'next/link'

// Without a boundary, any thrown error in a dashboard page (a failed query
// that a page chose to throw on, a render bug) replaced the whole app shell
// with Next's generic error screen — no sidebar, no way back.
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[dashboard] render error', error) }, [error])
  return (
    <div className="max-w-xl">
      <div className="bg-white border border-border rounded-xl p-8">
        <h1 className="font-display font-bold text-xl text-ink mb-2">Something went wrong</h1>
        <p className="text-sm text-muted mb-5">
          This page couldn&apos;t load. Your proxies and balance are unaffected. Try again, and if it keeps happening
          contact support{error.digest ? ` with reference ${error.digest}` : ''}.
        </p>
        <div className="flex gap-3">
          <button onClick={reset} className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90">Try again</button>
          <Link href="/dashboard" className="border border-border text-ink2 px-5 py-2.5 rounded-xl text-sm hover:text-ink">Back to overview</Link>
        </div>
      </div>
    </div>
  )
}
