'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { copyText } from '@/lib/clientApi'

// `baseUrl` comes from the server (NEXT_PUBLIC_APP_URL) — the old version read
// window.location.origin during render, which rendered a different value on
// the server vs the client (hydration mismatch) and made the shared link
// depend on which hostname the owner happened to be browsing from.
export default function ReferralLinkCard({
  code, baseUrl, isAffiliate, suspended = false, bonusGb, minOrderUsd,
}: { code: string; baseUrl: string; isAffiliate: boolean; suspended?: boolean; bonusGb: number; minOrderUsd: number }) {
  const [copied, setCopied] = useState(false)
  const [sub, setSub] = useState('')
  const cleanSub = /^[A-Za-z0-9_-]{1,32}$/.test(sub) ? sub : ''
  const link = `${baseUrl}/r/${code}${cleanSub ? `?sub=${cleanSub}` : ''}`

  async function copy() {
    if (await copyText(link)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      toast.error('Couldn’t access the clipboard — select the link and copy it manually.')
    }
  }

  return (
    <div className="bg-white border border-border rounded-xl p-5">
      <div className="text-sm font-medium text-ink mb-1">Your referral link</div>
      <div className="text-xs text-muted mb-3">
        {suspended
          ? 'Your affiliate access is suspended, so people who sign up through this link aren’t earning you commission or bandwidth right now.'
          : isAffiliate
          ? 'Share it — you earn commission on every order from people who sign up through it.'
          : `Share it — when someone you refer makes their first purchase of $${minOrderUsd}+, you both get ${bonusGb} GB free.`}
      </div>
      <div className="flex items-center gap-2">
        <input readOnly value={link} aria-label="Your referral link"
          className="flex-1 min-w-0 text-xs font-mono text-ink bg-surface border border-border rounded-lg px-3 py-2 truncate"
          onFocus={(e) => e.target.select()} />
        <button onClick={copy}
          className="text-xs font-mono px-3 py-2 rounded-lg border border-accent2 bg-accent2 text-white hover:opacity-90 transition-all flex-shrink-0">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {isAffiliate && (
        <div className="mt-3 flex items-center gap-2">
          <label className="text-[10px] font-mono text-muted uppercase tracking-wider flex-shrink-0">Campaign tag</label>
          <input value={sub} maxLength={32} onChange={e => setSub(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
            placeholder="e.g. youtube-june (optional)"
            className="flex-1 text-xs font-mono bg-surface border border-border rounded-lg px-3 py-1.5 focus:outline-none focus:border-accent" />
        </div>
      )}
      {isAffiliate && <div className="text-[10px] text-muted mt-1.5">Tag links per channel to see which one converts — it shows against each signup below.</div>}
    </div>
  )
}
