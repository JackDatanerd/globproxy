// No top-level `import ... from 'cloudflare:sockets'`, and the dynamic
// import below uses a variable rather than a string literal, on purpose:
// three separate build stages in this pipeline (webpack's compile,
// Next's build-time page-data collection, and OpenNext's own esbuild
// bundle of the Worker) each tried to statically resolve/bundle a literal
// 'cloudflare:sockets' specifier and failed, since it's a Workers-runtime
// module that doesn't exist as a real package. None of the three expose a
// config hook to mark just this one specifier external (esbuild's own
// external list here is hardcoded inside @opennextjs/cloudflare, not
// exposed via open-next.config.ts). A variable specifier is the standard
// way around this: neither webpack nor esbuild statically analyze a
// dynamic import() whose argument isn't a string literal, so it's left
// alone as a genuine runtime import — which is exactly what's needed,
// since 'cloudflare:sockets' does resolve correctly once this code is
// actually running inside the Worker.
const CLOUDFLARE_SOCKETS_MODULE = 'cloudflare:sockets'
type CloudflareSockets = typeof import('cloudflare:sockets')

// Neutral, single-purpose reachability targets — dedicated IP-echo/diagnostic
// services, not commercial sites with anti-bot systems. Deliberately kept to
// two, low request-per-target volume (see REQUESTS_PER_TARGET below), and
// plain HTTP rather than HTTPS: an HTTP proxy relays a plain HTTP request
// directly (absolute-URI request line), so this needs a raw TCP write/read
// over the Workers `connect()` socket and nothing else — no CONNECT tunnel,
// no TLS handshake to reimplement. That's a deliberate scope cut to keep this
// first version something we can actually be confident is correct, not a
// full HTTPS-through-proxy test harness.
const PROBE_TARGETS: { label: string; host: string; path: string }[] = [
  { label: 'General reachability', host: 'icanhazip.com', path: '/' },
  { label: 'Proxy exit confirmation', host: 'api.ipify.org', path: '/' },
]

const REQUESTS_PER_TARGET = 5
const SOCKET_TIMEOUT_MS = 8000

async function probeOnce(
  connect: CloudflareSockets['connect'],
  proxyHost: string,
  proxyPort: number,
  proxyAuthB64: string,
  target: { host: string; path: string }
): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now()
  let socket
  try {
    socket = connect({ hostname: proxyHost, port: proxyPort })

    const writer = socket.writable.getWriter()
    const reader = socket.readable.getReader()

    // Standard "HTTP proxy forward request" form: absolute-URI in the
    // request line, sent straight to the proxy — this is what tells an
    // HTTP proxy (as opposed to an origin server) to relay the request,
    // no CONNECT needed since the target is plain HTTP.
    const request =
      `GET http://${target.host}${target.path} HTTP/1.1\r\n` +
      `Host: ${target.host}\r\n` +
      `Proxy-Authorization: Basic ${proxyAuthB64}\r\n` +
      `Connection: close\r\n\r\n`

    await writer.write(new TextEncoder().encode(request))
    writer.releaseLock()

    const readHeaders = (async () => {
      let received = ''
      const decoder = new TextDecoder()
      // Headers are all we need for a pass/fail + latency signal — no
      // reason to wait for the full body of an already-successful response.
      while (!received.includes('\r\n\r\n')) {
        const { value, done } = await reader.read()
        if (done) break
        received += decoder.decode(value, { stream: true })
      }
      return received
    })()

    const timeout = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('probe timeout')), SOCKET_TIMEOUT_MS)
    )

    const result = await Promise.race([readHeaders, timeout])
    const statusLine = result.split('\r\n')[0] ?? ''
    const statusMatch = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/)
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0

    reader.releaseLock()
    await socket.close().catch(() => {})

    return { ok: statusCode >= 200 && statusCode < 400, latencyMs: Date.now() - started }
  } catch {
    await socket?.close().catch(() => {})
    return { ok: false, latencyMs: Date.now() - started }
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
// (runBenchmark in the cron route) is responsible for writing these into
// network_benchmarks and for everything upstream of "we have a working http
// proxy credential to test with" (protocol check, active-status check, etc).
export async function runNetworkProbe(
  proxyHost: string,
  proxyPort: number,
  proxyUsername: string,
  proxyPassword: string
): Promise<BenchmarkTargetResult[]> {
  const { connect } = await import(CLOUDFLARE_SOCKETS_MODULE) as CloudflareSockets
  const auth = btoa(`${proxyUsername}:${proxyPassword}`)
  const results: BenchmarkTargetResult[] = []

  for (const target of PROBE_TARGETS) {
    let successes = 0
    let totalLatencyMs = 0

    for (let i = 0; i < REQUESTS_PER_TARGET; i++) {
      const { ok, latencyMs } = await probeOnce(connect, proxyHost, proxyPort, auth, target)
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
