'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { safeNextPath } from '@/lib/safeNext'
import Turnstile, { turnstileConfigured } from '@/components/auth/Turnstile'
import toast from 'react-hot-toast'
import { Suspense } from 'react'

function LoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [captcha, setCaptcha] = useState<string | null>(null)
  const [captchaReset, setCaptchaReset] = useState(0)
  const router = useRouter()
  const params = useSearchParams()
  const suspended = params.get('suspended')
  const deleted = params.get('deleted')
  const linkExpired = params.get('error') === 'link_expired'
  const confirmLink = params.get('kind') === 'confirm'
  const justConfirmed = params.get('notice') === 'confirmed'
  // Where to go after signing in. Validated: `next` comes straight off the URL.
  const next = safeNextPath(params.get('next'))

  useEffect(() => {
    createClient().auth.getSession().then(({ data: { session } }) => {
      if (session) router.replace(next)
    })
  }, [router, next])

  async function handle(e: React.FormEvent) {
    e.preventDefault()
    if (turnstileConfigured && !captcha) { toast.error('Please complete the verification check.'); return }
    setLoading(true)
    setUnconfirmed(false)
    try {
      // Sign-in goes through our server route (rate limiting, bot check,
      // sign-in notices, audit trail). It sets the same session cookies the
      // browser client reads.
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, turnstileToken: captcha }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data.code === 'email_not_confirmed') setUnconfirmed(true)
        toast.error(data.error ?? 'Sign-in failed. Please try again.')
        setLoading(false)
        setCaptcha(null)
        setCaptchaReset(n => n + 1)
        return
      }
      // Hard navigation so the new session cookies are what the next
      // request (and middleware) sees.
      router.push(next)
      router.refresh()
    } catch {
      toast.error('Network error. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="w-full max-w-md">
      {suspended && <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl mb-5">Your account has been suspended. Contact support@globproxy.com.</div>}
      {deleted && <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl mb-5">This account has been deleted.</div>}
      {justConfirmed && (
        <div className="bg-green-50 border border-green-200 text-green-800 text-sm px-4 py-3 rounded-xl mb-5">
          Thanks — if that was your confirmation link, your email is confirmed. Sign in below.
        </div>
      )}
      {linkExpired && (
        confirmLink ? (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3 rounded-xl mb-5">
            That link couldn’t finish signing you in on this browser — but opening it usually already confirmed your email.
            Try signing in below. If it says your email isn’t confirmed, <Link href="/auth/verify" className="underline">resend the confirmation email</Link>.
          </div>
        ) : (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3 rounded-xl mb-5">
            That link no longer works. If it was a password reset link, <Link href="/auth/reset" className="underline">request a new one</Link>.
          </div>
        )
      )}
      <div className="bg-white border border-border rounded-2xl p-10 shadow-sm">
        <h1 className="font-display font-bold text-2xl text-ink mb-1">Welcome back</h1>
        <p className="text-muted text-sm mb-8">Sign in to your GlobProxy dashboard</p>
        <form onSubmit={handle} className="flex flex-col gap-5">
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Email</label>
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Password</label>
            <input type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
            <div className="text-right mt-1.5"><Link href="/auth/reset" className="text-xs text-muted hover:text-accent transition-colors">Forgot password?</Link></div>
          </div>
          {unconfirmed && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3 rounded-xl">
              Your email address hasn’t been confirmed yet.{' '}
              <Link href={`/auth/verify?email=${encodeURIComponent(email)}`} className="underline">Resend the confirmation email</Link>.
            </div>
          )}
          <Turnstile onToken={setCaptcha} resetSignal={captchaReset} />
          <button type="submit" disabled={loading} className="w-full bg-accent text-white py-3 rounded-xl font-medium text-sm hover:opacity-90 disabled:opacity-60 transition-opacity">
            {loading ? 'Signing in...' : 'Sign in →'}
          </button>
        </form>
        <div className="flex items-center gap-3 my-6"><div className="flex-1 h-px bg-border" /><span className="text-xs text-muted">or</span><div className="flex-1 h-px bg-border" /></div>
        <p className="text-center text-sm text-muted">No account? <Link href="/auth/signup" className="text-accent hover:underline">Create one free</Link></p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return <Suspense fallback={<div className="w-full max-w-md bg-white border border-border rounded-2xl p-10 text-center text-muted text-sm">Loading...</div>}><LoginForm /></Suspense>
}
