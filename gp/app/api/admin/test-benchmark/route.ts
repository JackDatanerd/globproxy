import { authorizeAdmin } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { runConfiguredBenchmark } from '@/lib/networkProbe'
import { NextResponse } from 'next/server'

// The admin-authenticated equivalent of manually curling
// /api/cron/benchmark with the cron secret — same underlying
// runConfiguredBenchmark, just reachable from a button in the dashboard
// instead of a terminal. This is the "run it once and watch it work
// before trusting an unattended schedule" step. It spends real bandwidth and
// writes a row the public status page reads, so it is audited.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response

  try {
    const result = await runConfiguredBenchmark(auth.supabase)
    await logAdminAction(auth.supabase, {
      adminId: auth.adminId,
      action: 'benchmark.test_run',
      details: result && typeof result === 'object' ? (result as Record<string, unknown>) : {},
    })
    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
