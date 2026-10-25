// Content-Security-Policy builder, shared by next.config.ts (the policy every
// response carries) and middleware.ts (a stricter, per-request-nonce policy for
// the signed-in areas).
//
// Imported by next.config.ts, so it must stay dependency-free and use a
// relative-import-friendly shape (no '@/' aliases inside this file).
//
// REPORT-ONLY by default. Promote to enforcing WITHOUT a code change by setting
// the CSP_MODE build variable to `enforce` (GitHub → Settings → Variables →
// Actions; deploy.yml passes it to the build) and redeploying. next.config.ts
// inlines it (`env`), because the Worker has no CSP_MODE at runtime.

export function supabaseOrigins(): string[] {
  const out = ['https://*.supabase.co', 'wss://*.supabase.co']
  try {
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')
    out.push(u.origin, u.origin.replace(/^http/, 'ws'))
  } catch {
    /* env not present at config time — the wildcard entries still cover hosted projects */
  }
  return [...new Set(out)]
}

// `signedIn` is the nonce policy on /dashboard, /reseller, /admin and /invoice. It can be
// promoted on its own (CSP_MODE_PROTECTED=enforce) BEFORE the public policy: the signed-in
// areas are where an injected script does real damage, and their policy has no 'unsafe-inline'
// to get wrong. Unset, it follows CSP_MODE, so existing deployments behave exactly as before.
export function cspEnforced(signedIn = false): boolean {
  if (signedIn && process.env.CSP_MODE_PROTECTED) return process.env.CSP_MODE_PROTECTED === 'enforce'
  return process.env.CSP_MODE === 'enforce'
}

export function cspHeaderName(signedIn = false): 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only' {
  return cspEnforced(signedIn) ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'
}

// Without a nonce: the policy for public, cacheable pages. script-src keeps
// 'unsafe-inline' because Next's hydration bootstrap is inline and a nonce needs a
// per-request value — which would make those pages dynamic and defeat the
// anonymous edge cache (custom-worker.ts).
//
// With a nonce: for /dashboard, /reseller, /admin and /invoice, which are always
// per-user, always dynamic and never edge-cached, so the nonce costs nothing.
// 'strict-dynamic' lets the nonced scripts load the rest (webpack chunks, the
// Paystack and Turnstile loaders); the host entries remain only as a fallback for
// browsers that predate it. No 'unsafe-inline' for scripts, so an injected
// <script> or inline handler in the signed-in app is blocked once enforced.
export function buildCsp(opts: { nonce?: string } = {}): string {
  const scriptSrc = opts.nonce
    ? `script-src 'self' 'nonce-${opts.nonce}' 'strict-dynamic' https://challenges.cloudflare.com https://js.paystack.co https://checkout.paystack.com`
    : `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://js.paystack.co https://checkout.paystack.com`
  return [
    `default-src 'self'`,
    scriptSrc,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' data: https://fonts.gstatic.com`,
    `img-src 'self' data: blob: https:`,
    `connect-src 'self' ${supabaseOrigins().join(' ')} https://api.paystack.co https://checkout.paystack.com https://challenges.cloudflare.com`,
    `frame-src https://challenges.cloudflare.com https://checkout.paystack.com https://js.paystack.co`,
    `frame-ancestors 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `form-action 'self'`,
    `report-uri /api/csp-report`,
  ].join('; ')
}
