'use client'

// Last-resort boundary: replaces the root layout itself, so it must provide
// <html>/<body> and cannot depend on the app's stylesheet.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f7f8fa', color: '#111' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 32, maxWidth: 440, width: '100%' }}>
            <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: '#6b7280', margin: '0 0 20px' }}>
              We couldn&apos;t load GlobProxy. Your proxies and balance are unaffected.
              {error.digest ? ` Reference: ${error.digest}.` : ''}
            </p>
            <button onClick={reset} style={{ background: '#2563eb', color: '#fff', border: 0, borderRadius: 10, padding: '10px 20px', fontSize: 14, cursor: 'pointer' }}>Try again</button>
          </div>
        </div>
      </body>
    </html>
  )
}
