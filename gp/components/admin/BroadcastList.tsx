'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export interface BroadcastItem {
  id: string; subject: string; kind: string; status: string; created_at: string
  send_email: boolean; show_banner: boolean; banner_ends_at: string | null
  recipient_count: number; counts: Record<string, number>
}

const badge: Record<string, string> = {
  sending: 'bg-blue-50 text-blue-700 border-blue-200',
  done: 'bg-green-50 text-green-700 border-green-200',
  cancelled: 'bg-gray-100 text-gray-600 border-gray-200',
}

export default function BroadcastList({ items }: { items: BroadcastItem[] }) {
  const [busy, setBusy] = useState<string | null>(null)

  async function act(id: string, action: 'kick' | 'cancel' | 'retry', done: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(id + action)
    const { ok, data } = await adminPost('/api/admin/broadcasts', { action, id })
    setBusy(null)
    if (!ok) {
      toast.error(data.error ?? (data as any).result?.error ?? 'Failed', { duration: 9000 })
      // A run that partly worked still changed the counts.
      if (action === 'kick') setTimeout(() => window.location.reload(), 4000)
      return
    }
    const r = (data as any).result
    toast.success(action === 'kick' && r ? `Sent ${r.sent}${r.failed ? `, ${r.failed} failed` : ''}` : done)
    window.location.reload()
  }

  if (!items.length) return <p className="text-sm text-muted">No broadcasts yet.</p>
  return (
    <div className="space-y-3">
      {items.map(b => {
        const c = b.counts
        const sent = c.sent ?? 0, failed = c.failed ?? 0, pending = (c.pending ?? 0) + (c.sending ?? 0), skipped = c.skipped ?? 0
        const live = b.status === 'sending'
        const bannerLive = b.show_banner && b.status !== 'cancelled' && b.banner_ends_at && Date.parse(b.banner_ends_at) > Date.now()
        return (
          <div key={b.id} className="bg-white border border-border rounded-xl p-5">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-ink break-words">{b.subject}</div>
                <div className="text-[11px] font-mono text-muted mt-0.5">
                  {new Date(b.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC · {b.kind === 'service' ? 'service notice' : 'product news'} · {b.recipient_count} accounts
                  {b.send_email ? ' · e-mail' : ''}{b.show_banner ? ` · banner${bannerLive ? ' (showing)' : ' (ended)'}` : ''}
                </div>
              </div>
              <span className={`text-[10px] font-mono uppercase tracking-widest border rounded px-2 py-0.5 ${badge[b.status] ?? badge.done}`}>{b.status === 'cancelled' ? 'stopped' : b.status}</span>
            </div>
            {b.send_email && (
              <div className="mt-3 text-xs text-ink2 flex gap-4 flex-wrap">
                <span><strong>{sent}</strong> sent</span>
                {pending > 0 && <span><strong>{pending}</strong> waiting</span>}
                {failed > 0 && <span className="text-red-600"><strong>{failed}</strong> failed</span>}
                {skipped > 0 && <span className="text-muted">{skipped} skipped (opted out / no longer eligible)</span>}
              </div>
            )}
            <div className="mt-3 flex gap-2 flex-wrap">
              {live && pending > 0 && <button disabled={!!busy} onClick={() => act(b.id, 'kick', 'Sent')} className="border border-border px-3 py-1.5 rounded-lg text-xs text-ink disabled:opacity-60">Send a few batches now</button>}
              {failed > 0 && b.status !== 'cancelled' && (
                <button disabled={!!busy} onClick={() => act(b.id, 'retry', 'Failed recipients re-queued',
                  'Retry the failed recipients?\n\nAn "unconfirmed" failure means the e-mail provider never answered, so that person may already have received the message and could get it twice.')}
                  className="border border-border px-3 py-1.5 rounded-lg text-xs text-ink disabled:opacity-60">Retry {failed} failed</button>
              )}
              {b.status !== 'cancelled' && (live || bannerLive) && (
                <button disabled={!!busy} onClick={() => act(b.id, 'cancel', 'Stopped',
                  live ? 'Stop this broadcast? E-mails not yet sent will not go out, and the banner (if any) is withdrawn. E-mails already sent cannot be recalled.' : 'Withdraw the dashboard banner?')}
                  className="border border-red-200 text-red-600 px-3 py-1.5 rounded-lg text-xs disabled:opacity-60">{live ? 'Stop' : 'Withdraw banner'}</button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
