// Receives Content-Security-Policy-Report-Only violation reports (see
// next.config.ts). Unauthenticated by nature — browsers send these — so it
// only logs a truncated, flattened copy and always answers 204.
export async function POST(req: Request) {
  try {
    const text = (await req.text()).slice(0, 4000)
    const parsed = JSON.parse(text)
    const r = parsed?.['csp-report'] ?? parsed
    console.warn('[csp-report]', JSON.stringify({
      directive: r?.['violated-directive'] ?? r?.effectiveDirective,
      blocked: r?.['blocked-uri'] ?? r?.blockedURL,
      page: r?.['document-uri'] ?? r?.documentURL,
    }).slice(0, 600))
  } catch { /* malformed report: ignore */ }
  return new Response(null, { status: 204 })
}
