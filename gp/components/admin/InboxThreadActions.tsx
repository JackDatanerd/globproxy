'use client'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

type Status = 'open' | 'pending' | 'closed'

// Status / assignment buttons for one inbox conversation (api/admin/inbox/thread). Opening the
// page marks the conversation read.
export default function InboxThreadActions({
  threadId, status, assignedTo, adminId, unread,
}: { threadId: string; status: Status; assignedTo: string | null; adminId: string; unread: boolean }) {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (unread) adminPost('/api/admin/inbox/thread', { threadId, action: 'mark_read' }).catch(() => {})
  }, [threadId, unread])

  async function act(action: string, extra: Record<string, unknown> = {}, done?: string) {
    setBusy(true)
    const { ok, data } = await adminPost('/api/admin/inbox/thread', { threadId, action, ...extra })
    if (!ok) { toast.error(data.error ?? 'Action failed'); setBusy(false); return }
    toast.success(done ?? 'Saved')
    setTimeout(() => window.location.reload(), 400)
  }

  const btn = 'text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2 hover:text-ink disabled:opacity-50 transition-all'
  return (
    <div className="flex flex-wrap gap-2">
      {status === 'closed'
        ? <button className={btn} disabled={busy} onClick={() => act('reopen', {}, 'Reopened')}>Reopen</button>
        : <button className={btn} disabled={busy} onClick={() => act('close', {}, 'Closed')}>Close</button>}
      {status === 'open' && <button className={btn} disabled={busy} onClick={() => act('pending', {}, 'Marked as waiting on the customer')}>Waiting on customer</button>}
      {assignedTo === adminId
        ? <button className={btn} disabled={busy} onClick={() => act('unassign', {}, 'Unassigned')}>Unassign me</button>
        : <button className={btn} disabled={busy} onClick={() => act('assign', { assignTo: 'me' }, 'Assigned to you')}>{assignedTo ? 'Take over' : 'Assign to me'}</button>}
      <button className={btn} disabled={busy} onClick={() => act('mark_unread', {}, 'Marked unread')}>Mark unread</button>
    </div>
  )
}
