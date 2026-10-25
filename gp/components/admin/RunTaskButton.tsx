'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export default function RunTaskButton({ task }: { task: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function run() {
    if (!confirm(`Run the "${task}" task now? It does exactly what the schedule does.`)) return
    setBusy(true)
    const { ok, data } = await adminPost('/api/admin/cron-run', { task })
    setBusy(false)
    if (!ok) { toast.error((data as any).error ?? 'Could not run the task'); return }
    const d = data as any
    if (d.skipped) toast('Already running — not started a second copy.')
    else if (d.task_error) toast.error(`Ran, but it reported: ${d.task_error}`, { duration: 9000 })
    else toast.success(`"${task}" ran`)
    router.refresh()
  }
  return (
    <button onClick={run} disabled={busy}
      className="text-[11px] font-mono text-ink2 border border-border px-2 py-0.5 rounded-lg hover:border-ink2 disabled:opacity-50">
      {busy ? '…' : 'Run now'}
    </button>
  )
}
