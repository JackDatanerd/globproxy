import Navbar from '@/components/Navbar'
import Link from 'next/link'

export const metadata = { title: 'API Documentation — GlobProxy' }

function Endpoint({ method, path, title, children }: { method: string; path: string; title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-xl overflow-hidden mb-6">
      <div className="flex items-center gap-3 px-5 py-3 bg-surface border-b border-border">
        <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
          method === 'GET' ? 'bg-accent-light text-accent' : 'bg-accent2-light text-accent2'
        }`}>{method}</span>
        <span className="font-mono text-sm text-ink">{path}</span>
        <span className="text-sm text-muted ml-auto">{title}</span>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

function Table({ rows }: { rows: [string, string, string][] }) {
  return (
    <table className="w-full text-sm mb-4">
      <thead>
        <tr className="border-b border-border">
          {['Field', 'Type', 'Description'].map(h => (
            <th key={h} className="text-left py-2 pr-4 text-[10px] font-mono text-muted uppercase tracking-wider">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([f, t, d]) => (
          <tr key={f} className="border-b border-border last:border-0">
            <td className="py-2 pr-4 font-mono text-xs text-ink align-top whitespace-nowrap">{f}</td>
            <td className="py-2 pr-4 font-mono text-xs text-muted align-top whitespace-nowrap">{t}</td>
            <td className="py-2 text-xs text-ink2 align-top">{d}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Code({ children }: { children: string }) {
  return <pre className="bg-surface border border-border rounded-lg px-4 py-3 text-xs font-mono text-ink2 overflow-x-auto leading-5">{children}</pre>
}

export default function ApiDocsPage() {
  return (
    <>
      <Navbar />
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-10">
          <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">Documentation</div>
          <h1 className="font-display font-bold text-4xl text-ink tracking-tight mb-3">API Reference</h1>
          <p className="text-ink2 font-light leading-relaxed">
            Automate sub-user creation, bandwidth allocation, and usage tracking for your own clients.
            API access is available to approved resellers — request it from{' '}
            <span className="font-mono text-ink">API Keys</span> in your dashboard once you're a reseller.
          </p>
        </div>

        <div className="border border-border rounded-xl p-6 bg-surface mb-10 flex flex-wrap items-center gap-3">
          <span className="text-xs font-mono text-muted uppercase tracking-widest">Guides</span>
          {[
            ['/blog/how-white-label-proxy-reselling-works', 'How reselling works'],
            ['/blog/reseller-api-automating-sub-user-provisioning', 'Automating provisioning'],
            ['/blog/reseller-auto-topup-client-bandwidth', 'Auto-topup'],
            ['/blog/ip-whitelisting-client-proxy-credentials', 'IP whitelisting'],
            ['/blog/pricing-your-white-label-proxy-service', 'Pricing your service'],
          ].map(([href, label]) => (
            <Link key={href} href={href} className="text-sm text-accent hover:underline">
              {label} →
            </Link>
          ))}
        </div>

        <p className="text-sm text-ink2 leading-relaxed mb-8">
          Machine-readable spec (OpenAPI 3): <a href="/api/v1/openapi.json" className="font-mono text-accent hover:underline">/api/v1/openapi.json</a> — import it into Postman, Insomnia or a code generator.
        </p>

        {/* Access */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-3">Getting access</h2>
          <p className="text-sm text-ink2 leading-relaxed mb-3">
            The API is only available to reseller accounts, and only once API access has been
            approved for that account — plain customer accounts can't use it, since there's nothing
            for it to automate on a non-reseller account.
          </p>
          <ol className="text-sm text-ink2 leading-relaxed space-y-1.5 list-decimal list-inside">
            <li>Apply to become a reseller from <Link href="/#reseller" className="text-accent hover:underline">the homepage</Link> or your account settings, if you aren't one already.</li>
            <li>Once approved, request API access from the <span className="font-mono text-ink">API Keys</span> page in your dashboard — a short note on what you plan to automate is all that's needed.</li>
            <li>Once that's approved too, generate a key from the same page.</li>
          </ol>
        </section>

        {/* Auth */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-3">Authentication</h2>
          <p className="text-sm text-ink2 leading-relaxed mb-3">
            Every request needs your API key in the <span className="font-mono text-ink">Authorization</span> header,
            as a bearer token. Keys are prefixed <span className="font-mono text-ink">gp_live_</span> and are only
            ever shown once, at creation time — GlobProxy doesn't store the plaintext key afterward, only a hash of
            it, so if you lose it you'll need to revoke and create a new one.
          </p>
          <Code>{`Authorization: Bearer gp_live_xxxxxxxxxxxxxxxxxxxxxxxx`}</Code>
          <p className="text-sm text-ink2 leading-relaxed mt-3">
            A request with a missing, malformed, revoked, or otherwise invalid key gets a plain{' '}
            <span className="font-mono text-ink">401</span> — the response body doesn't distinguish between
            "no such key" and "key revoked" so a leaked key can't be used to probe your account's key history.
            Each key has a scope and an optional expiry, both chosen when you create it:{' '}
            <span className="font-mono text-ink">read-only</span> keys can only make <span className="font-mono text-ink">GET</span>{' '}
            requests (any other method returns <span className="font-mono text-ink">403 insufficient_scope</span>), and a key
            can be set to expire after 30 days, 90 days, 180 days or a year — an expired key behaves exactly like a revoked one.
            You can hold up to 25 active keys, so give each integration its own and revoke it independently.
            The API key list in your dashboard also shows when and from which IP each key was last used.
          </p>

          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-5 mb-1.5">Scopes</p>
          <Table rows={[
            ['read', 'scope', 'GET requests only.'],
            ['write', 'scope', 'Everything except allocation: create, change and delete sub-users, top-ups, whitelists, webhooks. Includes read.'],
            ['allocate', 'scope', 'Resellers only. Move bandwidth between accounts (the /reseller/allocations endpoints). Never implied by write. A key with this scope MUST have an IP allowlist — without one every call is refused with 403 insufficient_scope — because API keys do not go through the 2FA step-up the dashboard applies to the same action.'],
          ]} />

          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-5 mb-1.5">IP allowlist</p>
          <p className="text-sm text-ink2 leading-relaxed">
            A key can be restricted to up to 20 source addresses: IPv4 or IPv6 addresses, or CIDR blocks
            (<span className="font-mono text-ink">203.0.113.0/24</span>, <span className="font-mono text-ink">2001:db8:1234::/48</span>; IPv4 prefixes /8 or longer, IPv6 /32 or longer).
            Write an IPv6 address in any valid spelling — it is compared as a number, not as text. Requests from anywhere else get{' '}
            <span className="font-mono text-ink">403 ip_not_allowed</span>. An empty list means any address.
          </p>

          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-5 mb-1.5">Managing keys</p>
          <p className="text-sm text-ink2 leading-relaxed">
            On the <span className="font-mono text-ink">API Keys</span> page you can <strong>edit</strong> a key's label, IP allowlist, access level and expiry in place
            (narrowing applies instantly; widening a key asks for 2FA or your password), <strong>rotate</strong> it (a replacement with the same settings is issued and the
            old key keeps working for 24 hours so you can switch over — or choose &ldquo;Revoke the old key now&rdquo; if it leaked; that works even when you already hold 25 active keys),
            <strong> revoke</strong> one or all of them, and see each key's <strong>activity</strong>: every change (POST / PATCH / DELETE) made with it in the last 30 days,
            with the IP, status and request id. The same data is at <span className="font-mono text-ink">GET /api/v1/account/activity</span>.
            A key with an expiry sends you an e-mail and an <span className="font-mono text-ink">api_key_expiring</span> webhook 7 days before it lapses.
          </p>
          <p className="text-sm text-ink2 leading-relaxed mt-3">
            Every response carries an <span className="font-mono text-ink">X-Request-Id</span> header — quote it when contacting support.
            Note that a <span className="font-mono text-ink">read</span> key can read sub-user proxy passwords (the same data as the dashboard): protect read-only keys like any other.
          </p>
        </section>

        {/* Base URL */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-3">Base URL</h2>
          <Code>{`https://globproxy.com`}</Code>
        </section>

        {/* Errors */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-3">Errors</h2>
          <p className="text-sm text-ink2 leading-relaxed mb-3">
            Errors are JSON: <span className="font-mono text-ink">{`{ "error": "<human message>", "code": "<machine code>" }`}</span>.
            Match on <span className="font-mono text-ink">code</span> (stable) rather than the message, which may be reworded.
          </p>
          <Code>{`{ "error": "Insufficient bandwidth. Requested 50GB is more than you have available. Purchase more to continue.", "code": "insufficient_bandwidth" }`}</Code>
          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Status codes</p>
          <Table rows={[
            ['400', 'Bad Request', 'Missing or invalid parameters — see the error message for which one.'],
            ['401', 'Unauthorized', 'Missing, malformed, or revoked API key.'],
            ['402', 'Payment Required', 'Not enough bandwidth in your account for the request (sub-user creation, top-up).'],
            ['403', 'Forbidden', 'Account suspended, API access not enabled, read-only key used for a write, or an action not permitted on this resource.'],
            ['404', 'Not Found', "The resource doesn't exist, or doesn't belong to your account."],
            ['409', 'Conflict', "The sub-user is still being provisioned (whitelist, usage history), or an identical Idempotency-Key request is still in flight."],
            ['422', 'Unprocessable', 'Idempotency-Key reused with a different request body.'],
            ['429', 'Too Many Requests', 'Rate limit exceeded — wait for the Retry-After interval.'],
            ['500', 'Internal Server Error', "Something went wrong on our end — safe to retry once; open a support ticket if it persists."],
            ['502', 'Bad Gateway', 'The upstream proxy provider is temporarily unavailable. Nothing was changed — safe to retry.'],
            ['503', 'Service Unavailable', "We couldn't verify your account right now (a transient error on our side). The key is fine — retry after a few seconds; don't delete or re-issue it."],
          ]} />
          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Error codes</p>
          <Table rows={[
            ['unauthorized', '401', 'Missing, malformed, revoked, or expired key.'],
            ['insufficient_scope', '403', 'The key lacks the scope the endpoint needs (read-only key used for a write, or no "allocate" scope / no IP allowlist on an allocation call).'],
            ['account_suspended', '403', 'The account is suspended.'],
            ['reseller_required / api_access_disabled', '403', 'The account is not a reseller, or API access has not been approved yet.'],
            ['forbidden', '403', 'Not allowed on this resource (e.g. deleting a reseller-allocated sub-user).'],
            ['invalid_request', '400', 'A parameter is missing or invalid; the message says which.'],
            ['insufficient_bandwidth', '402', 'Your available balance cannot cover the request.'],
            ['not_found', '404', "The resource doesn't exist or isn't yours."],
            ['payload_too_large', '413', 'The request body is over the 1 MiB limit.'],
            ['conflict / idempotency_conflict', '409 / 422', 'See status codes above. On money-moving calls a 409 can also mean an earlier request with the same Idempotency-Key finished with an unknown outcome — check the resource, then retry with a NEW key.'],
            ['ip_not_allowed', '403', "The request didn't come from one of the key's allowed IP addresses."],
            ['service_unavailable', '503', 'Transient failure verifying the account; safe to retry.'],
            ['rate_limited', '429', 'Too many requests.'],
            ['upstream_unavailable', '502', 'The proxy provider could not be reached; nothing changed.'],
            ['internal_error', '500', 'Unexpected server error.'],
          ]} />
        </section>

        {/* Rate limits */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-3">Rate limits</h2>
          <p className="text-sm text-ink2 leading-relaxed">
            Limits are per API key: <span className="font-mono text-ink">120 requests per minute</span> overall, and a tighter{' '}
            <span className="font-mono text-ink">30 per minute</span> for requests that change something (POST, PATCH, DELETE),
            since those provision real resources. Over the limit you get <span className="font-mono text-ink">429</span> with{' '}
            <span className="font-mono text-ink">code: "rate_limited"</span> and a <span className="font-mono text-ink">Retry-After</span>{' '}
            header — back off for that many seconds (always a full minute: the limits are per-minute windows). The limit that was hit
            is also sent as <span className="font-mono text-ink">X-RateLimit-Limit</span>. There is also a generous per-address ceiling that
            only affects clients sending large volumes of invalid keys. <span className="font-mono text-ink">/usage/history</span> has its own, tighter limit of 10 per minute per key (each call fans out to many provider requests). Live usage on <span className="font-mono text-ink">/usage</span> is refreshed
            from the provider at most every 30 seconds per sub-user, so polling it faster just returns the same number.
          </p>
          <p className="text-sm text-ink2 leading-relaxed mt-3">
            Every response includes <span className="font-mono text-ink">X-RateLimit-Limit</span> (120). The limiter cannot report how much of the current window is left, so on a{' '}
            <span className="font-mono text-ink">429</span> <span className="font-mono text-ink">Retry-After</span> is the full 60-second window. Each item in a bulk request counts
            as one write. Requests with invalid keys are also limited per source address, so a misconfigured client hammering with a bad key is slowed down.
          </p>
          <p className="text-sm text-ink2 leading-relaxed mt-3">
            Treat your key like a password regardless — never expose it in client-side JavaScript, a public repo, or a mobile app
            bundle; proxy calls to it through your own backend if you need to trigger them from a browser or app.
          </p>
        </section>

        {/* Pagination */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-3">Pagination</h2>
          <p className="text-sm text-ink2 leading-relaxed mb-3">
            List endpoints (<span className="font-mono text-ink">/sub-users</span>, <span className="font-mono text-ink">/orders</span>) accept{' '}
            <span className="font-mono text-ink">limit</span> and <span className="font-mono text-ink">offset</span> and return{' '}
            <span className="font-mono text-ink">total</span>, <span className="font-mono text-ink">limit</span>,{' '}
            <span className="font-mono text-ink">offset</span> and <span className="font-mono text-ink">has_more</span>.
            Sub-users default to 100 per page (max 500); orders default to 50 (max 200). Keep requesting with{' '}
            <span className="font-mono text-ink">offset += limit</span> until <span className="font-mono text-ink">has_more</span> is false.
          </p>
          <p className="text-sm text-ink2 leading-relaxed mt-3">
            Time-ordered logs (<span className="font-mono text-ink">/webhooks/:id/deliveries</span>, <span className="font-mono text-ink">/account/activity</span>,{' '}
            <span className="font-mono text-ink">/reseller/allocations</span>) are newest-first and use a cursor: when <span className="font-mono text-ink">has_more</span> is true,
            pass <span className="font-mono text-ink">next_before</span> as <span className="font-mono text-ink">before</span> <em>and</em> <span className="font-mono text-ink">next_before_id</span> as <span className="font-mono text-ink">before_id</span> to get the next, older page (sending both keeps rows that share a timestamp from being skipped).
          </p>
        </section>

        {/* Idempotency */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-3">Idempotency</h2>
          <p className="text-sm text-ink2 leading-relaxed mb-3">
            Send an <span className="font-mono text-ink">Idempotency-Key</span> header (8–128 characters: letters, digits and{' '}
            <span className="font-mono text-ink">_ - : .</span>) and a retry of the same request — after a timeout or dropped connection — returns the
            original response (marked <span className="font-mono text-ink">Idempotent-Replayed: true</span>) instead of doing the work twice. Keys are remembered for 24 hours
            and scoped to the endpoint: reusing one with a different body or on a different endpoint returns <span className="font-mono text-ink">422 idempotency_conflict</span>.
            Only successful calls are replayed; a failed attempt (for example a 402) frees the key so you can retry after fixing the cause.
          </p>
          <Table rows={[
            ['POST /sub-users', 'optional', 'A retry can never create a second sub-user, even if it races the original.'],
            ['POST /sub-users/:id/release', 'optional', 'A retry never releases twice; an unknown earlier outcome answers 409 like top-ups.'],
            ['POST /sub-users/:id/topup', 'optional', 'A retry never tops up twice. If an earlier attempt with the key died with an unknown outcome you get 409 — check gb_allocated, then retry with a new key.'],
            ['POST /sub-users/bulk, /sub-users/bulk-topup', 'REQUIRED', 'Item i is processed under "<key>#i", so a partially failed bulk call is safe to retry.'],
            ['POST /reseller/allocations, /allocations/:id/reclaim', 'REQUIRED', 'Same unknown-outcome rule as top-up: a transfer is never applied twice.'],
          ]} />
          <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Idempotency-Key: client-a-2026-10-18-001" \\
  -H "Content-Type: application/json" \\
  -d '{ "label": "Client A", "gb_allocated": 5 }'`}</Code>
        </section>

        {/* Endpoints */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-5">Endpoints</h2>

          <Endpoint method="GET" path="/api/v1/account/bandwidth" title="Bandwidth balance">
            <p className="text-sm text-ink2 mb-4">Your account's overall bandwidth balance — not per sub-user, see the usage endpoint below for that. allocated_gb is what's already reserved into sub-users; available_gb is what you can still create or top up with.</p>
            <Code>{`curl https://globproxy.com/api/v1/account/bandwidth \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "total_gb": 500,
  "used_gb": 128.4,
  "allocated_gb": 210,
  "available_gb": 371.6,
  "expires": "never"
}`}</Code>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/account" title="Account and key info">
            <p className="text-sm text-ink2 mb-4">Who this key belongs to and what it may do — scopes, allowed IPs and expiry — so an integration can check itself (and warn before the key lapses) instead of guessing from 403s.</p>
            <Code>{`curl https://globproxy.com/api/v1/account \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "account": { "id": "9c1e...", "email": "you@example.com", "role": "reseller" },
  "api_key": { "id": "b72d...", "key_prefix": "gp_live_a1b2c3", "label": "billing-bot", "scopes": ["read", "write"],
               "allowed_ips": ["203.0.113.0/24"], "expires_at": "2027-01-10T00:00:00.000Z", "created_at": "2026-10-10T09:00:00.000Z" },
  "features": { "password_rotation": false }
}`}</Code>
            <p className="text-sm text-ink2 mt-3"><span className="font-mono text-ink">features</span> reports optional endpoints that are switched on per deployment — <span className="font-mono text-ink">password_rotation: false</span> means <span className="font-mono text-ink">rotate-password</span> answers 503.</p>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/account/activity" title="API activity log">
            <p className="text-sm text-ink2 mb-4">Every change (POST / PATCH / DELETE) made with your account's keys in the last 30 days — which key, from which IP, which path, the status and the X-Request-Id. Read-only requests are not logged. Query: <span className="font-mono text-ink">key_id</span>, <span className="font-mono text-ink">limit</span> (max 200), <span className="font-mono text-ink">before</span> (cursor).</p>
            <Code>{`curl "https://globproxy.com/api/v1/account/activity?limit=20" \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "activity": [
    { "id": 812, "key_id": "b72d...", "key_prefix": "gp_live_a1b2c3", "key_label": "billing-bot", "method": "POST",
      "path": "/api/v1/sub-users/3f1a.../topup", "status": 200, "ip": "203.0.113.7", "request_id": "5e0c...", "created_at": "2026-10-18T09:30:00.000Z" }
  ],
  "has_more": false, "next_before": null, "next_before_id": null
}`}</Code>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/sub-users" title="List sub-users">
            <p className="text-sm text-ink2 mb-4">All proxy credentials (sub-users) on your account, newest first. Query parameters: <span className="font-mono text-ink">limit</span>, <span className="font-mono text-ink">offset</span> (see Pagination) and optional filters: <span className="font-mono text-ink">status</span> (<span className="font-mono text-ink">pending</span>, <span className="font-mono text-ink">active</span> or <span className="font-mono text-ink">suspended</span>), <span className="font-mono text-ink">label</span> (case-insensitive contains), <span className="font-mono text-ink">country</span> (2-letter code), <span className="font-mono text-ink">created_after</span> and <span className="font-mono text-ink">created_before</span> (ISO 8601).</p>
            <Code>{`curl https://globproxy.com/api/v1/sub-users \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "sub_users": [
    {
      "id": "3f1a...",
      "label": "Client A",
      "status": "active",
      "gb_allocated": 5,
      "gb_used": 1.2,
      "gb_remaining": 3.8,
      "country": "us",
      "state": "california",
      "city": null,
      "asn": null,
      "session_type": "rotating",
      "protocol": "http",
      "sticky_duration": null,
      "endpoint_count": 1,
      "host": "proxy.globproxy.com",
      "port": 9000,
      "username": "gp_1760000000000_ab12cd34",
      "password": "0b8f6c0e-...",
      "connection_username": "gp_1760000000000_ab12cd34-type-residential-country-us-state-california",
      "auto_topup": { "enabled": false, "threshold_gb": null, "amount_gb": null },
      "activated_at": "2026-08-01T12:00:00.000Z",
      "created_at": "2026-08-01T12:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0,
  "has_more": false
}`}</Code>
            <p className="text-sm text-ink2 mt-4">
              A working proxy connection is <span className="font-mono text-ink">host</span>:<span className="font-mono text-ink">port</span> with{' '}
              <span className="font-mono text-ink">connection_username</span> and <span className="font-mono text-ink">password</span> — use{' '}
              <span className="font-mono text-ink">connection_username</span> (not the raw <span className="font-mono text-ink">username</span>) because it has your
              targeting baked in. The password is the same one shown in your dashboard — treat API keys with the same care as the passwords they can read. For a sticky session, generate a fresh <span className="font-mono text-ink">-session-*</span>{' '}
              suffix per connection rather than reusing this one indefinitely; that logic lives client-side, this
              endpoint just returns the base credential.
            </p>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users" title="Create sub-user">
            <p className="text-sm text-ink2 mb-4">
              Creates a new proxy credential and reserves the requested bandwidth from your account balance
              atomically — a burst of concurrent creates can't oversubscribe your balance. Supports{' '}
              <span className="font-mono text-ink">Idempotency-Key</span> (see above).
            </p>
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "label": "Client A",
    "gb_allocated": 5,
    "country": "us",
    "state": "california",
    "protocol": "http",
    "session_type": "rotating"
  }'`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Body parameters</p>
            <Table rows={[
              ['gb_allocated', 'number', 'Required. Bandwidth to reserve for this sub-user: between 0.01 and 100000.'],
              ['label', 'string', 'Optional. Your own name for this credential, up to 100 characters.'],
              ['country', 'string', '2-letter ISO code (e.g. "us"). Required if state, city, or asn is set.'],
              ['state', 'string', 'Lowercase, no spaces/punctuation. Requires country.'],
              ['city', 'string', 'Lowercase, no spaces/punctuation. Requires country. state and city can both be set together.'],
              ['asn', 'string | number', 'Numeric ASN, e.g. "13868". Requires country, and must be an ASN that exists in that country — otherwise 400 (a session pinned to an ASN with no peers could never connect).'],
              ['session_type', 'string', '"rotating" (default) or "sticky".'],
              ['protocol', 'string', '"http" (default) or "socks5".'],
              ['sticky_duration', 'integer', 'Minutes (1–1440) the sticky session stays on the same peer. Only used when session_type is "sticky". Default 10.'],
              ['endpoint_count', 'integer', 'Informational — how many endpoints you intend to generate from this credential, 1–100. Default 1.'],
              ['auto_topup', 'object', 'Optional. Turn on auto-topup at creation: { "enabled": true, "threshold_gb": 1, "amount_gb": 5 } — same rules as PATCH /auto-topup.'],
            ]} />
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response — 201 Created</p>
            <Code>{`{
  "id": "3f1a...",
  "label": "Client A",
  "status": "active",
  "host": "proxy.globproxy.com",
  "port": 9000,
  "username": "gp_1760000000000_ab12cd34",
  "password": "0b8f6c0e-...",
  "connection_username": "gp_1760000000000_ab12cd34-type-residential-country-us-state-california",
  "gb_allocated": 5,
  "country": "us"
  // ...same fields as the list endpoint
}`}</Code>
            <p className="text-sm text-ink2 mt-4">
              <span className="font-mono text-ink">status</span> can come back{' '}
              <span className="font-mono text-ink">"pending"</span> instead of{' '}
              <span className="font-mono text-ink">"active"</span> if the upstream provisioning step is briefly
              unavailable — the credential and bandwidth reservation are still created and activation is retried
              automatically in the background (typically within a few minutes). While pending,{' '}
              <span className="font-mono text-ink">username</span>, <span className="font-mono text-ink">password</span> and{' '}
              <span className="font-mono text-ink">connection_username</span> are <span className="font-mono text-ink">null</span>, and{' '}
              <span className="font-mono text-ink">pending_reason</span> says why it isn't live yet:{' '}
              <span className="font-mono text-ink">"capacity"</span> (network capacity is being added),{' '}
              <span className="font-mono text-ink">"unavailable"</span> (a temporary outage) or{' '}
              <span className="font-mono text-ink">"error"</span>. Subscribe to the{' '}
              <span className="font-mono text-ink">session_activated</span> webhook, or poll{' '}
              <span className="font-mono text-ink">GET /api/v1/sub-users/:id</span>, to know when it's live.
            </p>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/sub-users/:id" title="Get sub-user">
            <p className="text-sm text-ink2 mb-4">One sub-user, in the same shape as a list entry (including <span className="font-mono text-ink">password</span> and <span className="font-mono text-ink">connection_username</span>).</p>
            <Code>{`curl https://globproxy.com/api/v1/sub-users/SUB_USER_ID \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
          </Endpoint>

          <Endpoint method="PATCH" path="/api/v1/sub-users/:id" title="Update sub-user">
            <p className="text-sm text-ink2 mb-4">
              Changes the label or connection settings. Targeting lives in the connection username, so this takes
              effect immediately and doesn't touch bandwidth (use <span className="font-mono text-ink">/topup</span> for that).
              Send only the fields you want to change; send <span className="font-mono text-ink">null</span> to clear a targeting field.
              Changing <span className="font-mono text-ink">country</span> also clears a <span className="font-mono text-ink">state</span> /{' '}
              <span className="font-mono text-ink">city</span> you don't send in the same request, since the old ones belong to the old country.
              Sub-users allocated by a reseller, and suspended ones, can't be edited (<span className="font-mono text-ink">403</span>).
            </p>
            <Code>{`curl -X PATCH https://globproxy.com/api/v1/sub-users/SUB_USER_ID \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "label": "Client A (EU)", "country": "de", "city": "berlin" }'`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Body parameters</p>
            <Table rows={[
              ['label', 'string | null', 'Up to 100 characters.'],
              ['country / state / city / asn', 'string | null', 'Same rules as creation; validated together with the values already on the sub-user.'],
              ['session_type', 'string', '"rotating" or "sticky". Changes the port.'],
              ['protocol', 'string', '"http" or "socks5". Changes the port.'],
              ['sticky_duration', 'integer | null', 'Minutes, 1–1440 (sticky only).'],
              ['endpoint_count', 'integer', 'Informational, 1–100.'],
            ]} />
            <p className="text-sm text-ink2 mt-4">Returns the updated sub-user.</p>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/sub-users/:id/usage" title="Get sub-user usage">
            <p className="text-sm text-ink2 mb-4">Current usage for a single sub-user, synced live from the upstream provider when the credential is active.</p>
            <Code>{`curl https://globproxy.com/api/v1/sub-users/SUB_USER_ID/usage \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "id": "3f1a...",
  "label": "Client A",
  "status": "active",
  "protocol": "http",
  "session_type": "rotating",
  "gb_allocated": 5,
  "gb_used": 1.2,
  "gb_remaining": 3.8,
  "country": "us",
  "state": "california",
  "city": null,
  "host": "proxy.globproxy.com",
  "port": 9000,
  "username": "gp_1760000000000_ab12cd34",
  "connection_username": "gp_1760000000000_ab12cd34-type-residential-country-us-state-california",
  "usage_synced_at": "2026-10-18T09:30:00.000Z"
}`}</Code>
            <p className="text-sm text-ink2 mt-4">
              Re-read from the provider at most every 30 seconds per sub-user; <span className="font-mono text-ink">usage_synced_at</span> says
              when the number was last refreshed.
            </p>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/sub-users/:id/usage/history" title="Usage history">
            <p className="text-sm text-ink2 mb-4">
              Bandwidth and request counts over time for one sub-user. <span className="font-mono text-ink">days</span> is 1–90 (default 7);{' '}
              <span className="font-mono text-ink">granularity</span> is <span className="font-mono text-ink">day</span> (default) or{' '}
              <span className="font-mono text-ink">hour</span> (up to 30 days). <span className="font-mono text-ink">409</span> if the sub-user hasn't been activated yet.
            </p>
            <Code>{`curl "https://globproxy.com/api/v1/sub-users/SUB_USER_ID/usage/history?days=7&granularity=day" \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "id": "3f1a...",
  "from": "2026-10-11T09:30:00.000Z",
  "to": "2026-10-18T09:30:00.000Z",
  "granularity": "day",
  "total_gb": 1.2,
  "points": [
    { "period_start": "2026-10-11T00:00:00.000Z", "gb": 0.31, "successful_requests": 4120, "failed_requests": 37, "success_rate": 99.1 }
  ]
}`}</Code>
          </Endpoint>

          <Endpoint method="DELETE" path="/api/v1/sub-users/:id" title="Delete sub-user">
            <p className="text-sm text-ink2 mb-4">
              Deletes a sub-user and releases whatever portion of its bandwidth reservation was never used
              back to your account balance. Already-consumed usage isn't refunded — only the unused remainder.
            </p>
            <Code>{`curl -X DELETE https://globproxy.com/api/v1/sub-users/SUB_USER_ID \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{ "success": true, "gb_released": 3.8 }`}</Code>
            <p className="text-sm text-ink2 mt-4">
              If the upstream provider can't be reached the delete fails with <span className="font-mono text-ink">502</span> and <em>nothing is changed</em> — retry it; a retry after a partial failure completes cleanly. A sub-user that a reseller allocated to you (rather than one you created yourself) can't be
              deleted through the API, same as in the dashboard — <span className="font-mono text-ink">403</span>{' '}
              if you try.
            </p>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users/:id/topup" title="Top up sub-user">
            <p className="text-sm text-ink2 mb-4">
              Adds bandwidth to a sub-user you already have, instead of creating a new one. Reserves the
              amount from your balance atomically, same guarantee as creation.
            </p>
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/topup \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "gb_amount": 5 }'`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Body parameters</p>
            <Table rows={[
              ['gb_amount', 'number', 'Required. GB to add: between 0 (exclusive) and 100000.'],
            ]} />
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{ "success": true, "gb_allocated": 10, "gb_added": 5 }`}</Code>
            <p className="text-sm text-ink2 mt-4">
              <span className="font-mono text-ink">gb_allocated</span> is the sub-user's new total cap, not
              the amount just added. <span className="font-mono text-ink">402</span> if your account balance
              can't cover the top-up. Supports <span className="font-mono text-ink">Idempotency-Key</span> (see above).
            </p>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users/bulk" title="Create sub-users in bulk">
            <p className="text-sm text-ink2 mb-4">
              Up to 10 sub-users per call, each created independently (one failing doesn't stop or undo the others). Each item takes the same
              fields as <span className="font-mono text-ink">POST /sub-users</span>. <span className="font-mono text-ink">Idempotency-Key</span> is <strong>required</strong>; each item counts as one write.
            </p>
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users/bulk \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Idempotency-Key: onboarding-batch-2026-10-18" \\
  -H "Content-Type: application/json" \\
  -d '{ "items": [ { "label": "Client A", "gb_allocated": 5 }, { "label": "Client B", "gb_allocated": 10, "country": "DE" } ] }'`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "results": [
    { "index": 0, "status": 201, "sub_user": { "id": "3f1a...", "label": "Client A", "...": "..." } },
    { "index": 1, "status": 402, "error": { "code": "insufficient_bandwidth", "message": "Insufficient bandwidth..." } }
  ],
  "succeeded": 1, "failed": 1
}`}</Code>
            <p className="text-sm text-ink2 mt-4">Re-sending the same request (same key) returns the same result without creating anything twice. To retry only the failed items, send them under a <em>new</em> key.</p>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users/:id/pause" title="Pause / resume a sub-user">
            <p className="text-sm text-ink2 mb-4">
              <span className="font-mono text-ink">POST /sub-users/:id/pause</span> stops a sub-user from using bandwidth while keeping its allocation, credentials and settings;{' '}
              <span className="font-mono text-ink">POST /sub-users/:id/resume</span> turns it back on. Both are idempotent (repeating them answers 200 with <span className="font-mono text-ink">changed: false</span>).
              Only a sub-user <em>you</em> paused can be resumed this way — one suspended by GlobProxy answers <span className="font-mono text-ink">403</span> (see <span className="font-mono text-ink">can_resume</span> on the sub-user).
              A paused sub-user is not affected by account-level suspension cycles. Fires <span className="font-mono text-ink">session_suspended</span> / <span className="font-mono text-ink">session_resumed</span> with <span className="font-mono text-ink">source: "customer"</span>.
            </p>
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/pause \\
  -H "Authorization: Bearer YOUR_KEY"

{ "id": "…", "status": "suspended", "changed": true }`}</Code>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users/bulk-action" title="Delete, pause or resume in bulk">
            <p className="text-sm text-ink2 mb-4">
              Up to 20 sub-users per call: <span className="font-mono text-ink">{'{ "action": "delete" | "pause" | "resume", "ids": [...] }'}</span>. Items are independent and each counts as one write.
              Every action is safe to repeat, so no Idempotency-Key is needed — if a request times out, send it again (items already deleted report 404).
              Response: <span className="font-mono text-ink">{'{ results: [{ index, id, status, … }], succeeded, failed }'}</span>; deletes include <span className="font-mono text-ink">gb_released</span>.
            </p>
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users/bulk-action \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{ "action": "pause", "ids": ["SUB_USER_ID_1", "SUB_USER_ID_2"] }'`}</Code>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/locations" title="Targeting values: countries, states, cities, ISPs">
            <p className="text-sm text-ink2 mb-4">
              Find out which values are valid before creating a sub-user. <span className="font-mono text-ink">GET /locations</span> lists countries (<span className="font-mono text-ink">code</span> → <span className="font-mono text-ink">country</span>);{' '}
              <span className="font-mono text-ink">GET /locations/:country</span> lists its states with their cities (<span className="font-mono text-ink">state</span> / <span className="font-mono text-ink">city</span>; add <span className="font-mono text-ink">?cities=false</span> to skip the city lists);{' '}
              <span className="font-mono text-ink">GET /locations/:country/asns</span> lists ISPs (<span className="font-mono text-ink">asn</span>; empty where ISP targeting isn't offered).
            </p>
            <Code>{`curl https://globproxy.com/api/v1/locations/us/asns \\
  -H "Authorization: Bearer YOUR_KEY"

{ "country": "us", "asns": [ { "asn": 7922, "name": "AS7922 COMCAST-7922" }, … ] }`}</Code>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users/bulk-topup" title="Top up sub-users in bulk">
            <p className="text-sm text-ink2 mb-4">
              Up to 20 independent top-ups per call. <span className="font-mono text-ink">Idempotency-Key</span> is <strong>required</strong>; each item counts as one write.
              If an earlier attempt with the same key finished with an unknown outcome, this answers 409 instead of re-running it — check the sub-users' <span className="font-mono text-ink">gb_allocated</span>, then retry with a new key.
            </p>
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users/bulk-topup \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Idempotency-Key: monthly-topup-2026-10" \\
  -H "Content-Type: application/json" \\
  -d '{ "items": [ { "id": "SUB_USER_ID_1", "gb_amount": 5 }, { "id": "SUB_USER_ID_2", "gb_amount": 2.5 } ] }'`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "results": [
    { "index": 0, "id": "SUB_USER_ID_1", "status": 200, "gb_allocated": 15, "gb_added": 5 },
    { "index": 1, "id": "SUB_USER_ID_2", "status": 404, "error": { "code": "not_found", "message": "Sub-user not found" } }
  ],
  "succeeded": 1, "failed": 1
}`}</Code>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users/:id/release" title="Release unused bandwidth">
            <p className="text-sm text-ink2 mb-4">
              Returns bandwidth a sub-user hasn't used to your account balance, without deleting it — the reverse of{' '}
              <span className="font-mono text-ink">/topup</span>. The sub-user's live usage plus a small safety margin always
              stays, so you can only release what is genuinely unused.
            </p>
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/release \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "gb_amount": 2 }'`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{ "success": true, "gb_allocated": 3, "gb_released": 2, "max_releasable_gb": 0.41 }`}</Code>
            <p className="text-sm text-ink2 mt-4">
              <span className="font-mono text-ink">400</span> with the releasable amount if you ask for more than is unused,{' '}
              <span className="font-mono text-ink">409</span> if it would immediately re-trigger auto-topup (lower the amount or
              turn auto-topup off first), <span className="font-mono text-ink">502</span> if live usage couldn't be confirmed
              (nothing is changed). Reseller-allocated sub-users return <span className="font-mono text-ink">403</span>.
              Accepts an <span className="font-mono text-ink">Idempotency-Key</span> header, like top-ups: a retry returns the
              original response instead of releasing twice.
            </p>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users/:id/rotate-password" title="Rotate password">
            <p className="text-sm text-ink2 mb-4">
              Replaces the sub-user's proxy password; the previous one stops working immediately. Returns the new password
              (it is also what <span className="font-mono text-ink">GET /sub-users/:id</span> now shows). Returns{' '}
              <span className="font-mono text-ink">503</span> while password rotation isn't enabled for the platform.
            </p>
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/rotate-password \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{ "success": true, "password": "5d0c1e7a-..." }`}</Code>
          </Endpoint>

          <Endpoint method="PATCH" path="/api/v1/sub-users/:id/auto-topup" title="Configure auto-topup">
            <p className="text-sm text-ink2 mb-4">
              Turns automatic top-up on or off for a sub-user — when its remaining bandwidth drops to{' '}
              <span className="font-mono text-ink">threshold_gb</span>, <span className="font-mono text-ink">amount_gb</span>{' '}
              is added automatically from your balance, checked on the same cycle that syncs usage. If your balance can't
              cover the full <span className="font-mono text-ink">amount_gb</span>, the sub-user is topped up with whatever the
              balance can cover and you're notified (<span className="font-mono text-ink">auto_topup_failed</span>, reason{' '}
              <span className="font-mono text-ink">partial_funding</span>); with no balance at all nothing is added and the same event is
              sent with reason <span className="font-mono text-ink">insufficient_balance</span>. Both numbers are capped at 100000.
            </p>
            <Code>{`curl -X PATCH https://globproxy.com/api/v1/sub-users/SUB_USER_ID/auto-topup \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "enabled": true, "threshold_gb": 1, "amount_gb": 5 }'`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Body parameters</p>
            <Table rows={[
              ['enabled', 'boolean', 'Required. Turn auto-topup on or off.'],
              ['threshold_gb', 'number', 'Required when enabling. Remaining GB that triggers a top-up. Can be 0.'],
              ['amount_gb', 'number', 'Required when enabling. GB added per trigger, must be > 0 and greater than threshold_gb (otherwise the sub-user would be topped up on every check).'],
            ]} />
            <p className="text-sm text-ink2 mt-4">
              Send <span className="font-mono text-ink">{`{ "enabled": false }`}</span> to turn it off —{' '}
              <span className="font-mono text-ink">threshold_gb</span>/<span className="font-mono text-ink">amount_gb</span>{' '}
              aren't required (or stored) in that case.
            </p>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/sub-users/:id/sessions" title="List sticky sessions">
            <p className="text-sm text-ink2 mb-4">
              Named sticky sessions on a <span className="font-mono text-ink">sticky</span> sub-user. Each has its own{' '}
              <span className="font-mono text-ink">connection_username</span> that pins an exit IP for the sub-user's sticky duration.
            </p>
            <Code>{`curl https://globproxy.com/api/v1/sub-users/SUB_USER_ID/sessions \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "sessions": [
    { "id": "9c2e...", "label": "scraper-1", "pinned": false, "collapsed": false,
      "session_token": "aB3dE5gH",
      "connection_username": "gp_...-type-residential-country-us-lifetime-10-session-aB3dE5gH",
      "created_at": "2026-10-18T09:00:00.000Z" }
  ]
}`}</Code>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users/:id/sessions" title="Create sticky session">
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/sessions \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "label": "scraper-1" }'`}</Code>
            <p className="text-sm text-ink2 mt-4">
              201 with the new session. <span className="font-mono text-ink">400</span> if the sub-user isn't sticky or already has 200 active sessions.
            </p>
          </Endpoint>

          <Endpoint method="PATCH" path="/api/v1/sub-users/:id/sessions/:sessionId" title="Update / terminate session">
            <Code>{`curl -X PATCH https://globproxy.com/api/v1/sub-users/SUB_USER_ID/sessions/SESSION_ID \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "label": "scraper-1b", "pinned": true }'`}</Code>
            <p className="text-sm text-ink2 mt-4">
              Accepts <span className="font-mono text-ink">label</span>, <span className="font-mono text-ink">pinned</span>,{' '}
              <span className="font-mono text-ink">collapsed</span> and <span className="font-mono text-ink">terminate: true</span>.{' '}
              <span className="font-mono text-ink">DELETE</span> on the same path removes a session outright.
            </p>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/orders" title="Purchase history">
            <p className="text-sm text-ink2 mb-4">
              Your bandwidth purchases, newest first (read-only). Query: <span className="font-mono text-ink">limit</span>,{' '}
              <span className="font-mono text-ink">offset</span>, and optional <span className="font-mono text-ink">status</span>{' '}
              (<span className="font-mono text-ink">pending, paid, failed, refunded, cancelled</span>), <span className="font-mono text-ink">created_after</span> and{' '}
              <span className="font-mono text-ink">created_before</span> (ISO 8601). One order: <span className="font-mono text-ink">GET /api/v1/orders/:id</span> (same fields).
            </p>
            <Code>{`curl https://globproxy.com/api/v1/orders?status=paid \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "orders": [
    { "id": "5d0b...", "gb_amount": 100, "amount_usd": 249, "status": "paid", "invoice_number": "INV-000123",
      "refunded_usd": 0, "refunded_at": null, "created_at": "2026-10-01T08:00:00.000Z", "paid_at": "2026-10-01T08:01:10.000Z" }
  ],
  "total": 1, "limit": 50, "offset": 0, "has_more": false
}`}</Code>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/reseller/allocations" title="Allocation history (resellers)">
            <p className="text-sm text-ink2 mb-4">Your bandwidth transfers to clients, newest first — the same data as the dashboard's Transfers page. Query: <span className="font-mono text-ink">limit</span> (max 200), <span className="font-mono text-ink">before</span> (cursor). Needs a <span className="font-mono text-ink">read</span> key.</p>
            <Code>{`curl "https://globproxy.com/api/v1/reseller/allocations?limit=20" \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "transfers": [
    { "id": "e4a1...", "recipient_email": "client@example.com", "gb_amount": 25, "gb_reclaimed": 0, "gb_net": 25,
      "status": "completed", "note": "October top-up", "created_at": "2026-10-18T09:30:00.000Z" }
  ],
  "has_more": false, "next_before": null, "next_before_id": null
}`}</Code>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/reseller/allocations" title="Allocate bandwidth to a client (resellers)">
            <p className="text-sm text-ink2 mb-4">
              Moves GB from your stock to a registered client account — the same operation as the dashboard, with the same notifications and webhooks
              (<span className="font-mono text-ink">bandwidth_allocated</span> to you, <span className="font-mono text-ink">bandwidth_credited</span> to the client).
              Requires a key with the <span className="font-mono text-ink">allocate</span> scope <strong>and an IP allowlist</strong>, and an <span className="font-mono text-ink">Idempotency-Key</span>.
              Unknown, suspended and deleted accounts all answer the same <span className="font-mono text-ink">404</span>, so this can't be used to discover who has an account.
            </p>
            <Code>{`curl -X POST https://globproxy.com/api/v1/reseller/allocations \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Idempotency-Key: alloc-client-42-2026-10" \\
  -H "Content-Type: application/json" \\
  -d '{ "recipient_email": "client@example.com", "gb_allocated": 25, "note": "October top-up" }'`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Body parameters</p>
            <Table rows={[
              ['recipient_email', 'string', 'Required. The client\'s GlobProxy account e-mail.'],
              ['gb_allocated', 'number', 'Required. At least 0.1, at most 3 decimal places.'],
              ['note', 'string', 'Optional, up to 200 characters.'],
            ]} />
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response (201)</p>
            <Code>{`{ "transfer_id": "e4a1...", "gb": 25, "recipient_email": "client@example.com" }`}</Code>
            <p className="text-sm text-ink2 mt-4"><span className="font-mono text-ink">402 insufficient_bandwidth</span> if your stock can't cover it. Shares the dashboard's per-reseller throttle.</p>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/reseller/allocations/:id/reclaim" title="Reclaim an allocation (resellers)">
            <p className="text-sm text-ink2 mb-4">
              Takes back the <em>unused</em> part of a transfer (a typo'd e-mail, a cancelled order). Only bandwidth the client has not used, assigned to a sub-user or since topped up past can move back,
              and only within the reclaim window — the same rules as the dashboard. <span className="font-mono text-ink">gb</span> is optional (default: everything reclaimable).
              Needs the <span className="font-mono text-ink">allocate</span> scope and an <span className="font-mono text-ink">Idempotency-Key</span>; the client receives a <span className="font-mono text-ink">bandwidth_reclaimed</span> webhook and an e-mail.
            </p>
            <Code>{`curl -X POST https://globproxy.com/api/v1/reseller/allocations/TRANSFER_ID/reclaim \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Idempotency-Key: reclaim-e4a1-001" \\
  -H "Content-Type: application/json" \\
  -d '{ "gb": 10 }'`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{ "transfer_id": "e4a1...", "reclaimed_gb": 10, "remaining_gb": 15 }`}</Code>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/sub-users/:id/whitelist" title="List whitelisted IPs">
            <p className="text-sm text-ink2 mb-4">IP addresses currently allowed to use this sub-user's credentials.</p>
            <Code>{`curl https://globproxy.com/api/v1/sub-users/SUB_USER_ID/whitelist \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "ips": [
    { "ip": "203.0.113.4", "description": "Office IP" }
  ]
}`}</Code>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users/:id/whitelist" title="Add whitelisted IP">
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/whitelist \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "ip": "203.0.113.4", "description": "Office IP" }'`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Body parameters</p>
            <Table rows={[
              ['ip', 'string', 'Required. A single IPv4 or IPv6 address — no CIDR ranges.'],
              ['description', 'string', 'Required. 1–100 characters, e.g. "Office IP".'],
            ]} />
            <p className="text-sm text-ink2 mt-4">Returns the sub-user's full updated whitelist, same shape as the GET above.</p>
          </Endpoint>

          <Endpoint method="DELETE" path="/api/v1/sub-users/:id/whitelist" title="Remove whitelisted IP">
            <Code>{`curl -X DELETE "https://globproxy.com/api/v1/sub-users/SUB_USER_ID/whitelist?ip=203.0.113.4" \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-sm text-ink2 mt-4">
              <span className="font-mono text-ink">ip</span> is a query parameter here, not a body field.
            </p>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users/:id/whitelist/bulk" title="Bulk add whitelisted IPs">
            <Code>{`curl -X POST https://globproxy.com/api/v1/sub-users/SUB_USER_ID/whitelist/bulk \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "items": [
      { "ip": "203.0.113.4", "description": "Office IP" },
      { "ip": "198.51.100.9", "description": "Home IP" }
    ]
  }'`}</Code>
            <p className="text-sm text-ink2 mt-4">Up to 150 IPs per request. All-or-nothing — the first invalid entry rejects the whole batch.</p>
          </Endpoint>

          <Endpoint method="DELETE" path="/api/v1/sub-users/:id/whitelist/bulk" title="Bulk remove whitelisted IPs">
            <Code>{`curl -X DELETE https://globproxy.com/api/v1/sub-users/SUB_USER_ID/whitelist/bulk \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "ips": ["203.0.113.4", "198.51.100.9"] }'`}</Code>
            <p className="text-sm text-ink2 mt-4">
              A POST-shaped body on a DELETE — deliberate, so it can carry an arbitrary-length list rather
              than being limited to what fits in a query string.
            </p>
          </Endpoint>
        </section>

        {/* Webhooks */}
        <section id="webhooks" className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-3">Webhooks</h2>
          <p className="text-sm text-ink2 leading-relaxed mb-3">
            Get an HTTPS POST when something happens on your account. Create endpoints in{' '}
            <Link href="/dashboard/settings" className="text-accent hover:underline">Settings → Webhooks</Link> or over the API
            (below). Each endpoint subscribes to the events it wants; up to 10 endpoints per account. Adding, changing, rotating or deleting an endpoint — from the dashboard <em>or</em> with an API key — is recorded in your account's security log and e-mailed to you (at most one e-mail per kind of change every 10 minutes). Events caused by your own request are first delivered right after that request returns; events raised by background checks (<span className="font-mono text-ink">session_low</span>, <span className="font-mono text-ink">session_exhausted</span>, <span className="font-mono text-ink">auto_topup_*</span>, <span className="font-mono text-ink">session_activated</span>, <span className="font-mono text-ink">bandwidth_threshold_crossed</span>) can arrive up to about five minutes after the cause. Endpoint URLs must be public{' '}
            <span className="font-mono text-ink">https://</span> addresses on port 443 (or 8443) — private, loopback and link-local
            destinations (including hostnames that resolve to them), GlobProxy's own domains and redirects are rejected.
          </p>

          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Events</p>
          <Table rows={[
            ['session_created', 'event', 'A sub-user was created (dashboard or API). data: credential_id, label, protocol, session_type, gb_allocated, country, state, city, asn, status, source.'],
            ['session_activated', 'event', 'A pending sub-user finished provisioning and is now live. data: credential_id, label, gb_allocated, status.'],
            ['session_deleted', 'event', 'A sub-user was deleted. data: credential_id, label, gb_allocated, gb_used, gb_released, source.'],
            ['session_topped_up', 'event', 'GB were added to a sub-user (manual top-up). data: credential_id, label, gb_added, gb_allocated, source.'],
            ['session_released', 'event', 'Unused GB were returned from a sub-user to your balance (the /release endpoint or the dashboard). data: credential_id, label, gb_released, gb_allocated, source.'],
            ['session_low', 'event', 'A sub-user has used 80% or 95% of its allocation (sent once per tier; not sent while auto-topup is able to refill it). data: credential_id, label, threshold_pct, used_pct, gb_allocated, gb_used, gb_remaining.'],
            ['session_exhausted', 'event', 'A single sub-user used its entire allocation and has stopped connecting (sent once per exhaustion; not sent while auto-topup is able to refill it — it IS sent if auto-topup is on but your balance cannot fund it). data: credential_id, label, gb_allocated, gb_used.'],
            ['auto_topup_triggered', 'event', 'Auto-topup added bandwidth. data: credential_id, gb_added, gb_allocated, partial (true when your balance could only cover part of the configured amount).'],
            ['auto_topup_failed', 'event', 'Auto-topup could not fully run (sent once until it recovers). reason is insufficient_balance, partial_funding or session_limit. data: credential_id, reason, gb_allocated, gb_used, amount_gb (and gb_added for partial_funding).'],
            ['session_suspended', 'event', 'GlobProxy suspended a sub-user (abuse or policy action). data: credential_id, label.'],
            ['session_resumed', 'event', 'A suspended sub-user was re-enabled. data: credential_id, label.'],
            ['bandwidth_threshold_crossed', 'event', 'The share of your account that is COMMITTED (allocated into sub-users) crossed 80% or 95%. data: threshold_pct, allocated_pct (what triggers it), used_pct (GB actually consumed ÷ total), available_gb, total_gb, used_gb, allocated_gb. Checked every 5 minutes. Endpoints that do not also subscribe to bandwidth_exhausted get it once more at 100% (threshold_pct 100). (used_pct used to carry the allocated figure; it now means what it says.)'],
            ['bandwidth_exhausted', 'event', 'Available (unallocated) bandwidth reached zero. data: allocated_pct, used_pct, available_gb, total_gb, used_gb, allocated_gb.'],
            ['bandwidth_credited', 'event', 'Bandwidth was added to the account. data: gb_credited, source ("purchase", "reseller_allocation", "referral_bonus" or "admin_adjustment"), plus order_id and amount_usd for purchases, transfer_id for allocations, role ("referrer" / "referred") for referral bonuses.'],
            ['bandwidth_debited', 'event', 'Unallocated bandwidth was removed from the account by a support adjustment. data: gb_debited, source ("admin_adjustment"), total_gb, available_gb. Refund clawbacks arrive as bandwidth_refunded and reseller reclaims as bandwidth_reclaimed.'],
            ['bandwidth_allocated', 'event', 'You allocated bandwidth to a client (resellers). data: transfer_id, recipient_email, gb, note.'],
            ['bandwidth_reclaimed', 'event', 'Unused bandwidth was reclaimed from your account by the reseller who allocated it. data: transfer_id, gb_reclaimed, gb_remaining.'],
            ['bandwidth_refunded', 'event', 'A purchase was refunded and its bandwidth taken back. data: order_id, refund_usd, gb_clawed_back, gb_not_recoverable, fully_refunded.'],
            ['api_key_created', 'event', 'An API key was created (or rotated). data: key_id, label, key_prefix, scopes, expires_at, plus rotated_from (the replaced key\'s id) when it came from a rotation.'],
            ['api_key_revoked', 'event', 'An API key was revoked, including an old key revoked immediately by a rotation with no grace window. data: key_id, label, key_prefix, plus reason ("rotated") and replaced_by for rotations.'],
            ['api_key_expiring', 'event', 'An API key expires within 7 days. data: key_id, label, key_prefix, expires_at.'],
          ]} />
          <p className="text-sm text-ink2 leading-relaxed mt-3">The same catalog, with each event's data keys, is machine-readable at <span className="font-mono text-ink">GET /api/v1/webhooks/events</span>.</p>

          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-5 mb-1.5">Payload</p>
          <Code>{`POST https://your-server.com/hooks/globproxy
Content-Type: application/json
X-GlobProxy-Event: session_created
X-GlobProxy-Event-Id: 6f1c2d84-...        (same id on every retry — use it to de-duplicate)
X-GlobProxy-Delivery: 0a9b...             (this delivery's id)
X-GlobProxy-Timestamp: 1760780000
X-GlobProxy-Signature-V2: t=1760780000,v1=3c5e...
X-GlobProxy-Signature: 9d41...            (legacy: HMAC of the body alone)
X-GlobProxy-Signature-V2-Previous: t=...,v1=...   (only during a secret-rotation grace window — see below)

{
  "id": "6f1c2d84-...",
  "event": "session_created",
  "created_at": "2026-10-18T09:30:00.000Z",
  "data": { "credential_id": "3f1a...", "gb_allocated": 5, "status": "active", "source": "api" }
}`}</Code>

          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-5 mb-1.5">Verifying the signature</p>
          <p className="text-sm text-ink2 leading-relaxed mb-3">
            Compute HMAC-SHA256 with your endpoint's secret (<span className="font-mono text-ink">whsec_…</span>) over{' '}
            <span className="font-mono text-ink">{`\`${'${t}'}.${'${rawBody}'}\``}</span> using the <em>raw, unparsed</em> request body, compare it to{' '}
            <span className="font-mono text-ink">v1</span> in constant time, and reject timestamps more than ~5 minutes old.
          </p>
          <Code>{`// Node.js
import crypto from 'node:crypto'

function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')))
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false      // replay window
  const expected = crypto.createHmac('sha256', secret).update(\`\${parts.t}.\${rawBody}\`).digest('hex')
  return expected.length === parts.v1.length &&
         crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))
}`}</Code>
          <Code>{`# Python
import hmac, hashlib, time

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{parts['t']}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])`}</Code>

          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-5 mb-1.5">Delivery, retries and auto-disable</p>
          <ul className="text-sm text-ink2 leading-relaxed space-y-1.5 list-disc list-inside">
            <li>Respond with any <span className="font-mono text-ink">2xx</span> within 8 seconds. Anything else (or a timeout) is a failed attempt.</li>
            <li>Failed deliveries are retried after about 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours (6 attempts total), then marked failed. Delivery is at-least-once — de-duplicate on <span className="font-mono text-ink">id</span>.</li>
            <li>Redirects are never followed. A <span className="font-mono text-ink">410 Gone</span> response disables the endpoint immediately; so do 50 consecutive failed attempts — you'll get an email, and re-enabling the endpoint resets the counter.</li>
            <li>The delivery log (status, attempts, response code, error, the first 500 characters of your endpoint's response, and the exact event body that was sent) is kept for 14 days; failed events can be redelivered from it. Redelivering an event that is still waiting on its automatic retries does not cancel them.</li>
            <li>Error messages in the log are deliberately generic ("Timed out", "Could not connect to the endpoint"). New or edited endpoint URLs must use the default HTTPS port (443) or 8443.</li>
            <li><strong>Rotating the secret:</strong> by default the old secret stops working immediately (right if it leaked). Pass <span className="font-mono text-ink">grace_minutes</span> (up to 4320) and, until it elapses, each delivery also carries <span className="font-mono text-ink">X-GlobProxy-Signature-V2-Previous</span> — the same signature made with the <em>previous</em> secret — so receivers can be switched over without dropping events: accept either header's signature during the window.</li>
          </ul>

          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-5 mb-1.5">Managing webhooks over the API</p>
          <Table rows={[
            ['GET /api/v1/webhooks', 'read', 'List endpoints (the secret is never listed).'],
            ['POST /api/v1/webhooks', 'write', 'Body: url, event_types[], description?. Returns the secret once.'],
            ['GET / PATCH / DELETE /api/v1/webhooks/:id', 'read / write', 'PATCH accepts url, event_types, description, enabled.'],
            ['POST /api/v1/webhooks/:id/test', 'write', 'Sends a signed "test" event now (one per 10 seconds per account).'],
            ['POST /api/v1/webhooks/:id/rotate-secret', 'write', 'Issues a new secret (returned once). Body (optional): grace_minutes 0–4320 — keep the old secret signing the -Previous header for that long. Default: the old secret stops immediately.'],
            ['GET /api/v1/webhooks/events', 'read', 'The event catalog: every subscribable event with its description and data keys.'],
            ['GET /api/v1/webhooks/:id/deliveries', 'read', 'Delivery log, newest first. Optional limit (max 100), status (succeeded | retrying | failed) and before and before_id (cursor — pass next_before and next_before_id when has_more is true).'],
            ['GET /api/v1/webhooks/:id/deliveries/:deliveryId', 'read', 'One delivery in full: the exact event body (payload) and your endpoint\'s response_body (first 500 characters).'],
            ['POST /api/v1/webhooks/:id/deliveries/:deliveryId/redeliver', 'write', 'Re-sends a stored event (same id and body, fresh signature).'],
          ]} />
          <Code>{`curl -X POST https://globproxy.com/api/v1/webhooks \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "url": "https://example.com/hooks/globproxy", "event_types": ["session_created", "session_activated", "bandwidth_exhausted"] }'`}</Code>
        </section>

        {/* Targeting reference */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-3">Geo-targeting reference</h2>
          <p className="text-sm text-ink2 leading-relaxed mb-3">
            Targeting is encoded directly in <span className="font-mono text-ink">connection_username</span>, in a
            fixed order: type, country, state and/or city, asn, then (sticky sessions only) lifetime and session id.
          </p>
          <Table rows={[
            ['country', '2-letter ISO code, lowercase', 'Required if state, city, or asn is set.'],
            ['state / city', 'lowercase, no spaces or punctuation', 'Both can be set together — they are not mutually exclusive.'],
            ['asn', 'numeric string', 'e.g. "13868".'],
          ]} />
          <p className="text-sm text-ink2 leading-relaxed mt-2">
            Invalid values (wrong length, disallowed characters) get rejected with a{' '}
            <span className="font-mono text-ink">400</span> at creation time rather than silently dropped or
            passed through.
          </p>
          <p className="text-xs font-mono text-muted uppercase tracking-wider mt-5 mb-1.5">Ports by protocol / session type</p>
          <Table rows={[
            ['http, rotating', '9000', ''],
            ['http, sticky', '10000', ''],
            ['socks5, rotating', '11000', ''],
            ['socks5, sticky', '12000', ''],
          ]} />
        </section>

        <div className="border-t border-border pt-8">
          <p className="text-sm text-ink2">
            Already have access? Manage your keys from{' '}
            <Link href="/dashboard/api-keys" className="text-accent hover:underline">API Keys</Link> in your dashboard.
            Questions not covered here — <a href="mailto:support@globproxy.com" className="text-accent hover:underline">support@globproxy.com</a>.
          </p>
        </div>
      </div>
    </>
  )
}
