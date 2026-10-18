'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// Two-factor authentication is optional for every account, so this is the
// only pressure the app applies: a dismissible nudge at the top of the
// dashboard for anyone who hasn't turned it on. Dismissal is remembered per
// browser — a day for admin/reseller accounts (which can move money / touch
// other users' data), two weeks for everyone else.
const KEY = 'gp_mfa_nudge_until'

export default function MfaRecommendBanner({ role }: { role: string }) {
  const [hidden, setHidden] = useState(true)
  const privileged = role === 'admin' || role === 'reseller'

  useEffect(() => {
    try {
      const until = Number(localStorage.getItem(KEY) ?? 0)
      setHidden(Date.now() < until)
    } catch {
      setHidden(false)
    }
  }, [])

  if (hidden) return null

  function dismiss() {
    const days = privileged ? 1 : 14
    try { localStorage.setItem(KEY, String(Date.now() + days * 24 * 60 * 60 * 1000)) } catch { /* private mode */ }
    setHidden(true)
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-accent/20 bg-accent-light px-4 py-3">
      <p className="flex-1 min-w-[220px] text-sm text-ink2">
        <span className="font-semibold text-ink">Protect your account with two-factor authentication.</span>{' '}
        {privileged
          ? 'Your account can move money and manage other users — a stolen password alone shouldn’t be enough to get in.'
          : 'It takes about a minute, and a stolen password alone won’t be enough to get into your proxies, billing or API keys.'}
      </p>
      <Link
        href="/auth/mfa-setup?next=/dashboard/settings"
        className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
      >
        Turn on 2FA
      </Link>
      <button onClick={dismiss} className="text-xs text-muted hover:text-ink2" aria-label="Dismiss for now">
        Not now
      </button>
    </div>
  )
}
