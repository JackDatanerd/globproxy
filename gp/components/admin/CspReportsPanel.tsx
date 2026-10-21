export type CspRow = {
  directive: string
  blocked: string
  document: string
  hits: number
  last_seen_at: string
}

// Server component: what Content-Security-Policy-Report-Only has flagged,
// aggregated by /api/csp-report (migration 0055). The policy in next.config.ts is
// promoted to enforcing by renaming its header once this list has stayed empty
// (or only holds entries you have added to the allow-list) for a week or two of
// real traffic.
export default function CspReportsPanel({ rows }: { rows: CspRow[] }) {
  return (
    <div className="bg-white border border-border rounded-xl p-6 mt-5">
      <h2 className="font-display font-bold text-base text-ink mb-1">Content-Security-Policy reports</h2>
      <p className="text-xs text-muted font-light mb-4">
        Things browsers flagged under the report-only policy, most-hit first (last 30 days, query strings removed). Browser extensions cause some noise —
        entries with a <span className="font-mono">blocked</span> value like <span className="font-mono">chrome-extension</span> can be ignored.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No violations recorded.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-mono text-muted">
                <th className="py-1 pr-4">Hits</th>
                <th className="py-1 pr-4">Directive</th>
                <th className="py-1 pr-4">Blocked</th>
                <th className="py-1">Page</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border align-top">
                  <td className="py-2 pr-4 font-mono">{r.hits}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.directive}</td>
                  <td className="py-2 pr-4 font-mono text-xs break-all max-w-xs">{r.blocked || '(inline)'}</td>
                  <td className="py-2 font-mono text-xs break-all max-w-xs">{r.document}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
