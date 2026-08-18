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
            Keys carry the permissions of the account that created them; there's currently no way to scope a
            key to a subset of actions.
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
            Errors are JSON with a single <span className="font-mono text-ink">error</span> string describing
            what went wrong. There's no machine-readable error code beyond the HTTP status — match on status
            first, message second (messages may be reworded over time).
          </p>
          <Table rows={[
            ['400', 'Bad Request', 'Missing or invalid parameters — see the error message for which one.'],
            ['401', 'Unauthorized', 'Missing, malformed, or revoked API key.'],
            ['402', 'Payment Required', 'Not enough bandwidth in your account for the request (sub-user creation).'],
            ['403', 'Forbidden', 'Account suspended, or API access not enabled on this account.'],
            ['404', 'Not Found', "The resource doesn't exist, or doesn't belong to your account."],
            ['409', 'Conflict', 'A pending request/state already exists (used outside v1 — see the dashboard-side apply endpoints).'],
            ['500', 'Internal Server Error', "Something went wrong on our end — safe to retry once; open a support ticket if it persists."],
          ]} />
        </section>

        {/* Rate limits */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-3">Rate limits</h2>
          <p className="text-sm text-ink2 leading-relaxed">
            There's no hard rate limit on the v1 endpoints today. Treat your key like a password
            regardless — never expose it in client-side JavaScript, a public repo, or a mobile app bundle;
            proxy calls to it through your own backend if you need to trigger them from a browser or app.
          </p>
        </section>

        {/* Endpoints */}
        <section className="mb-10">
          <h2 className="font-display font-bold text-xl text-ink mb-5">Endpoints</h2>

          <Endpoint method="GET" path="/api/v1/account/bandwidth" title="Bandwidth balance">
            <p className="text-sm text-ink2 mb-4">Your account's overall bandwidth balance — not per sub-user, see the usage endpoint below for that.</p>
            <Code>{`curl https://globproxy.com/api/v1/account/bandwidth \\
  -H "Authorization: Bearer YOUR_KEY"`}</Code>
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response</p>
            <Code>{`{
  "total_gb": 500,
  "used_gb": 128.4,
  "available_gb": 371.6,
  "expires": "never"
}`}</Code>
          </Endpoint>

          <Endpoint method="GET" path="/api/v1/sub-users" title="List sub-users">
            <p className="text-sm text-ink2 mb-4">All proxy credentials (sub-users) on your account, newest first.</p>
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
      "country": "us",
      "state": "california",
      "city": null,
      "asn": null,
      "session_type": "rotating",
      "protocol": "http",
      "sticky_duration": null,
      "host": "proxy.globproxy.com",
      "port": 9000,
      "geonode_username": "geonode_xxx",
      "connection_username": "geonode_xxx-type-residential-country-us-state-california",
      "activated_at": "2026-08-01T12:00:00.000Z",
      "created_at": "2026-08-01T12:00:00.000Z"
    }
  ]
}`}</Code>
            <p className="text-sm text-ink2 mt-4">
              Use <span className="font-mono text-ink">connection_username</span> (not{' '}
              <span className="font-mono text-ink">geonode_username</span>) as the proxy username — it has your
              targeting baked in. For a sticky session, generate a fresh <span className="font-mono text-ink">-session-*</span>{' '}
              suffix per connection rather than reusing this one indefinitely; that logic lives client-side, this
              endpoint just returns the base credential.
            </p>
          </Endpoint>

          <Endpoint method="POST" path="/api/v1/sub-users" title="Create sub-user">
            <p className="text-sm text-ink2 mb-4">
              Creates a new proxy credential and reserves the requested bandwidth from your account balance
              atomically — a burst of concurrent creates can't oversubscribe your balance.
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
              ['gb_allocated', 'number', 'Required. Bandwidth to reserve for this sub-user, must be > 0.'],
              ['label', 'string', 'Optional. Your own name for this credential.'],
              ['country', 'string', '2-letter ISO code (e.g. "us"). Required if state, city, or asn is set.'],
              ['state', 'string', 'Lowercase, no spaces/punctuation. Requires country.'],
              ['city', 'string', 'Lowercase, no spaces/punctuation. Requires country. state and city can both be set together.'],
              ['asn', 'string | number', 'Numeric ASN, e.g. "13868".'],
              ['session_type', 'string', '"rotating" (default) or "sticky".'],
              ['protocol', 'string', '"http" (default) or "socks5".'],
              ['sticky_duration', 'number', 'Minutes the sticky session stays on the same peer. Only used when session_type is "sticky". Default 10.'],
              ['endpoint_count', 'number', 'Informational — how many endpoints you intend to generate from this credential. Default 1.'],
            ]} />
            <p className="text-xs font-mono text-muted uppercase tracking-wider mt-4 mb-1.5">Response — 201 Created</p>
            <Code>{`{
  "id": "3f1a...",
  "label": "Client A",
  "status": "active",
  "host": "proxy.globproxy.com",
  "port": 9000,
  "username": "geonode_xxx",
  "connection_username": "geonode_xxx-type-residential-country-us-state-california",
  "gb_allocated": 5,
  "country": "us"
}`}</Code>
            <p className="text-sm text-ink2 mt-4">
              <span className="font-mono text-ink">status</span> can come back{' '}
              <span className="font-mono text-ink">"pending"</span> instead of{' '}
              <span className="font-mono text-ink">"active"</span> if the upstream provisioning step is briefly
              unavailable — the credential and bandwidth reservation are still created, it just activates shortly
              after rather than instantly. Poll the sub-user via the list endpoint if you need to confirm it's live
              before using it.
            </p>
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
  "username": "geonode_xxx"
}`}</Code>
          </Endpoint>
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
