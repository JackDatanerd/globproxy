import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'
import { createClient } from '@/lib/supabase/server'
import { leaksSupplier } from '@/lib/supplierGuard'
import { pageMetadata } from '@/lib/seo'

export const metadata = pageMetadata({
  title: 'Network Status — GlobProxy',
  description: 'Success-rate and latency benchmarks for the GlobProxy residential proxy pool, with the time of each measurement.',
  path: '/status',
})

// No `export const revalidate` here on purpose: this deployment runs OpenNext's
// "dummy" incremental cache, so it would do nothing — and the page reads
// cookies via the Supabase client, which makes it per-request anyway. The
// 5-minute caching for anonymous visitors is done at the edge instead, in
// custom-worker.ts (EDGE_CACHEABLE_PATHS).

type Benchmark = {
  target_label: string
  success_rate: number
  avg_latency_ms: number | null
  sample_size: number
  measured_at: string
  notes: string | null
}

// The benchmark cron runs every 6 hours. It skips silently when its probe credential is missing,
// inactive, not HTTP or out of GB, so a healthy page can go stale without any error. Older than this
// and the page says so instead of presenting old numbers as the current picture.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

function ago(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} minutes ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  return `${days} days ago`
}

function utcStamp(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  }) + ' UTC'
}

export default async function StatusPage() {
  const supabase = await createClient()
  const { data: rows } = await supabase
    .from('network_benchmarks')
    .select('target_label, success_rate, avg_latency_ms, sample_size, measured_at, notes')
    .order('measured_at', { ascending: false })
    .limit(200)

  // Latest row per target — the table accumulates history, this page
  // only shows the current picture. Rows are public, so a label that names
  // the upstream supplier is never rendered, and neither is such a note.
  const latestByTarget = new Map<string, Benchmark>()
  for (const row of (rows ?? []) as Benchmark[]) {
    if (leaksSupplier(row.target_label)) continue
    if (!latestByTarget.has(row.target_label)) {
      latestByTarget.set(row.target_label, { ...row, notes: leaksSupplier(row.notes) ? null : row.notes })
    }
  }
  const latest = [...latestByTarget.values()]

  const now = Date.now()
  const newestMs = latest.reduce((m, b) => Math.max(m, new Date(b.measured_at).getTime()), 0)
  const stale = latest.length > 0 && now - newestMs > STALE_AFTER_MS

  return (
    <>
      <Navbar />
      <main id="main" className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-12">
          <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">
            Network status
          </div>
          <h1 className="font-display text-4xl lg:text-5xl font-black tracking-tight text-ink mb-3">
            Measured, not claimed.
          </h1>
          <p className="text-ink2 font-light leading-relaxed max-w-xl">
            We test our own pool and publish what we find — success rate and latency, each with the time it was
            measured. No cherry-picking: whatever the latest run shows is what&apos;s below.
          </p>
        </div>

        {stale && (
          <div role="status" className="bg-amber-50 border border-amber-100 rounded-xl p-5 mb-6">
            <p className="text-sm text-amber-800 font-medium mb-1">These results are out of date</p>
            <p className="text-sm text-amber-700 font-light">
              The latest measurement below is from {ago(now - newestMs)}. Tests normally run every few hours, so this may not
              reflect the network right now.
            </p>
          </div>
        )}

        {latest.length > 0 ? (
          <div className="flex flex-col gap-4">
            {latest.map((b) => (
              <div key={b.target_label} className="bg-white border border-border rounded-xl p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-display font-bold text-ink">{b.target_label}</div>
                    {b.notes && <div className="text-xs text-subtle mt-1">{b.notes}</div>}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-2xl font-display font-bold text-accent">{Number(b.success_rate).toFixed(1)}%</div>
                    <div className="text-[10px] font-mono text-subtle uppercase tracking-wider">success rate</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-1 mt-4 pt-4 border-t border-border text-xs font-mono text-subtle">
                  {b.avg_latency_ms != null && <span>{Math.round(b.avg_latency_ms)}ms avg latency</span>}
                  <span>{b.sample_size.toLocaleString()} requests sampled</span>
                  <span>
                    Measured <time dateTime={b.measured_at}>{ago(now - new Date(b.measured_at).getTime())}</time> · {utcStamp(b.measured_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white border border-border rounded-xl p-10 text-center text-subtle text-sm font-light">
            No benchmark data published yet — check back soon.
          </div>
        )}

        <section className="mt-10 border-t border-border pt-8">
          <h2 className="font-display font-bold text-lg text-ink mb-2">How we measure</h2>
          <p className="text-sm text-ink2 font-light leading-relaxed">
            Every few hours a test sends a handful of requests per target through a GlobProxy session, logging in the same
            way customers do. A request counts as a success when it completes through the proxy; the exit-confirmation
            check also requires the exit IP to differ from ours. Today the test uses plain HTTP requests, so it does not
            cover HTTPS tunnelling, and with only a few requests per run each failure moves the success rate by a large
            step. Treat it as a health check, not a guarantee.
          </p>
        </section>
      </main>
      <Footer />
    </>
  )
}
