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
const PROBE_TARGETS: { label: string; host: string; path: string; expectExitIp: boolean }[] = [
  { label: 'General reachability', host: 'icanhazip.com', path: '/', expectExitIp: false },
  // expectExitIp: this target's label promises "exit confirmation", so it
  // must actually prove the request left through the proxy. It used to pass
  // on the HTTP status line alone — a proxy failing open (or any server
  // answering 200) scored 100%. Now the body must be an IP address that
  // differs from the one a DIRECT request from this Worker reports.
  { label: 'Proxy exit confirmation', host: 'api.ipify.org', path: '/', expectExitIp: true },
]

const REQUESTS_PER_TARGET = 5
const SOCKET_TIMEOUT_MS = 8000
const IPV4_IN_TEXT = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/

function probeOnce(
  proxyHost: string,
  proxyPort: number,
  proxyAuthB64: string,
  target: { host: string; path: string; expectExitIp: boolean },
  directIp: string | null
): Promise<{ ok: boolean; latencyMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = new net.Socket()
    let settled = false
    let buffer = ''
    let headersParsed = false
    let statusOk = false
    let headerLatencyMs: number | null = null

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      // Latency is time-to-headers, not time-to-body.
      resolve({ ok, latencyMs: headerLatencyMs ?? Date.now() - started })
    }

    // Returns true once a verdict was reached.
    const judgeBody = (final: boolean): boolean => {
      const idx = buffer.indexOf('\r\n\r\n')
      const body = idx === -1 ? '' : buffer.slice(idx + 4)
      const m = body.match(IPV4_IN_TEXT)
      if (m) {
        // Exit IP must differ from the Worker's own direct egress IP (when known).
        finish(directIp === null || m[0] !== directIp)
        return true
      }
      if (final) { finish(false); return true }
      return false
    }

    socket.setTimeout(SOCKET_TIMEOUT_MS)
    socket.on('timeout', () => finish(false))
    socket.on('error', () => finish(false))
    socket.on('close', () => {
      if (settled) return
      if (headersParsed && statusOk && target.expectExitIp) judgeBody(true)
      else finish(false) // closed before an acceptable response arrived
    })

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
      buffer += chunk.toString('utf-8')
      if (!headersParsed && buffer.includes('\r\n\r\n')) {
        headersParsed = true
        headerLatencyMs = Date.now() - started
        const statusLine = buffer.split('\r\n')[0] ?? ''
        const statusMatch = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/)
        const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0
        statusOk = statusCode >= 200 && statusCode < 400
        if (!statusOk) { finish(false); return }
        if (!target.expectExitIp) { finish(true); return }
      }
      if (headersParsed && statusOk && target.expectExitIp) judgeBody(false)
    })
  })
}

// What a direct (non-proxied) request from this Worker reports as its own
// public IP — the baseline the exit IP must differ from. null if it can't be
// determined; the probe then only requires that the body is a valid IP.
async function fetchDirectIp(): Promise<string | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    try {
      const res = await fetch('https://api.ipify.org', { signal: ctrl.signal })
      if (!res.ok) return null
      const text = await res.text()
      return text.match(IPV4_IN_TEXT)?.[0] ?? null
    } finally {
      clearTimeout(t)
    }
  } catch {
    return null
  }
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
  const directIp = PROBE_TARGETS.some(t => t.expectExitIp) ? await fetchDirectIp() : null

  // Targets run in parallel (each target's own requests stay sequential so
  // load per target is unchanged). Sequentially the worst case was 10 probes
  // x 8 s = 80 s inside one cron invocation; this halves it.
  return Promise.all(
    PROBE_TARGETS.map(async (target): Promise<BenchmarkTargetResult> => {
      let successes = 0
      let totalLatencyMs = 0
      for (let i = 0; i < REQUESTS_PER_TARGET; i++) {
        const { ok, latencyMs } = await probeOnce(proxyHost, proxyPort, auth, target, directIp)
        if (ok) {
          successes++
          totalLatencyMs += latencyMs
        }
      }
      return {
        label: target.label,
        successRate: (successes / REQUESTS_PER_TARGET) * 100,
        avgLatencyMs: successes > 0 ? Math.round(totalLatencyMs / successes) : null,
        sampleSize: REQUESTS_PER_TARGET,
      }
    })
  )
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
    .select('host, port, protocol, upstream_username, upstream_password, status, gb_allocated, gb_used')
    .eq('id', setting.value)
    .single()

  if (!cred) return { action: 'skipped', reason: 'configured benchmark_credential_id does not exist' }
  if (cred.status !== 'active') return { action: 'skipped', reason: `benchmark credential is not active (status: ${cred.status})` }
  if (cred.protocol !== 'http') return { action: 'skipped', reason: `benchmark credential uses ${cred.protocol} — only http proxy probing is implemented so far` }
  if (!cred.upstream_username || !cred.upstream_password) return { action: 'skipped', reason: 'benchmark credential is missing proxy auth' }
  // Guard against ever burning through the credential's whole allocation
  // on probe traffic alone — these requests are tiny (a few hundred
  // bytes each) but this keeps a runaway retry loop or a misconfigured
  // schedule from being able to silently eat the budget set aside for
  // this.
  if (Number(cred.gb_used) >= Number(cred.gb_allocated)) {
    return { action: 'skipped', reason: 'benchmark credential has exhausted its allocated GB' }
  }

  const results = await runNetworkProbe(cred.host, cred.port, cred.upstream_username, cred.upstream_password)

  for (const r of results) {
    const { error } = await supabase.from('network_benchmarks').insert({
      target_label: r.label,
      success_rate: r.successRate,
      avg_latency_ms: r.avgLatencyMs,
      sample_size: r.sampleSize,
    })
    // Previously unchecked — a failing insert still reported 'ran'.
    if (error) console.error('[benchmark] failed to record result for', r.label, error)
  }

  return { action: 'ran', targets: results }
}
