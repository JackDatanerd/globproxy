// Runs the REAL lib/broadcast.ts (bundled with esbuild so the @/ alias resolves) against an in-memory stand-in
// for Supabase and a scripted e-mail provider. What matters here is what happens to each recipient when the
// provider succeeds, struggles, goes silent, refuses our key or rejects the content — and that nobody is ever
// mailed twice or marked sent without the provider's say-so.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'tests', '.tmp-broadcast')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, 'broadcast.mjs')
await build({
  entryPoints: [path.join(root, 'lib/broadcast.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent',
  plugins: [{
    name: 'alias',
    setup(b) {
      b.onResolve({ filter: /^@\/lib\/supabase\/server$/ }, () => ({ path: 'fake-supabase', namespace: 'fake' }))
      b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export async function createAdminClient(){ return globalThis.__fake }', loader: 'js' }))
      b.onResolve({ filter: /^@\// }, (a) => ({ path: path.join(root, a.path.slice(2) + '.ts') }))
    },
  }],
})
const { runBroadcasts, BATCH_SIZE, MAX_ATTEMPTS } = await import(pathToFileURL(outfile).href)
test.after(() => rmSync(outDir, { recursive: true, force: true }))

// ── in-memory Supabase ────────────────────────────────────────────────
function makeFake({ n, kind = 'marketing', recipientCount }) {
  const rows = new Map()
  for (let i = 0; i < n; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    rows.set(id, { user_id: id, status: 'pending', attempts: 0, reason: null, email: `u${i}@example.com`, full_name: `User${i} Test` })
  }
  const bc = { id: 'bbbbbbbb-0000-4000-8000-000000000001', kind, subject: 'M-Pesa is live', body: 'Hello\n\nWorld', cta_label: 'Go', cta_url: 'https://globproxy.com/dashboard/buy?method=mpesa', recipient_count: recipientCount ?? n }
  const calls = []
  const f = {
    rows, bc, calls,
    from(table) {
      const q = { table, op: 'select', filters: [], patch: null, head: false }
      const run = () => {
        calls.push({ table, op: q.op, patch: q.patch, filters: q.filters })
        if (table === 'broadcasts') return { data: q.op === 'select' ? [bc] : null, error: null }
        if (table === 'broadcast_recipients') {
          const match = [...rows.values()].filter(r => q.filters.every(([k, op, v]) => {
            if (k === 'broadcast_id') return true
            if (op === 'eq') return r[k] === v
            if (op === 'in') return v.includes(r[k])
            if (op === 'lt') return r[k] < v
            if (op === 'gte') return r[k] >= v
            return true
          }))
          if (q.op === 'update') { for (const r of match) Object.assign(r, q.patch); return { data: null, error: null } }
          if (q.head) return { count: match.length, error: null }
          return { data: match, error: null }
        }
        return { data: null, error: null }
      }
      const b = {
        select(_c, o) { q.op = q.op === 'update' ? 'update' : 'select'; if (o?.head) q.head = true; return b },
        update(p) { q.op = 'update'; q.patch = p; return b },
        delete() { q.op = 'delete'; return b },
        eq(k, v) { q.filters.push([k, 'eq', v]); return b }, neq() { return b }, gt() { return b },
        in(k, v) { q.filters.push([k, 'in', v]); return b }, lt(k, v) { q.filters.push([k, 'lt', v]); return b }, gte(k, v) { q.filters.push([k, 'gte', v]); return b },
        order() { return b }, limit() { return b },
        then(res, rej) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args })
      if (name === 'broadcast_enqueue') return { data: rows.size, error: null }
      if (name === 'broadcast_claim') {
        const picked = [...rows.values()].filter(r => r.status === 'pending').slice(0, args.p_limit)
        for (const r of picked) { r.status = 'sending'; r.attempts++ }
        return { data: picked.map(r => ({ user_id: r.user_id, email: r.email, full_name: r.full_name })), error: null }
      }
      return { data: null, error: null }
    },
  }
  return f
}

// ── scripted provider ─────────────────────────────────────────────────
function provider(script) {
  const sent = []
  globalThis.fetch = async (url, init) => {
    const batch = JSON.parse(init.body)
    const call = { url: String(url), headers: init.headers, batch }
    sent.push(call)
    const step = typeof script === 'function' ? script(sent.length, call) : script
    if (step === 'throw') throw new Error('network timeout')
    return new Response(step.body ?? '{}', { status: step.status })
  }
  return sent
}
const statuses = (f) => { const c = {}; for (const r of f.rows.values()) c[r.status] = (c[r.status] ?? 0) + 1; return c }

test.beforeEach(() => { process.env.RESEND_API_KEY = 're_test'; process.env.CRON_SECRET = 'cron-secret-for-tests'; delete process.env.UNSUBSCRIBE_SECRET })

test('success: 250 recipients go out as 100/100/50 in one run of 4 batches max, each marked sent only after a 2xx', async () => {
  globalThis.__fake = makeFake({ n: 250 })
  const sent = provider({ status: 200 })
  const r = await runBroadcasts()
  assert.equal(r.error, undefined)
  assert.deepEqual(sent.map(s => s.batch.length), [100, 100, 50])
  assert.deepEqual(statuses(globalThis.__fake), { sent: 250 })
  assert.equal(r.sent, 250)
  assert.ok(sent.every(s => s.url === 'https://api.resend.com/emails/batch'))
})

test('a run is capped at 4 batches (400 e-mails) so it cannot starve the rest of the cron chain', async () => {
  globalThis.__fake = makeFake({ n: 650 })
  const sent = provider({ status: 200 })
  await runBroadcasts()
  assert.equal(sent.length, 4)
  assert.deepEqual(statuses(globalThis.__fake), { sent: 400, pending: 250 })
  await runBroadcasts()
  assert.deepEqual(statuses(globalThis.__fake), { sent: 650 })
})

test('every marketing message carries its own signed one-click unsubscribe link and headers', async () => {
  globalThis.__fake = makeFake({ n: 3 })
  const sent = provider({ status: 200 })
  await runBroadcasts()
  const { verifyUnsubscribe } = await import('../lib/unsubscribe.ts')
  for (const m of sent[0].batch) {
    const u = new URL(m.headers['List-Unsubscribe'].match(/<(https:[^>]+)>/)[1])
    assert.equal(u.pathname, '/api/unsubscribe')
    assert.equal(await verifyUnsubscribe('cron-secret-for-tests', u.searchParams.get('u'), u.searchParams.get('t')), true)
    assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
    assert.ok(m.html.includes('Unsubscribe from product news'))
    assert.ok(m.text.includes('Unsubscribe from product news'))
  }
  // each link belongs to its own recipient
  const ids = sent[0].batch.map(m => new URL(m.headers['List-Unsubscribe'].match(/<(https:[^>]+)>/)[1]).searchParams.get('u'))
  assert.equal(new Set(ids).size, 3)
  assert.ok(sent[0].headers['Idempotency-Key'].startsWith('bc-'))
})

test('a service notice has no unsubscribe link or header, and needs no unsubscribe secret', async () => {
  delete process.env.CRON_SECRET
  globalThis.__fake = makeFake({ n: 2, kind: 'service' })
  const sent = provider({ status: 200 })
  const r = await runBroadcasts()
  assert.equal(r.error, undefined)
  assert.equal(sent[0].batch[0].headers, undefined)
  assert.ok(!/nsubscribe/.test(sent[0].batch[0].html))
  assert.deepEqual(statuses(globalThis.__fake), { sent: 2 })
})

test('marketing e-mail with no unsubscribe secret sends NOTHING and says why', async () => {
  delete process.env.CRON_SECRET
  globalThis.__fake = makeFake({ n: 5 })
  const sent = provider({ status: 200 })
  const r = await runBroadcasts()
  assert.equal(sent.length, 0)
  assert.match(r.error, /no unsubscribe secret/)
  assert.deepEqual(statuses(globalThis.__fake), { pending: 5 })
})

test('provider outage (503): nobody is marked sent, the batch goes back to pending, and the run stops', async () => {
  globalThis.__fake = makeFake({ n: 250 })
  const sent = provider({ status: 503 })
  const r = await runBroadcasts()
  assert.equal(sent.length, 1)                       // did not hammer a struggling provider
  assert.equal(r.sent, 0)
  const s = statuses(globalThis.__fake)
  assert.equal(s.sent ?? 0, 0)
  assert.equal(s.pending, 250)
  assert.equal(globalThis.__fake.rows.get('00000000-0000-4000-8000-000000000000').attempts, 1)
})

test('after MAX_ATTEMPTS failed attempts a recipient is marked failed instead of retrying forever', async () => {
  globalThis.__fake = makeFake({ n: 1 })
  provider({ status: 503 })
  for (let i = 0; i < MAX_ATTEMPTS; i++) await runBroadcasts()
  assert.deepEqual(statuses(globalThis.__fake), { failed: 1 })
  assert.match([...globalThis.__fake.rows.values()][0].reason, /gave up/)
})

test('a timeout (no answer) is NOT retried: it may have been delivered, so it is failed visibly', async () => {
  globalThis.__fake = makeFake({ n: 5 })
  const sent = provider('throw')
  const r = await runBroadcasts()
  assert.equal(sent.length, 1)
  assert.deepEqual(statuses(globalThis.__fake), { failed: 5 })
  assert.match([...globalThis.__fake.rows.values()][0].reason, /delivery unconfirmed/)
  assert.match(r.error, /no answer/)
  // and a second run does not send them again
  await runBroadcasts()
  assert.equal(sent.length, 1)
})

test('a refused API key (401) puts the batch back untouched and stops everything', async () => {
  globalThis.__fake = makeFake({ n: 150 })
  const sent = provider({ status: 401 })
  const r = await runBroadcasts()
  assert.equal(sent.length, 1)
  assert.match(r.error, /refused our credentials/)
  assert.deepEqual(statuses(globalThis.__fake), { pending: 150 })
  assert.equal(globalThis.__fake.rows.get('00000000-0000-4000-8000-000000000000').attempts, 0)   // not counted against anyone
})

test('a content rejection (422) fails that batch with the provider\'s reason, and the run continues', async () => {
  globalThis.__fake = makeFake({ n: 150 })
  const sent = provider(n => (n === 1 ? { status: 422, body: '{"message":"invalid `to` field"}' } : { status: 200 }))
  const r = await runBroadcasts()
  assert.equal(sent.length, 2)
  assert.deepEqual(statuses(globalThis.__fake), { failed: 100, sent: 50 })
  assert.match(r.error, /rejected \(422\)/)
  assert.match([...globalThis.__fake.rows.values()][0].reason, /invalid `to` field/)
})

test('nothing pending: no provider call at all', async () => {
  globalThis.__fake = makeFake({ n: 0, recipientCount: 1 })
  const sent = provider({ status: 200 })
  const r = await runBroadcasts()
  assert.equal(sent.length, 0)
  assert.equal(r.sent, 0)
})

test('the batch size matches the provider limit', () => { assert.equal(BATCH_SIZE, 100) })
