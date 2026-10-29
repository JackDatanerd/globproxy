import { NextResponse } from 'next/server'
import { authorizeAdmin } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { toCsv, csvResponse } from '@/lib/csv'
import { parseAuditFilters, searchAuditLog } from '@/lib/adminAuditFilters'

const clean = (v: string | undefined) => (v ?? '').replace(/[,()%*\\"']/g, ' ').trim().slice(0, 80)

// Same filters as the audit-log page (?q action, ?who email, ?user id,
// ?from / ?to dates). The export itself is audited — it's the whole trail.
export async function GET(req: Request) {
  try {
    const auth = await authorizeAdmin(req, { stepUp: true })
    if (!auth.ok) return auth.response

    const url = new URL(req.url)
    const f = parseAuditFilters(k => url.searchParams.get(k) ?? undefined, clean)
    // Page through the same search function the screen uses, so both always agree.
    const rows: any[] = []
    let error: string | null = null
    for (let page = 0; page < 200; page++) {
      const r = await searchAuditLog(auth.supabase, f, { limit: 1000, offset: page * 1000 })
      if (r.error) { error = r.error; break }
      rows.push(...r.rows)
      if (r.rows.length < 1000) break
    }
    if (error) return NextResponse.json({ error: 'Export failed' }, { status: 500 })

    await logAdminAction(auth.supabase, { adminId: auth.adminId, action: 'audit_log_exported', details: { rows: rows.length, filters: Object.entries(f).filter(([, v]) => v).map(([k]) => k) } })

    const csv = toCsv(rows as any[], [
      { header: 'When (UTC)', value: r => r.created_at },
      { header: 'Admin', value: r => r.admin?.email ?? 'system' },
      { header: 'Action', value: r => r.action },
      { header: 'Target user', value: r => r.target?.email ?? '' },
      { header: 'Target ref', value: r => r.target_ref ?? '' },
      { header: 'Details', value: r => (r.details && Object.keys(r.details).length ? JSON.stringify(r.details) : '') },
    ])
    return csvResponse(csv, 'globproxy-audit-log')
  } catch (err: any) {
    console.error('[admin/audit-csv] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
