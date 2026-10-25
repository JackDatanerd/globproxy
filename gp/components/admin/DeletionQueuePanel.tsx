import Link from 'next/link'

export type DeletionQueueRow = {
  id: string
  email: string | null
  is_deleted: boolean
  deletion_scheduled_at: string | null
  deletion_attempts: number | null
  deletion_last_error: string | null
  deletion_cleanup_pending: boolean | null
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB') : '—')

// Server component for /admin/settings: every account whose deletion is scheduled, failing or
// finished with leftovers. Without it the only sign was an e-mail.
export default function DeletionQueuePanel({ rows, error }: { rows: DeletionQueueRow[]; error?: boolean }) {
  return (
    <div className="bg-white border border-border rounded-xl p-6 mt-5">
      <h2 className="font-display font-bold text-base text-ink mb-1">Account deletions</h2>
      <p className="text-xs text-muted font-light mb-4">
        Deletions customers scheduled (7-day cool-off), ones that keep failing, and finished ones with cleanup still to do. The hourly <span className="font-mono">deletions</span> task works through them.
      </p>
      {error ? (
        <p className="text-sm text-red-600">Couldn&apos;t load the deletion queue.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing scheduled, failing or waiting for cleanup.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-mono text-muted">
                <th className="py-1 pr-4">Account</th>
                <th className="py-1 pr-4">State</th>
                <th className="py-1 pr-4">Runs / ran</th>
                <th className="py-1">Problem</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const failing = (r.deletion_attempts ?? 0) > 0
                return (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="py-2 pr-4 font-mono text-xs"><Link href={`/admin/users/${r.id}`} className="hover:text-accent">{r.is_deleted ? r.id.slice(0, 8) : (r.email ?? r.id.slice(0, 8))}</Link></td>
                    <td className="py-2 pr-4">{r.is_deleted ? 'Deleted — cleanup pending' : 'Scheduled'}</td>
                    <td className="py-2 pr-4">{r.is_deleted ? '—' : fmt(r.deletion_scheduled_at)}</td>
                    <td className={`py-2 text-xs break-words max-w-xs ${failing ? 'text-red-600' : 'text-muted'}`}>
                      {failing ? `${r.deletion_attempts} failed attempt${r.deletion_attempts === 1 ? '' : 's'}${r.deletion_last_error ? ` — ${r.deletion_last_error}` : ''}` : ''}
                    </td>
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
