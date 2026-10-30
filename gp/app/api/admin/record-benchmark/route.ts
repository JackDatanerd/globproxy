import { authorizeAdmin, readJson, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { leaksSupplier } from '@/lib/supplierGuard'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response

  const body = await readJson<{ targetLabel?: unknown; successRate?: unknown; avgLatencyMs?: unknown; sampleSize?: unknown; notes?: unknown }>(req)
  if (!body) return badRequest('Invalid request body')
  const { targetLabel, successRate, avgLatencyMs, sampleSize, notes } = body

  if (typeof targetLabel !== 'string' || !targetLabel.trim() || targetLabel.length > 100 ||
      typeof successRate !== 'number' || !Number.isFinite(successRate) || successRate < 0 || successRate > 100) {
    return badRequest('targetLabel (max 100 chars) and a successRate (0-100) are required')
  }
  if (avgLatencyMs != null && (typeof avgLatencyMs !== 'number' || !Number.isFinite(avgLatencyMs) || avgLatencyMs < 0)) {
    return badRequest('avgLatencyMs must be a non-negative number')
  }
  if (sampleSize != null && (typeof sampleSize !== 'number' || !Number.isInteger(sampleSize) || sampleSize < 0 || sampleSize > 1_000_000)) {
    return badRequest('sampleSize must be a whole number')
  }
  if (notes != null && (typeof notes !== 'string' || notes.length > 500)) {
    return badRequest('notes must be text of at most 500 characters')
  }

  // network_benchmarks is world-readable (RLS `using (true)`) and rendered verbatim on the public
  // /status page, so free text typed here reaches anonymous visitors. It must never name the supplier.
  if (leaksSupplier(targetLabel) || leaksSupplier(notes)) {
    return badRequest('The label and notes are published on the public status page and must not name our upstream provider')
  }

  const { error } = await auth.supabase.from('network_benchmarks').insert({
    target_label: targetLabel.trim(),
    success_rate: successRate,
    avg_latency_ms: avgLatencyMs ?? null,
    sample_size: sampleSize ?? 0,
    notes: notes ?? null,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // These rows feed the public status page, so a hand-entered one is audited.
  await logAdminAction(auth.supabase, {
    adminId: auth.adminId,
    action: 'benchmark.record_manual',
    details: { target_label: targetLabel.trim(), success_rate: successRate, avg_latency_ms: avgLatencyMs ?? null, sample_size: sampleSize ?? 0 },
  })
  return NextResponse.json({ success: true })
}
