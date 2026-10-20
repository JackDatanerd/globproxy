import { authorizeAdmin, readJson, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { MAX_MARKUP_PCT } from '@/lib/fx'
import { NextResponse } from 'next/server'

// Admin controls for M-Pesa checkout (see lib/fx.ts): the on/off switch, the
// markup added to the market KES rate, the manual fallback rate (used only if
// the live feeds are down and no recent cached rate exists), and a "refresh now"
// that drops the cached rate so the next checkout fetches a fresh one.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ enabled?: boolean; markupPct?: number; manualRate?: number | null; refresh?: boolean }>(req)
  if (!body) return badRequest('Invalid request')

  const rows: Array<{ key: string; value: string; updated_at: string }> = []
  const now = new Date().toISOString()
  const details: Record<string, unknown> = {}

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return badRequest('enabled must be true or false')
    rows.push({ key: 'mpesa_enabled', value: String(body.enabled), updated_at: now }); details.enabled = body.enabled
  }
  if (body.markupPct !== undefined) {
    const m = Number(body.markupPct)
    if (!Number.isFinite(m) || m < 0 || m > MAX_MARKUP_PCT) return badRequest(`Markup must be between 0 and ${MAX_MARKUP_PCT}%`)
    rows.push({ key: 'kes_fx_markup_pct', value: String(m), updated_at: now }); details.markupPct = m
  }
  if (body.manualRate !== undefined) {
    if (body.manualRate === null) {
      rows.push({ key: 'kes_fx_manual', value: '', updated_at: now }); details.manualRate = null
    } else {
      const r = Number(body.manualRate)
      if (!Number.isFinite(r) || r < 50 || r > 500) return badRequest('Manual rate must be between 50 and 500 KES per USD')
      rows.push({ key: 'kes_fx_manual', value: String(r), updated_at: now }); details.manualRate = r
    }
  }
  if (body.refresh === true) {
    rows.push({ key: 'kes_fx_cache', value: '', updated_at: now }); details.refresh = true
  }
  if (rows.length === 0) return badRequest('Nothing to change')

  const { error } = await supabase.from('platform_settings').upsert(rows, { onConflict: 'key' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction(supabase, { adminId, action: 'mpesa.settings', details })
  return NextResponse.json({ success: true })
}
