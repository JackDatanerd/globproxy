'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export type DeletionState = {
  is_deleted: boolean
  deletion_requested_at: string | null
  deletion_scheduled_at: string | null
  deletion_attempts: number | null
  deletion_last_error: string | null
  deletion_last_attempt_at: string | null
  deletion_cleanup_pending: boolean | null
  deletion_cleanup_notes: string | null
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB') : '—')

// Shown on the admin user page only when something about the account's deletion is going on:
// a scheduled cool-off, failing attempts, or leftovers of a finished deletion.
export default function AdminDeletionPanel({ userId, state }: { userId: string; state: DeletionState }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const scheduled = !state.is_deleted && !!state.deletion_scheduled_at
  const leftovers = state.is_deleted && !!state.deletion_cleanup_pending
  if (!scheduled && !leftovers) return null

  async function act(action: 'cancel_scheduled' | 'retry_cleanup') {
    if (action === 'cancel_scheduled' && !confirm('Withdraw the scheduled deletion? The account stays as it is. The owner is not e-mailed.')) return
    setBusy(true)
    const { ok, data } = await adminPost('/api/admin/account-deletion', { userId, action })
    setBusy(false)
    if (!ok) { toast.error((data as any).error ?? 'Action failed'); return }
    if (action === 'retry_cleanup' && (data as any).cleared === false) toast.error('Some cleanup steps still fail — see the notes below.', { duration: 8000 })
    else toast.success(action === 'cancel_scheduled' ? 'Scheduled deletion withdrawn' : 'Cleanup finished')
    router.refresh()
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 mb-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">{scheduled ? 'Account deletion scheduled' : 'Deleted — cleanup still has leftovers'}</div>
          {scheduled ? (
            <div className="text-xs text-muted font-mono mt-1 space-y-0.5">
              <div>Requested {fmt(state.deletion_requested_at)} · runs {fmt(state.deletion_scheduled_at)}</div>
              {(state.deletion_attempts ?? 0) > 0 && (
                <div className="text-red-700">Attempt {state.deletion_attempts} failed {fmt(state.deletion_last_attempt_at)}: {state.deletion_last_error ?? 'unknown'}</div>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted font-mono mt-1 space-y-0.5">
              <div>Retried {state.deletion_attempts ?? 0}× · last try {fmt(state.deletion_last_attempt_at)}</div>
              {state.deletion_cleanup_notes && <pre className="whitespace-pre-wrap break-words text-red-700">{state.deletion_cleanup_notes}</pre>}
            </div>
          )}
        </div>
        {scheduled ? (
          <button onClick={() => act('cancel_scheduled')} disabled={busy}
            className="text-xs font-mono text-ink border border-border bg-white px-3 py-1.5 rounded-lg hover:border-ink2 disabled:opacity-50">
            {busy ? '…' : 'Withdraw deletion'}
          </button>
        ) : (
          <button onClick={() => act('retry_cleanup')} disabled={busy}
            className="text-xs font-mono text-ink border border-border bg-white px-3 py-1.5 rounded-lg hover:border-ink2 disabled:opacity-50">
            {busy ? '…' : 'Retry cleanup now'}
          </button>
        )}
      </div>
    </div>
  )
}
