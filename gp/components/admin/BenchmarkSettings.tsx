'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

type Credential = { id: string; host: string; gb_allocated: number; gb_used: number; created_at: string }

export default function BenchmarkSettings({
  currentCredentialId,
  currentCredentialLabel,
  candidates,
}: {
  currentCredentialId: string | null
  currentCredentialLabel: string | null
  candidates: Credential[]
}) {
  const [selected, setSelected] = useState(currentCredentialId ?? candidates[0]?.id ?? '')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)

  async function save() {
    if (!selected) return
    setSaving(true)
    const { ok, data } = await adminPost('/api/admin/set-benchmark-credential', { credentialId: selected })
    setSaving(false)
    if (!ok) { toast.error(data.error ?? 'Failed to save'); return }
    toast.success('Benchmark credential saved')
    window.location.reload()
  }

  async function runTest() {
    setTesting(true)
    setTestResult(null)
    const { ok, data } = await adminPost('/api/admin/test-benchmark')
    setTesting(false)
    if (!ok) { toast.error(data.error ?? 'Test run failed'); return }
    setTestResult(data)
    if ((data as any).action === 'ran') toast.success('Test run complete — published to /status')
    else toast.error((data as any).reason ?? 'Skipped')
  }

  return (
    <div className="bg-white border border-border rounded-xl p-6 mt-5">
      <h2 className="font-display font-bold text-base text-ink mb-1">Network benchmark (/status page)</h2>
      <p className="text-xs text-muted mb-4">
        Powers the public /status page. Pick a small, dedicated proxy credential (protocol http) to run probes through — a 1-2GB allocation is plenty, these requests are tiny.
      </p>

      {currentCredentialId && (
        <div className="text-xs text-ink bg-surface border border-border rounded-lg px-3 py-2 mb-3 font-mono">
          Currently configured: {currentCredentialLabel ?? currentCredentialId}
        </div>
      )}

      {candidates.length > 0 ? (
        <div className="flex items-center gap-2 mb-4">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2 flex-1"
          >
            {candidates.map(c => (
              <option key={c.id} value={c.id}>
                {c.host} · {Number(c.gb_used).toFixed(2)}/{Number(c.gb_allocated).toFixed(2)}GB used · {new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
              </option>
            ))}
          </select>
          <button onClick={save} disabled={saving || !selected}
            className="text-xs font-mono px-4 py-2 rounded-lg border border-accent2 bg-accent2 text-white hover:opacity-90 transition-all disabled:opacity-50 flex-shrink-0">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : (
        <div className="text-xs text-muted mb-4">
          No active http-protocol proxy credentials on your account yet — buy a small one (1GB is enough) from the dashboard first, then it'll show up here.
        </div>
      )}

      <button onClick={runTest} disabled={testing || !currentCredentialId}
        className="text-xs font-mono px-4 py-2 rounded-lg border border-border text-ink hover:bg-surface transition-all disabled:opacity-50">
        {testing ? 'Running…' : 'Run test now'}
      </button>

      {testResult && (
        <div className="mt-3 text-xs font-mono bg-surface border border-border rounded-lg p-3">
          {testResult.action === 'ran' ? (
            <div className="flex flex-col gap-1">
              {testResult.targets.map((t: any) => (
                <div key={t.label} className="text-ink">
                  {t.label}: {t.successRate.toFixed(1)}% success, {t.avgLatencyMs ?? '—'}ms avg
                </div>
              ))}
            </div>
          ) : (
            <div className="text-muted">Skipped: {testResult.reason}</div>
          )}
        </div>
      )}
    </div>
  )
}
