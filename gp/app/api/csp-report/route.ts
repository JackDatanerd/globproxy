import { rateLimited } from '@/lib/rateLimit'
import { readTextCapped } from '@/lib/bodyLimit'
import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// Receiver for the Content-Security-Policy-Report-Only header set in
// next.config.ts. Browsers POST here (no cookies, no auth) whenever a page
// does something the policy would block once it is enforced. Each report is
// reduced to a one-line log entry AND counted in csp_violations (migration
// 0055), which Admin → Settings lists most-hit first — that list is what tells
// us what to add to the allow-list before the header is switched to enforcing.
//
// Public by necessity, so it is hard-bounded: per-address rate limit, a body
// size cap that is enforced WHILE reading (the old `(await req.text()).slice()`
// held the whole body in memory before truncating it), nothing echoed back, a
// capped table, and only a few allow-listed fields are ever kept (never the
// page query string).
const MAX_BODY_BYTES = 8 * 1024
const FIELDS = [
  'effective-directive', 'violated-directive', 'blocked-uri', 'blockedURL', 'document-uri', 'documentURL',
  'source-file', 'sourceFile', 'line-number', 'lineNumber', 'disposition',
] as const

function strip(v: unknown): string {
  // Query strings and fragments can carry tokens (auth callbacks, reset links).
  return String(v ?? '').split(/[?#]/)[0].slice(0, 200)
}

export async function POST(req: Request) {
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'csp')
  if (limited) return limited

  const raw = await readTextCapped(req, MAX_BODY_BYTES)
  if (raw === null) return new NextResponse(null, { status: 413 })

  try {
    const parsed = JSON.parse(raw)
    // Legacy report-uri format is { "csp-report": {...} }; the Reporting API
    // sends an array of { type, body: {...} }.
    const reports: any[] = Array.isArray(parsed)
      ? parsed.map((r) => r?.body).filter(Boolean)
      : parsed?.['csp-report']
        ? [parsed['csp-report']]
        : []
    const lines: Record<string, string>[] = []
    for (const r of reports.slice(0, 5)) {
      if (!r || typeof r !== 'object') continue
      const line: Record<string, string> = {}
      for (const f of FIELDS) if (r[f] !== undefined) line[f] = strip(r[f])
      console.warn('[csp-report]', JSON.stringify(line))
      lines.push(line)
    }
    if (lines.length) {
      try {
        const admin = await createAdminClient()
        await Promise.all(lines.map((l) =>
          admin.rpc('record_csp_violation', {
            p_directive: l['effective-directive'] ?? l['violated-directive'] ?? '',
            p_blocked: l['blocked-uri'] ?? l['blockedURL'] ?? '',
            p_document: l['document-uri'] ?? l['documentURL'] ?? '',
          }).then(({ error }) => { if (error) console.error('[csp-report] aggregate failed', error.message) })
        ))
      } catch (e) {
        console.error('[csp-report] aggregate threw', e)
      }
    }
  } catch {
    // Malformed or empty report — nothing worth logging.
  }
  return new NextResponse(null, { status: 204 })
}
