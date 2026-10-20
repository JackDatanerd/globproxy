import { NextResponse } from 'next/server'
import { authorizeAdmin } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { toCsv, csvResponse } from '@/lib/csv'
import { fetchAllRows } from '@/lib/dbPaging'
import { parseAuditFilters, resolveWhoIds, applyAuditFilters } from '@/lib/adminAuditFilters'

const clean = (v: string | undefined) => (v ?? '').replace(/[,()%*\\"']/g, ' ').trim().slice(0, 80)

// Same filters as the audit-log page (?q action, ?who email, ?user id,
// ?from / ?to dates). The export itself is audited — it's the whole trail.
export async function GET(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response

    const url = new URL(req.url)
    const f = parseAuditFilters(k => url.searchParams.get(k) ?? undefined, clean)
    const whoIds = await resolveWhoIds(auth.supabase, f.who)

    const { rows, error } = await fetchAllRows<any>((from, to) =>
      applyAuditFilters(
        auth.supabase.from('admin_audit_log')
          .select('id, action, target_ref, details, created_at, admin:admin_id(email), target:target_user_id(email)'),
        f, whoIds
      ).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to)
    )
    if (error) return NextResponse.json({ error: 'Export failed' }, { status: 500 })

    await logAdminAction(auth.supabase, { adminId: auth.adminId, action: 'audit_log_exported', details: { rows: rows.length, ...f } })

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
