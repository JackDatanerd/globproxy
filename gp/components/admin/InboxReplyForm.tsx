'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

const MAX = 10_000

// Reply box under a conversation (api/admin/inbox/reply): goes out from support@globproxy.com.
export default function InboxReplyForm({ threadId, to }: { threadId: string; to: string }) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  async function send() {
    const text = body.trim()
    if (text.length < 2) { toast.error('Write the reply first'); return }
    if (sending) return
    setSending(true)
    const { ok, data } = await adminPost('/api/admin/inbox/reply', { threadId, body: text })
    if (!ok) {
      toast.error(data.error ?? 'Could not send the reply', { duration: 9000 })
      // 'unknown' / 'failed' are recorded on the thread — show it, keep the draft.
      if ((data as any).delivery) setTimeout(() => window.location.reload(), 3000)
      setSending(false)
      return
    }
    toast.success('Reply sent')
    setBody('')
    setTimeout(() => window.location.reload(), 500)
  }

  return (
    <div className="bg-white border border-border rounded-xl p-5">
      <label htmlFor="inbox-reply" className="text-[10px] font-mono text-muted uppercase tracking-widest">
        Reply to {to} — sent from support@globproxy.com
      </label>
      <textarea id="inbox-reply" value={body} onChange={e => setBody(e.target.value)} rows={7} maxLength={MAX}
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send() }}
        placeholder="Write your reply. Your signature and the quoted message are added automatically."
        className="mt-2 w-full border border-border rounded-xl px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent" />
      <div className="flex items-center justify-between mt-2">
        <span className="text-[11px] font-mono text-muted">{body.length.toLocaleString()} / {MAX.toLocaleString()} · Ctrl/⌘+Enter to send</span>
        <button onClick={send} disabled={sending || body.trim().length < 2}
          className="bg-accent text-white px-5 py-2 rounded-xl text-sm font-medium disabled:opacity-60">
          {sending ? 'Sending…' : 'Send reply'}
        </button>
      </div>
    </div>
  )
}
