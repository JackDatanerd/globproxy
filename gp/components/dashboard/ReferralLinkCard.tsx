'use client'
import { useState } from 'react'

export default function ReferralLinkCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const link = typeof window !== 'undefined' ? `${window.location.origin}/auth/signup?ref=${code}` : `/auth/signup?ref=${code}`

  function copy() {
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="bg-white border border-border rounded-xl p-5">
      <div className="text-sm font-medium text-ink mb-1">Your referral link</div>
      <div className="text-xs text-muted mb-3">
        Share it — when someone you refer makes their first purchase, you both get 1 GB free.
      </div>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={link}
          className="flex-1 text-xs font-mono text-ink bg-surface border border-border rounded-lg px-3 py-2 truncate"
          onFocus={(e) => e.target.select()}
        />
        <button
          onClick={copy}
          className="text-xs font-mono px-3 py-2 rounded-lg border border-accent2 bg-accent2 text-white hover:opacity-90 transition-all flex-shrink-0"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
