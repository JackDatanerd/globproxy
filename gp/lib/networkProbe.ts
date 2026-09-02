// Uses node:net rather than importing 'cloudflare:sockets' directly.
// This project already runs with the nodejs_compat compatibility flag
// (see wrangler.jsonc), and Cloudflare's own docs are explicit that in
// that mode, node:net's Socket is the documented, supported way to open
// a raw TCP connection — net.Socket is a wrapper around the same
// cloudflare:sockets connect() functionality underneath, but resolves
// correctly through the Node-compat module layer this app's OpenNext
// "cloudflare-node" wrapper runs under, where a direct dynamic import of
// 'cloudflare:sockets' does not (confirmed: it threw "Cannot find
// module 'cloudflare:sockets'" at runtime in production, despite
// building cleanly — the build succeeding was never proof the import
// would actually resolve at request time in this specific wrapper mode).
import net from 'node:net'

// Neutral, single-purpose reachability targets — dedicated IP-echo/diagnostic
// services, not commercial sites with anti-bot systems. Deliberately kept to
// two, low request-per-target volume (see REQUESTS_PER_TARGET below), and
// plain HTTP rather than HTTPS: an HTTP proxy relays a plain HTTP request
// directly (absolute-URI request line), so this needs a raw TCP write/read
// and nothing else — no CONNECT tunnel, no TLS handshake to reimplement.
// That's a deliberate scope cut to keep this first version something we
// can actually be confident is correct, not a full HTTPS-through-proxy
// test harness.
const PROBE_TARGETS: { label: string; host: string; path: string }[] = [
  { label: 'General reachability', host: 'icanhazip.com', path: '/' },
  { label: 'Proxy exit confirmation', host: 'api.ipify.org', path: '/' },
]

const REQUESTS_PER_TARGET = 5
const SOCKET_TIMEOUT_MS = 8000

function probeOnce(
  proxyHost: string,
  proxyPort: number,
  proxyAuthB64: string,
  target: { host: string; path: string }
): Promise<{ ok: boolean; latencyMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = new net.Socket()
    let settled = false
    let buffer = ''

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok, latencyMs: Date.now() - started })
    }

    socket.setTimeout(SOCKET_TIMEOUT_MS)
    socket.on('timeout', () => finish(false))
    socket.on('error', () => finish(false))
    socket.on('close', () => finish(false)) // closed before headers ever arrived

    socket.connect(proxyPort, proxyHost, () => {
      // Standard "HTTP proxy forward request" form: absolute-URI in the
      // request line, sent straight to the proxy — this is what tells an
      // HTTP proxy (as opposed to an origin server) to relay the request,
      // no CONNECT needed since the target is plain HTTP.
      const request =
        `GET http://${target.host}${target.path} HTTP/1.1\r\n` +
        `Host: ${target.host}\r\n` +
        `Proxy-Authorization: Basic ${proxyAuthB64}\r\n` +
        `Connection: close\r\n\r\n`
      socket.write(request)
    })

    socket.on('data', (chunk: Buffer) => {
      // Headers are all we need for a pass/fail + latency signal — no
      // reason to wait for the full body of an already-successful response.
      buffer += chunk.toString('utf-8')
      if (buffer.includes('\r\n\r\n')) {
        const statusLine = buffer.split('\r\n')[0] ?? ''
        const statusMatch = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/)
        const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0
        finish(statusCode >= 200 && statusCode < 400)
      }
    })
  })
}

export type BenchmarkTargetResult = {
  label: string
  successRate: number
  avgLatencyMs: number | null
  sampleSize: number
}

// Runs REQUESTS_PER_TARGET probes against each target, through the given
// HTTP proxy credentials, and returns aggregated per-target results. Caller
// (runConfiguredBenchmark below) is responsible for writing these into
// network_benchmarks and for everything upstream of "we have a working
// http proxy credential to test with" (protocol check, active-status
// check, etc).
export async function runNetworkProbe(
  proxyHost: string,
  proxyPort: number,
  proxyUsername: string,
  proxyPassword: string
): Promise<BenchmarkTargetResult[]> {
  const auth = btoa(`${proxyUsername}:${proxyPassword}`)
  const results: BenchmarkTargetResult[] = []

  for (const target of PROBE_TARGETS) {
    let successes = 0
    let totalLatencyMs = 0

    for (let i = 0; i < REQUESTS_PER_TARGET; i++) {
      const { ok, latencyMs } = await probeOnce(proxyHost, proxyPort, auth, target)
      if (ok) {
        successes++
        totalLatencyMs += latencyMs
      }
    }

    results.push({
      label: target.label,
      successRate: (successes / REQUESTS_PER_TARGET) * 100,
      avgLatencyMs: successes > 0 ? Math.round(totalLatencyMs / successes) : null,
      sampleSize: REQUESTS_PER_TARGET,
    })
  }

  return results
}

// ── Full configured-benchmark flow ──────────────────────────────────
// Shared by the cron 'benchmark' task and the admin "test now" button —
// both need the exact same read-config → validate-credential → probe →
// write-rows sequence, and having two copies of the validation logic
// drift apart over time is exactly how a "works when I test it" bug
// gets into an unattended cron job. `supabase` is passed in rather than
// created here since callers already have their own admin client.
type SupabaseAdminClient = {
  from: (table: string) => any
}

export type BenchmarkRunResult =
  | { action: 'skipped'; reason: string }
  | { action: 'ran'; targets: BenchmarkTargetResult[] }

export async function runConfiguredBenchmark(supabase: SupabaseAdminClient): Promise<BenchmarkRunResult> {
  const { data: setting } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'benchmark_credential_id')
    .single()

  if (!setting?.value) {
    return { action: 'skipped', reason: 'benchmark_credential_id not configured — pick one below' }
  }

  const { data: cred } = await supabase
    .from('proxy_credentials')
    .select('host, port, protocol, geonode_username, geonode_password, status, gb_allocated, gb_used')
    .eq('id', setting.value)
    .single()

  if (!cred) return { action: 'skipped', reason: 'configured benchmark_credential_id does not exist' }
  if (cred.status !== 'active') return { action: 'skipped', reason: `benchmark credential is not active (status: ${cred.status})` }
  if (cred.protocol !== 'http') return { action: 'skipped', reason: `benchmark credential uses ${cred.protocol} — only http proxy probing is implemented so far` }
  if (!cred.geonode_username || !cred.geonode_password) return { action: 'skipped', reason: 'benchmark credential is missing proxy auth' }
  // Guard against ever burning through the credential's whole allocation
  // on probe traffic alone — these requests are tiny (a few hundred
  // bytes each) but this keeps a runaway retry loop or a misconfigured
  // schedule from being able to silently eat the budget set aside for
  // this.
  if (Number(cred.gb_used) >= Number(cred.gb_allocated)) {
    return { action: 'skipped', reason: 'benchmark credential has exhausted its allocated GB' }
  }

  const results = await runNetworkProbe(cred.host, cred.port, cred.geonode_username, cred.geonode_password)

  for (const r of results) {
    await supabase.from('network_benchmarks').insert({
      target_label: r.label,
      success_rate: r.successRate,
      avg_latency_ms: r.avgLatencyMs,
      sample_size: r.sampleSize,
    })
  }

  return { action: 'ran', targets: results }
}
