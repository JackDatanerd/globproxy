import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

// The stock panel used to read and write platform_settings straight from the
// browser with the admin's own JWT. That path never saw the TOTP step-up (an
// RLS policy only knows the role), so a password-only session could change
// platform settings, and nothing was audited. It now goes through here like
// every other admin action, and migration 0052 drops the browser policy.

const KEYS = ['geonode_stock', 'auto_reload_enabled', 'auto_reload_threshold_gb']

function defaultThreshold(): number {
  const n = Number(process.env.STOCK_ALERT_THRESHOLD ?? 10)
  return Number.isFinite(n) && n > 0 ? n : 10
}

export async function GET(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response

  const { data, error } = await auth.supabase.from('platform_settings').select('key, value').in('key', KEYS)
  if (error) return NextResponse.json({ error: 'Could not load stock settings.' }, { status: 500 })

  const byKey = new Map((data ?? []).map(r => [r.key, r.value as string]))
  let stock: unknown = null
  try { const raw = byKey.get('geonode_stock'); stock = raw ? JSON.parse(raw) : null } catch { stock = null }
  const threshold = Number(byKey.get('auto_reload_threshold_gb'))

  return NextResponse.json({
    stock,
    // The cron ALWAYS sends low-stock alerts. This switch only decides whether
    // the custom threshold below replaces the built-in default.
    custom_threshold_enabled: byKey.get('auto_reload_enabled') === 'true',
    threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : defaultThreshold(),
    default_threshold: defaultThreshold(),
  })
}

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response

  const body = await readJson<{ enabled?: unknown; threshold?: unknown }>(req)
  if (!body) return badRequest('Invalid request body')
  const { enabled, threshold } = body
  if (typeof enabled !== 'boolean') return badRequest('enabled must be true or false')
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 1 || threshold > 1_000_000) {
    return badRequest('Alert threshold must be between 1 and 1,000,000 GB')
  }

  const { error } = await auth.supabase.from('platform_settings').upsert(
    [
      { key: 'auto_reload_enabled', value: String(enabled) },
      { key: 'auto_reload_threshold_gb', value: String(threshold) },
    ],
    { onConflict: 'key' }
  )
  if (error) return NextResponse.json({ error: `Could not save settings: ${error.message}` }, { status: 500 })

  await logAdminAction(auth.supabase, {
    adminId: auth.adminId, action: 'settings.stock_alerts',
    details: { custom_threshold_enabled: enabled, threshold_gb: threshold },
  })
  return NextResponse.json({ success: true })
}
