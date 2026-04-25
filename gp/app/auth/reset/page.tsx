'use client'
import { useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'

export default function ResetPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function handle(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    const res = await fetch('/api/auth/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        redirectTo: `${location.origin}/auth/callback?type=recovery`,
      }),
    })

    const data = await res.json()

    if (!res.ok) {
      toast.error(data.error)
      setLoading(false)
      return
    }

    setSent(true)
  }

  return (
    <div className="w-full max-w-md">
      <div className="bg-white border border-border rounded-2xl p-10 shadow-sm">
        {sent ? (
          <div className="text-center">
            <div className="text-3xl mb-4">📬</div>
            <h1 className="font-display font-bold text-2xl text-ink mb-2">Check your inbox</h1>
            <p className="text-muted text-sm font-light mb-6">Reset link sent to <span className="text-ink font-medium">{email}</span>.</p>
            <Link href="/auth/login" className="text-accent text-sm hover:underline">Back to sign in</Link>
          </div>
        ) : (
          <>
            <h1 className="font-display font-bold text-2xl text-ink mb-1">Reset password</h1>
            <p className="text-muted text-sm mb-8">Enter your email and we&apos;ll send a reset link.</p>
            <form onSubmit={handle} className="flex flex-col gap-5">
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Email</label>
                <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
                  className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
              </div>
              <button type="submit" disabled={loading}
                className="w-full bg-accent text-white py-3 rounded-xl font-medium text-sm hover:opacity-90 disabled:opacity-60 transition-opacity">
                {loading ? 'Sending...' : 'Send reset link →'}
              </button>
            </form>
            <p className="text-center text-sm text-muted mt-5">Remembered it? <Link href="/auth/login" className="text-accent hover:underline">Sign in</Link></p>
          </>
        )}
      </div>
    </div>
  )
}