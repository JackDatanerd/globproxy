import type { Metadata } from 'next'
import Navbar from '@/components/Navbar'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Network Status — GlobProxy',
  description: 'Live success-rate and latency benchmarks for the GlobProxy residential proxy pool.',
  alternates: { canonical: '/status' },
}

export const revalidate = 300 // 5 min — this is a status page, not a live dashboard

type Benchmark = {
  target_label: string
  success_rate: number
  avg_latency_ms: number | null
  sample_size: number
  measured_at: string
  notes: string | null
}

export default async function StatusPage() {
  const supabase = await createClient()
  const { data: rows } = await supabase
    .from('network_benchmarks')
    .select('target_label, success_rate, avg_latency_ms, sample_size, measured_at, notes')
    .order('measured_at', { ascending: false })
    .limit(200)

  // Latest row per target — the table accumulates history, this page
  // only shows the current picture.
  const latestByTarget = new Map<string, Benchmark>()
  for (const row of (rows ?? []) as Benchmark[]) {
    if (!latestByTarget.has(row.target_label)) latestByTarget.set(row.target_label, row)
  }
  const latest = [...latestByTarget.values()]

  return (
    <>
      <Navbar />
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-12">
          <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">
            Network status
          </div>
          <h1 className="font-display text-4xl lg:text-5xl font-black tracking-tight text-ink mb-3">
            Measured, not claimed.
          </h1>
          <p className="text-ink2 font-light leading-relaxed max-w-xl">
            We test our own pool the same way you would, and publish what we find — success rate and latency,
            updated regularly. No cherry-picking: whatever the last run shows is what's below.
          </p>
        </div>

        {latest.length > 0 ? (
          <div className="flex flex-col gap-4">
            {latest.map((b) => (
              <div key={b.target_label} className="bg-white border border-border rounded-xl p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-display font-bold text-ink">{b.target_label}</div>
                    {b.notes && <div className="text-xs text-muted mt-1">{b.notes}</div>}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-2xl font-display font-bold text-accent">{Number(b.success_rate).toFixed(1)}%</div>
                    <div className="text-[10px] font-mono text-muted uppercase tracking-wider">success rate</div>
                  </div>
                </div>
                <div className="flex gap-6 mt-4 pt-4 border-t border-border text-xs font-mono text-muted">
                  {b.avg_latency_ms != null && <span>{Math.round(b.avg_latency_ms)}ms avg latency</span>}
                  <span>{b.sample_size.toLocaleString()} requests sampled</span>
                  <span>
                    Updated {new Date(b.measured_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white border border-border rounded-xl p-10 text-center text-muted text-sm font-light">
            No benchmark data published yet — check back soon.
          </div>
        )}
      </div>
    </>
  )
}
