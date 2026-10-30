import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { appUrl } from '@/lib/appUrl'
import { findReportedError } from '@/lib/cronReport'

// POST { task } — runs one scheduled task now, by calling the real /api/cron/[task] route with
// the cron secret (so it takes the same run lock, records the same heartbeat and does exactly
// what the schedule does; a run already in progress answers "skipped: already_running").
// Replaces "curl with the secret" as the only way to re-run a task after fixing its cause.
//
// Not offered: 'canary' (makes a real card charge; it has its own once-a-day rule).
const RUNNABLE = ['stock', 'usage', 'alerts', 'summary', 'cleanup', 'reconcile', 'security', 'provision', 'webhooks', 'benchmark', 'invites', 'resellers', 'deletions', 'recharge', 'broadcasts']

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ task?: unknown }>(req)
  if (!body || typeof body.task !== 'string' || !RUNNABLE.includes(body.task)) return badRequest(`task must be one of: ${RUNNABLE.join(', ')}`)
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET is not set on this deployment.' }, { status: 500 })

  let res: Response
  try {
    res = await fetch(`${appUrl()}/api/cron/${body.task}`, { method: 'POST', headers: { 'x-cron-secret': secret }, signal: AbortSignal.timeout(25_000) })
  } catch (e: any) {
    console.error('[admin/cron-run] could not reach the cron route', body.task, e)
    return NextResponse.json({ error: 'The task did not answer in time. Check the Scheduled tasks panel in a minute — it may still be running.' }, { status: 504 })
  }
  const json: any = await res.json().catch(() => ({}))
  await logAdminAction(supabase, { adminId, action: 'cron.run_now', targetRef: body.task, details: { status: res.status } })
  if (!res.ok) return NextResponse.json({ error: json?.error ?? `The task answered HTTP ${res.status}.` }, { status: 502 })
  const reported = findReportedError(json?.result)
  return NextResponse.json({ success: true, skipped: json?.result?.skipped === 'already_running', ...(reported ? { task_error: reported } : {}) })
}
