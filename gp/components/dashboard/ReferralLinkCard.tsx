'use client'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { copyText } from '@/lib/clientApi'

export default function ReferralLinkCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  // Origin is read after mount. Reading window at render produced a different
  // string on the server ("/auth/signup?...") and the client ("https://…"),
  // a hydration mismatch on the input's value.
  const [origin, setOrigin] = useState('')
  useEffect(() => { setOrigin(window.location.origin) }, [])
  const link = `${origin}/auth/signup?ref=${encodeURIComponent(code)}`

  async function copy() {
    if (await copyText(link)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      toast.error('Couldn\u2019t access the clipboard — select the link and copy it manually.')
    }
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
          aria-label="Your referral link"
          className="flex-1 min-w-0 text-xs font-mono text-ink bg-surface border border-border rounded-lg px-3 py-2 truncate"
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
