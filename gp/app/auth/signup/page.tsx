'use client'
import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { validateEmail } from '@/lib/email-validation'
import Turnstile, { turnstileConfigured } from '@/components/auth/Turnstile'
import toast from 'react-hot-toast'
import { PLANS } from '@/lib/plans'

function SignupForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [emailErr, setEmailErr] = useState('')
  const [captcha, setCaptcha] = useState<string | null>(null)
  const [captchaReset, setCaptchaReset] = useState(0)
  const router = useRouter()
  const params = useSearchParams()
  const isReseller = params.get('role') === 'reseller'
  const urlRef = params.get('ref')
  // A plan picked on the pricing page (?plan=growth): after the email is
  // confirmed the visitor lands on the buy page with that plan selected instead
  // of a bare dashboard. Only a known slug is carried.
  const planParam = params.get('plan')
  const chosenPlan = !isReseller && planParam && PLANS.some(pl => pl.slug === planParam && !pl.custom) ? planParam : null
  const [referralCode, setReferralCode] = useState(urlRef ?? '')
  const [refInfo, setRefInfo] = useState<{ valid: boolean; bonus?: boolean; bonusGb?: number; minOrderUsd?: number } | null>(null)

  // First-party cookie set by /r/[code] and <RefCapture/> — covers visitors
  // who browsed around before reaching signup without ?ref= on this URL.
  useEffect(() => {
    if (urlRef) return
    const m = document.cookie.match(/(?:^|; )gp_ref=([^;]+)/)
    if (m) { try { setReferralCode(decodeURIComponent(m[1])) } catch { /* ignore */ } }
  }, [urlRef])

  // Tell the visitor something TRUE about the code (valid? is there a bonus?).
  useEffect(() => {
    const code = referralCode.trim()
    if (!/^[A-Za-z0-9]{4,32}$/.test(code)) { setRefInfo(null); return }
    const t = setTimeout(() => {
      fetch(`/api/referral/check?code=${encodeURIComponent(code)}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => setRefInfo(d))
        .catch(() => setRefInfo(null))
    }, 400)
    return () => clearTimeout(t)
  }, [referralCode])

  function onEmailBlur() {
    if (!email) return
    const { valid, error } = validateEmail(email)
    setEmailErr(valid ? '' : (error ?? ''))
  }

  async function handle(e: React.FormEvent) {
    e.preventDefault()
    const { valid, error } = validateEmail(email)
    if (!valid) { setEmailErr(error ?? ''); return }
    if (turnstileConfigured && !captcha) { toast.error('Please complete the verification check.'); return }
    setLoading(true)

    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        full_name: name,
        intended_role: isReseller ? 'reseller' : 'user',
        emailRedirectTo: chosenPlan
          ? `${location.origin}/auth/callback?next=${encodeURIComponent(`/dashboard/buy?plan=${chosenPlan}`)}`
          : `${location.origin}/auth/callback`,
        referral_code: referralCode.trim() || undefined,
        sub_id: params.get('sub') || undefined,
        turnstileToken: captcha,
      }),
    })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      // These are genuine input errors (missing fields, invalid email,
      // weak password) — not "does this email have an account", which the
      // API now deliberately never reveals. Banned/already-registered/
      // brand-new all return the same success response below, same
      // pattern as the password-reset flow, so this can't be used to
      // enumerate registered emails.
      toast.error(data.error ?? 'Could not create your account. Please try again.')
      setLoading(false)
      setCaptcha(null)
      setCaptchaReset(n => n + 1)
      return
    }

    toast.success('Check your email to confirm your account!')
    router.push(`/auth/verify?email=${encodeURIComponent(email)}`)
  }

  return (
    <div className="w-full max-w-md">
      <div className="bg-white border border-border rounded-2xl p-10 shadow-sm">
        {isReseller && <div className="bg-accent2-light text-accent2 text-xs font-mono tracking-wider px-3 py-1.5 rounded-lg mb-5 inline-block">Reseller application</div>}
        <h1 className="font-display font-bold text-2xl text-ink mb-1">{isReseller ? 'Apply to resell' : 'Create your account'}</h1>
        <p className="text-muted text-sm mb-8">{isReseller ? 'No minimum commitment to join.' : 'Get started today.'}</p>
        <form onSubmit={handle} className="flex flex-col gap-5">
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Full name</label>
            <input type="text" required value={name} onChange={e => setName(e.target.value)} placeholder="Your name"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Email</label>
            <input type="email" required value={email}
              onChange={e => { setEmail(e.target.value); if (emailErr) setEmailErr('') }}
              onBlur={onEmailBlur} placeholder="you@yourcompany.com"
              className={`w-full bg-surface border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none transition-colors ${emailErr ? 'border-red-300 focus:border-red-400' : 'border-border focus:border-accent'}`} />
            {emailErr && (
              <p className="text-xs text-red-500 mt-1.5">
                {emailErr}{' '}
                {emailErr.includes('signing in') && (
                  <Link href="/auth/login" className="underline font-medium">Sign in →</Link>
                )}
              </p>
            )}
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Password</label>
            <input type="password" required minLength={8} maxLength={72} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Min. 8 characters"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Referral code <span className="normal-case tracking-normal">(optional)</span></label>
            <input type="text" value={referralCode} maxLength={32} onChange={e => setReferralCode(e.target.value.toUpperCase())} placeholder="e.g. A1B2C3D4"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm font-mono focus:outline-none focus:border-accent transition-colors" />
            {refInfo?.valid && (
              <p className="text-xs text-green-600 mt-1.5">
                {refInfo.bonus
                  ? `Code applied — after your first purchase of $${refInfo.minOrderUsd}+ you both get ${refInfo.bonusGb} GB free.`
                  : 'Code applied.'}
              </p>
            )}
            {refInfo && !refInfo.valid && referralCode.trim() && (
              <p className="text-xs text-muted mt-1.5">We couldn&apos;t find that code — you can still sign up without it.</p>
            )}
          </div>
          <Turnstile onToken={setCaptcha} resetSignal={captchaReset} />
          <button type="submit" disabled={loading || !!emailErr}
            className="w-full bg-accent text-white py-3 rounded-xl font-medium text-sm hover:opacity-90 disabled:opacity-60 transition-opacity">
            {loading ? 'Creating account...' : isReseller ? 'Apply to resell →' : 'Create account →'}
          </button>
        </form>
        <p className="text-center text-xs text-muted mt-5">By signing up you agree to our <Link href="/terms" className="text-accent hover:underline">Terms</Link> and <Link href="/privacy" className="text-accent hover:underline">Privacy Policy</Link></p>
        <div className="flex items-center gap-3 my-5"><div className="flex-1 h-px bg-border" /><span className="text-xs text-muted">or</span><div className="flex-1 h-px bg-border" /></div>
        <p className="text-center text-sm text-muted">Already have an account? <Link href="/auth/login" className="text-accent hover:underline">Sign in</Link></p>
      </div>
    </div>
  )
}

export default function SignupPage() {
  return <Suspense fallback={<div className="w-full max-w-md bg-white border border-border rounded-2xl p-10 text-center text-muted text-sm">Loading...</div>}><SignupForm /></Suspense>
}