'use client'
import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import Turnstile, { turnstileConfigured } from '@/components/auth/Turnstile'
import toast from 'react-hot-toast'

const COOLDOWN_S = 60

function VerifyForm() {
  const params = useSearchParams()
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [sending, setSending] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [captcha, setCaptcha] = useState<string | null>(null)
  const [captchaReset, setCaptchaReset] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  async function resend(e: React.FormEvent) {
    e.preventDefault()
    if (turnstileConfigured && !captcha) { toast.error('Please complete the verification check.'); return }
    setSending(true)
    try {
      const res = await fetch('/api/auth/resend-confirmation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, emailRedirectTo: `${location.origin}/auth/callback`, turnstileToken: captcha }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error ?? 'Could not resend the email. Please try again shortly.')
      } else {
        toast.success('If that address is waiting for confirmation, we’ve sent a new link.')
        setCooldown(COOLDOWN_S)
      }
    } catch {
      toast.error('Network error. Please try again.')
    }
    setSending(false)
    setCaptcha(null)
    setCaptchaReset(n => n + 1)
  }

  return (
    <div className="w-full max-w-md">
      <div className="bg-white border border-border rounded-2xl p-10 shadow-sm text-center">
        <div className="text-4xl mb-5">📬</div>
        <h1 className="font-display font-bold text-2xl text-ink mb-2">Check your inbox</h1>
        <p className="text-muted text-sm font-light leading-relaxed mb-7">
          We sent a confirmation link{params.get('email') ? <> to <span className="text-ink font-medium">{params.get('email')}</span></> : ' to your email'}. Click it to activate your account.
        </p>
        <form onSubmit={resend} className="flex flex-col gap-3 text-left">
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider">Didn’t get it? Resend to</label>
          <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"
            className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
          <Turnstile onToken={setCaptcha} resetSignal={captchaReset} />
          <button type="submit" disabled={sending || cooldown > 0 || !email}
            className="w-full bg-accent text-white py-3 rounded-xl font-medium text-sm hover:opacity-90 disabled:opacity-60 transition-opacity">
            {sending ? 'Sending...' : cooldown > 0 ? `Resend available in ${cooldown}s` : 'Resend confirmation email'}
          </button>
        </form>
        <p className="text-xs text-muted mt-5">Check your spam folder too. Wrong address? <Link href="/auth/signup" className="text-accent hover:underline">Start over</Link>. Already confirmed? <Link href="/auth/login" className="text-accent hover:underline">Sign in</Link>.</p>
      </div>
    </div>
  )
}

export default function VerifyPage() {
  return <Suspense fallback={<div className="w-full max-w-md bg-white border border-border rounded-2xl p-10 text-center text-muted text-sm">Loading...</div>}><VerifyForm /></Suspense>
}
