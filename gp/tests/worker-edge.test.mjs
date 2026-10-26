// Runs the REAL custom-worker.ts (bundled with esbuild, which wrangler already depends on)
// against a stub app handler and an in-memory Cache, so the edge-cache, stale-while-
// revalidate, session-refresh brake and API guard behaviour is exercised end to end
// without the Workers runtime.
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../custom-worker.ts', import.meta.url))
const bundled = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
  plugins: [{
    name: 'stub-open-next',
    setup(b) {
      b.onResolve({ filter: /\.open-next\/worker\.js$/ }, () => ({ path: 'app-stub', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { fetch: (...a) => globalThis.__app(...a) }', loader: 'js' }))
    },
  }],
})
const worker = (await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))).default

// ── harness ────────────────────────────────────────────────────────────────
let now = 1_800_000_000_000
const realNow = Date.now
Date.now = () => now

class MemCache {
  store = new Map()
  async match(req) {
    const e = this.store.get(req.url)
    return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined
  }
  async put(req, res) {
    this.store.set(req.url, { status: res.status, headers: [...res.headers], body: await res.text() })
  }
}

function harness({ limiter } = {}) {
  const cache = new MemCache()
  globalThis.caches = { default: cache }
  const calls = { app: 0, limiter: [], cookies: [], bodies: [] }
  let gate = null
  globalThis.__app = async (req) => {
    calls.app++
    calls.cookies.push(req.headers.get('cookie'))
    calls.bodies.push(req.method === 'GET' ? null : await req.clone().text())
    if (gate) await gate
    if (globalThis.__appResponse) return globalThis.__appResponse(req)
    return new Response(`<html>render ${calls.app}</html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  const pending = []
  const ctx = { waitUntil: (p) => { pending.push(p) } }
  // waitUntil work can queue MORE waitUntil work (a background refresh stores its copy
  // through another one), so drain until nothing new has been added.
  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r))
      if (!pending.length) return
      await Promise.all(pending.splice(0))
    }
  }
  const env = {
    CF_VERSION_METADATA: { id: 'v1' },
    NEXT_PUBLIC_APP_URL: 'https://globproxy.com',
    ...(limiter ? { SESSION_REFRESH_RATE_LIMITER: { limit: async ({ key }) => { calls.limiter.push(key); return { success: limiter.allow } } } } : {}),
  }
  return {
    cache, calls, env, ctx,
    hold() { let open; gate = new Promise((r) => { open = r }); return () => { gate = null; open() } },
    async get(path, headers = {}) {
      const res = await worker.fetch(new Request('https://globproxy.com' + path, { headers }), env, ctx)
      await drain()
      return res
    },
    async send(path, init) {
      const res = await worker.fetch(new Request('https://globproxy.com' + path, init), env, ctx)
      await drain()
      return res
    },
    settle: drain,
  }
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url')
const sessionCookie = (expiresInS) => `sb-abc-auth-token=base64-${b64url(JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', expires_at: Math.floor(now / 1000) + expiresInS }))}`

test.after(() => { Date.now = realNow })

// ── edge cache ─────────────────────────────────────────────────────────────
test('anonymous page: MISS then HIT, and the browser is told not to keep it', async () => {
  const h = harness()
  const a = await h.get('/privacy')
  assert.equal(a.headers.get('x-edge-cache'), 'MISS')
  const b = await h.get('/privacy')
  assert.equal(b.headers.get('x-edge-cache'), 'HIT')
  assert.equal(h.calls.app, 1)
  assert.match(b.headers.get('cache-control'), /no-cache/)
  assert.equal(b.headers.has('x-edge-stored-at'), false, 'the internal stamp never leaves the Worker')
})

test('a visitor carrying only referral cookies shares the cached copy; a signed-in one never does', async () => {
  const h = harness()
  await h.get('/')
  const referred = await h.get('/', { cookie: 'gp_ref=ABC123; gp_sub=x' })
  assert.equal(referred.headers.get('x-edge-cache'), 'HIT')
  assert.equal(h.calls.app, 1)
  const signedIn = await h.get('/', { cookie: sessionCookie(3600) })
  assert.equal(signedIn.headers.get('x-edge-cache'), null, 'bypasses the cache entirely')
  assert.equal(h.calls.app, 2)
  const withQuery = await h.get('/?ref=ABC')
  assert.equal(withQuery.headers.get('x-edge-cache'), null)
})

test('past the TTL a copy is served stale and refreshed ONCE in the background', async () => {
  const h = harness()
  await h.get('/blog')
  assert.equal(h.calls.app, 1)
  now += 301_000 // past the 300s TTL, inside the stale window

  const release = h.hold() // keep the background refresh in flight while more visitors arrive
  const responses = await Promise.all([1, 2, 3, 4].map(() => worker.fetch(new Request('https://globproxy.com/blog'), h.env, h.ctx)))
  for (const r of responses) {
    assert.equal(r.headers.get('x-edge-cache'), 'STALE', 'every visitor is served immediately from the stale copy')
    assert.match(await r.text(), /render 1/)
  }
  release()
  await h.settle()
  assert.equal(h.calls.app, 2, 'four concurrent visitors caused exactly one refresh render')

  const after = await h.get('/blog')
  assert.equal(after.headers.get('x-edge-cache'), 'HIT')
  assert.match(await after.text(), /render 2/)
  assert.equal(h.calls.app, 2)
})

test('a stale copy is labelled STALE and served without waiting for the render', async () => {
  const h = harness()
  await h.get('/terms')
  now += 400_000
  const release = h.hold()
  const res = await worker.fetch(new Request('https://globproxy.com/terms'), h.env, { waitUntil() {} })
  assert.equal(res.headers.get('x-edge-cache'), 'STALE')
  assert.match(await res.text(), /render 1/)
  release()
})

test('the /status page never serves a copy older than the TTL', async () => {
  const h = harness()
  await h.get('/status')
  now += 301_000
  const res = await h.get('/status')
  assert.equal(res.headers.get('x-edge-cache'), 'MISS', 'live health is re-rendered, not served stale')
  assert.equal(h.calls.app, 2)
})

test('beyond the stale window the copy is gone and the page renders again', async () => {
  const h = harness()
  await h.get('/refunds')
  now += 1_000_000
  const res = await h.get('/refunds')
  assert.equal(res.headers.get('x-edge-cache'), 'MISS')
})

// ── session-refresh brake ──────────────────────────────────────────────────
test('over budget, a PAGE carries on as an anonymous visitor; a plain API call is refused', async () => {
  const h = harness({ limiter: { allow: false } })
  const page = await h.get('/dashboard', { cookie: `gp_ref=A; ${sessionCookie(-60)}`, 'cf-connecting-ip': '203.0.113.9' })
  assert.equal(page.status, 200, 'not locked out of the page (a protected one redirects to sign-in)')
  assert.equal(h.calls.app, 1)
  assert.equal(h.calls.cookies[0], 'gp_ref=A', 'the stale session cookie is dropped, every other cookie kept')
  assert.deepEqual(h.calls.limiter, ['SESSION_REFRESH_RATE_LIMITER:203.0.113.9'])

  const api = await h.get('/api/dashboard/proxies', { cookie: sessionCookie(-60), 'cf-connecting-ip': '203.0.113.9' })
  assert.equal(api.status, 429)
  assert.equal(api.headers.get('retry-after'), '60')
  assert.equal((await api.json()).code, 'rate_limited')
  assert.equal(h.calls.app, 1, 'the refused API call never reached the app (and so Supabase)')
  assert.ok(api.headers.get('x-request-id'), 'the 429 carries a request id')
  assert.equal(api.headers.get('x-frame-options'), 'SAMEORIGIN')
})

test('cookies crafted to hide an expired session from the probe are still braked', async () => {
  const h = harness({ limiter: { allow: false } })
  h.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co'
  const expired = sessionCookie(-60).split('=').slice(1).join('=')
  const K = 'sb-abc-auth-token'
  const crafted = [
    `${K}=${expired}; ${K}.0=zzz`,
    `${K}.0=${expired}; ${K}.2=zzz`,
    `${K}=${sessionCookie(3000).split('=').slice(1).join('=')}; ${K}=${expired}`,
    `${K}=base64-${b64url(JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', expires_at: '1' }))}`,
  ]
  for (const cookie of crafted) {
    const res = await h.get('/api/dashboard/proxies', { cookie, 'cf-connecting-ip': '203.0.113.9' })
    assert.equal(res.status, 429, cookie.slice(0, 60))
  }
  assert.equal(h.calls.app, 0, 'none of them reached the app (and so Supabase Auth)')
})

test('over budget, sign-in requests still reach the app, body intact, without the stale session', async () => {
  const h = harness({ limiter: { allow: false } })
  const res = await h.send('/api/auth/login', {
    method: 'POST',
    headers: { cookie: sessionCookie(-60), 'cf-connecting-ip': '203.0.113.9', origin: 'https://globproxy.com', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.co' }),
  })
  assert.equal(res.status, 200)
  assert.equal(h.calls.app, 1)
  assert.equal(h.calls.cookies[0], null)
  assert.equal(h.calls.bodies[0], JSON.stringify({ email: 'a@b.co' }))
  const login = await h.get('/auth/login', { cookie: sessionCookie(-60), 'cf-connecting-ip': '203.0.113.9' })
  assert.equal(login.status, 200)
})

test('every /api answer carries X-Request-Id, a route\'s own is kept, a supplied one is honoured', async () => {
  const h = harness()
  const plain = await h.get('/api/health')
  assert.match(plain.headers.get('x-request-id'), /^req_[0-9a-f]{20}$/)
  const supplied = await h.get('/api/health', { 'x-request-id': 'my-trace:1' })
  assert.equal(supplied.headers.get('x-request-id'), 'my-trace:1')
  const bad = await h.get('/api/health', { 'x-request-id': 'bad id!' })
  assert.match(bad.headers.get('x-request-id'), /^req_/)
  globalThis.__appResponse = () => new Response('{}', { status: 200, headers: { 'x-request-id': 'req_route', 'cache-control': 'private, max-age=5' } })
  try {
    const own = await h.get('/api/v1/account')
    assert.equal(own.headers.get('x-request-id'), 'req_route')
    assert.equal(own.headers.get('cache-control'), 'private, max-age=5')
  } finally { delete globalThis.__appResponse }
  // pages are untouched
  assert.equal((await h.get('/privacy')).headers.has('x-request-id'), false)
})

test('the edge guard answers carry the request id the docs promise', async () => {
  const h = harness()
  const big = await h.send('/api/v1/sub-users', { method: 'POST', headers: { 'content-length': String(2 * 1024 * 1024), authorization: 'Bearer x' } })
  assert.equal(big.status, 413)
  assert.equal((await big.json()).code, 'payload_too_large')
  assert.match(big.headers.get('x-request-id'), /^req_/)
  const cross = await h.send('/api/dashboard/proxies', { method: 'POST', headers: { origin: 'https://evil.example' } })
  assert.equal(cross.status, 403)
  assert.ok(cross.headers.get('x-request-id'))
})

test('heartbeat: pinged after a fully OK 5-minute chain, never after a failing one, never for other schedules', async () => {
  const pings = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (u) => { pings.push(String(u)); return new Response('ok') }
  try {
    const run = async (cron, env, appStatus = 200) => {
      globalThis.__appResponse = () => new Response('{}', { status: appStatus, headers: { 'content-type': 'application/json' } })
      const pending = []
      await worker.scheduled({ cron }, { NEXT_PUBLIC_APP_URL: 'https://globproxy.com', CRON_SECRET: 's', ...env }, { waitUntil: (p) => pending.push(p) })
      await Promise.all(pending)
    }
    await run('*/5 * * * *', { HEARTBEAT_URL: 'https://hc.example/ping/abc' })
    assert.deepEqual(pings, ['https://hc.example/ping/abc'])
    await run('*/5 * * * *', { HEARTBEAT_URL: 'https://hc.example/ping/abc' }, 500)
    assert.equal(pings.length, 1, 'a failing chain stays silent so the monitor alerts')
    await run('0 * * * *', { HEARTBEAT_URL: 'https://hc.example/ping/abc' })
    assert.equal(pings.length, 1, 'only the 5-minute chain proves liveness')
    await run('*/5 * * * *', {})
    assert.equal(pings.length, 1, 'unset = off')
    await run('*/5 * * * *', { HEARTBEAT_URL: 'http://insecure.example/x' })
    assert.equal(pings.length, 1, 'https only')
  } finally { globalThis.fetch = realFetch; delete globalThis.__appResponse }
})

test('the brake leaves everyone else alone', async () => {
  const h = harness({ limiter: { allow: false } })
  // fresh session, no session, benign cookie, no client address: the limiter is not even asked
  for (const headers of [
    { cookie: sessionCookie(3600), 'cf-connecting-ip': '203.0.113.9' },
    { 'cf-connecting-ip': '203.0.113.9' },
    { cookie: 'gp_ref=A', 'cf-connecting-ip': '203.0.113.9' },
    { cookie: sessionCookie(-60) }, // no cf-connecting-ip
  ]) {
    const res = await h.get('/dashboard', headers)
    assert.equal(res.status, 200)
  }
  assert.deepEqual(h.calls.limiter, [])

  // under budget: asked, and let through
  const ok = harness({ limiter: { allow: true } })
  const res = await ok.get('/dashboard', { cookie: sessionCookie(-60), 'cf-connecting-ip': '203.0.113.9' })
  assert.equal(res.status, 200)
  assert.equal(ok.calls.limiter.length, 1)

  // binding missing (local dev): fails open
  const none = harness()
  assert.equal((await none.get('/dashboard', { cookie: sessionCookie(-60), 'cf-connecting-ip': '203.0.113.9' })).status, 200)
})

test('IPv6 callers share one brake bucket per /64', async () => {
  const h = harness({ limiter: { allow: true } })
  await h.get('/dashboard', { cookie: sessionCookie(-60), 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' })
  await h.get('/dashboard', { cookie: sessionCookie(-60), 'cf-connecting-ip': '2001:db8:1:2:bbbb::9' })
  assert.equal(new Set(h.calls.limiter).size, 1)
})

// ── API guard still in front ───────────────────────────────────────────────
test('the API guard still runs: cross-site writes are refused before the app, reads get no-store', async () => {
  const h = harness()
  const bad = await h.send('/api/dashboard/proxies', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(bad.status, 403)
  assert.equal(h.calls.app, 0)

  const big = await h.send('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) }, body: '{}' })
  assert.equal(big.status, 413)

  const read = await h.get('/api/health')
  assert.equal(read.headers.get('cache-control'), 'no-store')
  assert.equal(h.calls.app, 1)
})
