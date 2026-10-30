'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { apiJson, toastApiError } from '@/lib/clientApi'

// Sits in DashTopbar next to Sign out. Backend: app/api/support/report/route.ts
// (writes to support_reports, migration 0036) and files the report in the shared
// support@globproxy.com inbox, which alerts the operator; falls back to a direct
// e-mail if the inbox can't take it.
export default function ReportIssueButton({ variant = 'topbar', context }: { variant?: 'topbar' | 'primary' | 'link'; context?: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  // The server caps the whole message (context prefix included) at 5000 characters, so the prefix
  // is bounded and the textarea limit leaves room for it.
  const prefix = context ? `[${context.slice(0, 200)}]\n` : ''
  const maxLen = 5000 - prefix.length

  // Escape closes the dialog (it had no keyboard exit at all).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !loading) setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, loading])

  async function submit() {
    if (!message.trim()) return
    setLoading(true)
    try {
      await apiJson('POST', '/api/support/report', { message: prefix + message.trim().slice(0, maxLen), page_url: window.location.pathname })
      toast.success('Thanks — we got it and will follow up by email.')
      setMessage('')
      setOpen(false)
      router.refresh() // the Support page lists what was just sent
    } catch (err: any) {
      // A network failure used to throw out of submit() and leave the button
      // stuck on "Sending…" with the report unsent.
      toastApiError(err, 'Failed to send report')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={variant === 'primary'
          ? 'bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity'
          : variant === 'link'
          ? 'text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-muted hover:border-accent hover:text-accent transition-all mr-2'
          : 'text-xs text-muted hover:text-ink border border-border px-2.5 sm:px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap'}
      >
        {variant === 'primary'
          ? 'Report an issue'
          : variant === 'link' ? 'Report a problem'
          : <><span className="sm:hidden">Report</span><span className="hidden sm:inline">Report an issue</span></>}
      </button>
      {open && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" 
          // A stray click on the backdrop used to discard a half-written report.
          onClick={() => { if (!message.trim() && !loading) setOpen(false) }}>
          <div role="dialog" aria-modal="true" aria-label="Report an issue" className="bg-white border border-border rounded-xl p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium text-ink mb-1">Report an issue</div>
            <div className="text-xs text-muted mb-3">Tell us what went wrong — a payment, a proxy, anything. We'll get an email right away.</div>
            {context && <div className="text-[11px] font-mono text-muted bg-surface border border-border rounded-lg px-2.5 py-1.5 mb-3 break-all">About: {context}</div>}
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              maxLength={maxLen}
              autoFocus
              placeholder="What happened?"
              className="w-full text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2 mb-3"
            />
            <div className="flex gap-2">
              <button onClick={submit} disabled={loading || !message.trim()}
                className="text-xs font-mono px-4 py-2 rounded-lg border border-accent2 bg-accent2 text-white hover:opacity-90 transition-all disabled:opacity-50">
                {loading ? 'Sending…' : 'Send report'}
              </button>
              <button onClick={() => setOpen(false)} className="text-xs font-mono px-4 py-2 rounded-lg border border-border text-muted">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
