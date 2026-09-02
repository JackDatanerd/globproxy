'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

// Sits in DashTopbar next to Sign out. Backend: app/api/support/report/route.ts
// (writes to support_reports, migration 0036) + an immediate admin email —
// doesn't require the @globproxy inbox to be active since it only sends.
export default function ReportIssueButton() {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit() {
    if (!message.trim()) return
    setLoading(true)
    const { data: { session } } = await createClient().auth.getSession()
    const res = await fetch('/api/support/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ message, page_url: window.location.pathname }),
    })
    const data = await res.json().catch(() => ({}))
    setLoading(false)
    if (!res.ok || data.error) {
      toast.error(data.error ?? 'Failed to send report')
      return
    }
    toast.success('Thanks — we got it and will follow up by email.')
    setMessage('')
    setOpen(false)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-muted hover:text-ink border border-border px-3 py-1.5 rounded-lg transition-colors"
      >
        Report an issue
      </button>
      {open && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white border border-border rounded-xl p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium text-ink mb-1">Report an issue</div>
            <div className="text-xs text-muted mb-3">Tell us what went wrong — a payment, a proxy, anything. We'll get an email right away.</div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
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
