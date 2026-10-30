'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { apiJson, toastApiError } from '@/lib/clientApi'

// "Add to this report" under one report on /dashboard/support (POST /api/support/report
// with { report_id }): the message is kept with the report, which reopens if it was resolved.
export default function SupportFollowUp({ reportId, resolved }: { reportId: string; resolved: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function send() {
    if (!message.trim()) return
    setLoading(true)
    try {
      await apiJson('POST', '/api/support/report', { report_id: reportId, message: message.trim(), page_url: '/dashboard/support' })
      toast.success(resolved ? 'Sent — the report is open again.' : 'Sent — we have added it to your report.')
      setMessage(''); setOpen(false)
      router.refresh()
    } catch (err: any) {
      toastApiError(err, 'Could not send your message')
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-3 text-xs font-mono text-accent hover:underline">
        {resolved ? 'Not fixed? Reopen with a message' : 'Add a message'}
      </button>
    )
  }
  return (
    <div className="mt-3">
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={2000} autoFocus
        placeholder="What else should we know?" className="w-full text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2 mb-2" />
      <div className="flex gap-2">
        <button onClick={send} disabled={loading || !message.trim()}
          className="text-xs font-mono px-3 py-1.5 rounded-lg border border-accent2 bg-accent2 text-white hover:opacity-90 disabled:opacity-50">{loading ? 'Sending…' : 'Send'}</button>
        <button onClick={() => { setOpen(false); setMessage('') }} disabled={loading}
          className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-muted">Cancel</button>
      </div>
    </div>
  )
}
