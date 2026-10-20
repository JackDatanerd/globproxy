import { rateLimited } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Receiver for the Content-Security-Policy-Report-Only header set in
// next.config.ts. Browsers POST here (no cookies, no auth) whenever a page
// does something the policy would block once it is enforced. Each report is
// reduced to a one-line log entry that shows up in the Worker log view, which
// is the whole point: it tells us what to add to the allow-list before the
// header is switched to enforcing.
//
// Public by necessity, so it is hard-bounded: per-address rate limit, a body
// size cap, nothing stored, nothing echoed back, and only a few
// allow-listed fields are ever logged (never the page query string).
const MAX_BODY_CHARS = 8 * 1024
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

  try {
    const raw = (await req.text()).slice(0, MAX_BODY_CHARS)
    const parsed = JSON.parse(raw)
    // Legacy report-uri format is { "csp-report": {...} }; the Reporting API
    // sends an array of { type, body: {...} }.
    const reports: any[] = Array.isArray(parsed)
      ? parsed.map((r) => r?.body).filter(Boolean)
      : parsed?.['csp-report']
        ? [parsed['csp-report']]
        : []
    for (const r of reports.slice(0, 5)) {
      const line: Record<string, string> = {}
      for (const f of FIELDS) if (r[f] !== undefined) line[f] = strip(r[f])
      console.warn('[csp-report]', JSON.stringify(line))
    }
  } catch {
    // Malformed or empty report — nothing worth logging.
  }
  return new NextResponse(null, { status: 204 })
}
