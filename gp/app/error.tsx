'use client'
import { useEffect } from 'react'

// Root error boundary. A segment's error.tsx never catches an error thrown by
// that same segment's layout (the dashboard layout fails closed by throwing
// when it cannot load the account), so without this the customer got Next's
// bare default error page. This one keeps the brand, says what is safe, and
// offers a way forward.
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[app] render error', error) }, [error])
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <div className="bg-white border border-border rounded-xl p-8 max-w-md w-full">
        <div className="font-display font-black text-xl text-ink tracking-tight mb-4">Glob<span className="text-accent">Proxy</span></div>
        <h1 className="font-display font-bold text-xl text-ink mb-2">Something went wrong</h1>
        <p className="text-sm text-muted mb-5">
          We couldn&apos;t load this page. Your proxies and balance are unaffected. Try again, and if it keeps happening
          contact support{error.digest ? ` with reference ${error.digest}` : ''}.
        </p>
        <div className="flex gap-3">
          <button onClick={reset} className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90">Try again</button>
          <a href="/dashboard" className="border border-border text-ink2 px-5 py-2.5 rounded-xl text-sm hover:text-ink">Go to dashboard</a>
        </div>
      </div>
    </div>
  )
}
