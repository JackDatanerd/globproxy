import { CRON_MAX_AGE_SECONDS } from '@/lib/cronHealth'
import RunTaskButton from '@/components/admin/RunTaskButton'

export type CronRunRow = {
  task: string
  last_run_at: string
  last_ok_at: string | null
  last_error: string | null
  last_error_at: string | null
  consecutive_failures: number
}

function ago(iso: string | null): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

// Server component: one row per scheduled task, from the heartbeat the cron route
// records on every run (migration 0055). Red = failing now, amber = overdue.
export default function CronHealthPanel({ rows }: { rows: CronRunRow[] }) {
  const sorted = [...rows].sort((a, b) => a.task.localeCompare(b.task))
  return (
    <div className="bg-white border border-border rounded-xl p-6 mt-5">
      <h2 className="font-display font-bold text-base text-ink mb-1">Scheduled tasks</h2>
      <p className="text-xs text-muted font-light mb-4">
        Last run of every Cloudflare cron task. Three failed runs in a row, or a task that stops running, emails the admin once per incident.
      </p>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted">No runs recorded yet — the table fills in as the cron triggers fire.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-mono text-muted">
                <th className="py-1 pr-4">Task</th>
                <th className="py-1 pr-4">Last run</th>
                <th className="py-1 pr-4">Last success</th>
                <th className="py-1 pr-4">Failing runs</th>
                <th className="py-1 pr-4">Last error</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const maxAge = CRON_MAX_AGE_SECONDS[r.task]
                const overdue = !!maxAge && Date.now() - new Date(r.last_run_at).getTime() > maxAge * 1000
                const failing = r.consecutive_failures > 0
                return (
                  <tr key={r.task} className="border-t border-border align-top">
                    <td className="py-2 pr-4 font-mono">{r.task}</td>
                    <td className={`py-2 pr-4 ${overdue ? 'text-amber-600 font-medium' : ''}`}>{ago(r.last_run_at)}{overdue ? ' (overdue)' : ''}</td>
                    <td className="py-2 pr-4">{ago(r.last_ok_at)}</td>
                    <td className={`py-2 pr-4 ${failing ? 'text-red-600 font-medium' : ''}`}>{r.consecutive_failures}</td>
                    <td className="py-2 pr-4 text-xs text-muted break-words max-w-xs">{failing ? r.last_error : ''}</td>
                    <td className="py-2">{r.task === 'canary' ? null : <RunTaskButton task={r.task} />}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
