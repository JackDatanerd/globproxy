'use client'
import { useState, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { validateEmail } from '@/lib/email-validation'
import toast from 'react-hot-toast'

function SignupForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [emailErr, setEmailErr] = useState('')
  const router = useRouter()
  const params = useSearchParams()
  const isReseller = params.get('role') === 'reseller'

  function onEmailBlur() {
    if (!email) return
    const { valid, error } = validateEmail(email)
    setEmailErr(valid ? '' : (error ?? ''))
  }

  async function handle(e: React.FormEvent) {
    e.preventDefault()
    const { valid, error } = validateEmail(email)
    if (!valid) { setEmailErr(error ?? ''); return }
    setLoading(true)

    const { error: err } = await createClient().auth.signUp({
      email, password,
      options: {
        data: { full_name: name, intended_role: isReseller ? 'reseller' : 'user' },
        emailRedirectTo: `${location.origin}/auth/callback`
      }
    })

    if (err) {
      // Supabase returns this for already-registered emails
      if (err.message.toLowerCase().includes('already registered') ||
          err.message.toLowerCase().includes('user already exists')) {
        toast.error('An account with this email already exists.')
        setEmailErr('Already registered — try signing in instead.')
      } else {
        toast.error(err.message)
      }
      setLoading(false)
      return
    }

    toast.success('Check your email to confirm your account!')
    router.push('/auth/verify')
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
            <input type="password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} placeholder="Min. 8 characters"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
          </div>
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