'use client'
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { formatGb, formatGbPrecise } from '@/lib/format'
import { apiFetch } from '@/lib/clientApi'
import ExportButton from '@/components/dashboard/ExportButton'

interface SeriesPoint { date: string; gb: number }
interface BreakdownRow {
  label: string
  host: string
  country: string
  gb: number
  requests: number
  successRate: number
}
interface HistoryResponse {
  range_days: number
  series: SeriesPoint[]
  breakdown: BreakdownRow[]
  breakdown_row_count: number
  credentials_truncated: boolean
  partial_data: boolean
}

const RANGES = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
] as const

// Dependency-free SVG line chart. No charting library is in package.json
// yet, and pulling one in for a single chart on one page isn't worth the
// bundle weight on a Cloudflare Workers deployment — this covers exactly
// what the usage page needs (a daily GB trend line) without one.
// Daily values are routinely well under 0.01 GB, which formatGb flattened to
// "0.00" on every axis label. Switch to MB when the whole chart is sub-GB.
function axisLabel(gb: number, maxGb: number): string {
  if (maxGb < 1) return `${Math.round(gb * 1024)} MB`
  return formatGb(gb)
}

function TrendChart({ points }: { points: SeriesPoint[] }) {
  const width = 640
  const height = 180
  const padL = 40
  const padR = 12
  const padT = 12
  const padB = 24

  if (points.length === 0 || points.every(p => p.gb === 0)) {
    return (
      <div className="h-[180px] flex items-center justify-center text-xs font-mono text-muted">
        No usage recorded in this range yet.
      </div>
    )
  }

  const maxGb = Math.max(...points.map(p => p.gb), 0.01)
  const innerW = width - padL - padR
  const innerH = height - padT - padB

  const x = (i: number) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
  const y = (gb: number) => padT + innerH - (gb / maxGb) * innerH

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.gb).toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L ${x(points.length - 1).toFixed(1)} ${(padT + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`

  // Show at most ~6 x-axis labels regardless of range, so 30-day mode
  // doesn't cram 30 overlapping date labels along the bottom.
  const labelStep = Math.max(1, Math.ceil(points.length / 6))

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[180px]" role="img" aria-label="Daily bandwidth usage">
      {[0, 0.5, 1].map(f => (
        <line
          key={f}
          x1={padL} x2={width - padR}
          y1={padT + innerH * (1 - f)} y2={padT + innerH * (1 - f)}
          stroke="currentColor" className="text-border" strokeWidth={1}
        />
      ))}
      {[0, 0.5, 1].map(f => (
        <text
          key={f}
          x={padL - 6} y={padT + innerH * (1 - f) + 3}
          textAnchor="end" fontSize={9} fontFamily="monospace" className="fill-muted"
        >
          {axisLabel(maxGb * f, maxGb)}
        </text>
      ))}
      <path d={areaPath} className="fill-accent" fillOpacity={0.08} stroke="none" />
      <path d={linePath} className="stroke-accent" fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <circle key={p.date} cx={x(i)} cy={y(p.gb)} r={points.length > 15 ? 1.8 : 2.5} className="fill-accent">
          <title>{`${p.date}: ${p.gb < 1 ? `${(p.gb * 1024).toFixed(1)} MB` : `${p.gb.toFixed(3)} GB`}`}</title>
        </circle>
      ))}
      {points.map((p, i) =>
        i % labelStep === 0 ? (
          <text
            key={p.date}
            x={x(i)} y={height - 6}
            textAnchor="middle" fontSize={9} fontFamily="monospace" className="fill-muted"
          >
            {p.date.slice(5)}
          </text>
        ) : null
      )}
    </svg>
  )
}

export default function UsageHistoryChart({ sessions = [] }: { sessions?: { id: string; label: string }[] }) {
  const [range, setRange] = useState<7 | 30 | 90>(7)
  // '' = all sessions (the account-wide view); otherwise one session's own history.
  const [sessionId, setSessionId] = useState('')
  const scope = sessionId ? `&credential_id=${encodeURIComponent(sessionId)}` : ""
  const [data, setData] = useState<HistoryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // Drop the previous range's numbers up front: after a failed range change
    // the old table used to stay on screen under the new range's error.
    setData(null)
    apiFetch<HistoryResponse>(`/api/dashboard/usage/history?range=${range}${scope}`)
      .then(json => { if (!cancelled) setData(json) })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range, scope])

  return (
    <div className="bg-white border border-border rounded-xl overflow-hidden mb-6">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-display font-bold text-base text-ink">Usage over time</h2>
          <p className="text-[11px] text-muted mt-0.5">
            {sessionId ? 'Daily bandwidth for the selected session' : 'Daily bandwidth across all your sessions'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {sessions.length > 1 && (
            <select
              value={sessionId}
              onChange={e => setSessionId(e.target.value)}
              aria-label="Session to show"
              className="text-[11px] font-mono px-2.5 py-1.5 rounded-lg border border-border bg-white text-ink max-w-[180px]"
            >
              <option value="">All sessions</option>
              {sessions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          )}
          <div className="flex bg-surface rounded-lg p-0.5">
            {RANGES.map(r => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={clsx(
                  'text-[11px] font-mono px-3 py-1.5 rounded-md transition-colors',
                  range === r.value ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink'
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <ExportButton
            url={`/api/dashboard/usage/history?range=${range}${scope}&format=csv&dataset=series`}
            filename="globproxy-usage.csv"
            className="text-[11px] font-mono px-3 py-1.5 rounded-lg border border-border text-muted hover:text-accent hover:border-accent transition-colors"
          >
            Export CSV
          </ExportButton>
        </div>
      </div>

      <div className="px-6 py-5">
        {error ? (
          <div className="text-xs text-red-500 font-mono py-8 text-center">{error}</div>
        ) : loading && !data ? (
          <div className="h-[180px] flex items-center justify-center text-xs font-mono text-muted">Loading…</div>
        ) : (
          <>
            <div className={loading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
              <TrendChart points={data?.series ?? []} />
            </div>
            {data?.partial_data && (
              <p className="text-[10.5px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mt-3 font-mono">
                Some sessions couldn't be reached for this range — the chart above reflects the rest.
              </p>
            )}
            {data?.credentials_truncated && (
              <p className="text-[10.5px] text-muted mt-2 font-mono">
                Showing your highest-usage sessions only — export the CSV for the full breakdown.
              </p>
            )}
          </>
        )}
      </div>

      {/* Host / country breakdown */}
      <div className="border-t border-border">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="font-display font-bold text-sm text-ink">Top hosts &amp; countries</h3>
            <p className="text-[11px] text-muted mt-0.5">
              Where your bandwidth went, by target host and country
              {data && data.breakdown_row_count > data.breakdown.length && (
                <> — showing top {data.breakdown.length} of {data.breakdown_row_count}</>
              )}
            </p>
          </div>
          <ExportButton
            url={`/api/dashboard/usage/history?range=${range}${scope}&format=csv&dataset=breakdown`}
            filename="globproxy-usage-breakdown.csv"
            className="text-[11px] font-mono px-3 py-1.5 rounded-lg border border-border text-muted hover:text-accent hover:border-accent transition-colors flex-shrink-0"
          >
            Export full CSV
          </ExportButton>
        </div>

        {!loading && data && data.breakdown.length === 0 ? (
          <div className="text-center py-10">
            <p className="text-muted text-sm font-light">No host/country activity recorded in this range yet.</p>
          </div>
        ) : !data ? (
          <div className="text-center py-10 text-xs font-mono text-muted">{loading ? 'Loading…' : ''}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] font-mono text-muted uppercase tracking-widest bg-surface">
                  <th className="text-left px-6 py-2.5 font-medium">Session</th>
                  <th className="text-left px-3 py-2.5 font-medium">Host</th>
                  <th className="text-left px-3 py-2.5 font-medium">Country</th>
                  <th className="text-right px-3 py-2.5 font-medium">Used</th>
                  <th className="text-right px-3 py-2.5 font-medium">Requests</th>
                  <th className="text-right px-6 py-2.5 font-medium">Success</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(data?.breakdown ?? []).map((row, i) => (
                  <tr key={`${row.label}-${row.host}-${row.country}-${i}`}>
                    <td className="px-6 py-2.5 text-ink truncate max-w-[140px]">{row.label}</td>
                    <td className="px-3 py-2.5 font-mono text-ink truncate max-w-[180px]">{row.host}</td>
                    <td className="px-3 py-2.5">
                      <span className="text-[10.5px] font-mono bg-accent-light text-accent px-2 py-0.5 rounded">{row.country}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-ink">{formatGbPrecise(row.gb)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-muted">{row.requests.toLocaleString()}</td>
                    <td className="px-6 py-2.5 text-right font-mono text-muted">{row.successRate.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
