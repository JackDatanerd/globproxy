import test from 'node:test'
import assert from 'node:assert/strict'
import { isNewSignIn } from '../lib/signInNovelty.ts'
import { sendEmailSafe } from '../lib/email.ts'

const seen = (...c) => new Set(c)

test('the first sign-in ever recorded is never "new"', () => {
  assert.equal(isNewSignIn({ hadPriorLogin: false, sameDeviceSeen: false, country: 'KE', countriesSeen: seen() }), false)
})

test('a known device from a known country is not new', () => {
  assert.equal(isNewSignIn({ hadPriorLogin: true, sameDeviceSeen: true, country: 'KE', countriesSeen: seen('KE') }), false)
})

test('an unseen device is new, whatever the country', () => {
  assert.equal(isNewSignIn({ hadPriorLogin: true, sameDeviceSeen: false, country: 'KE', countriesSeen: seen('KE') }), true)
  assert.equal(isNewSignIn({ hadPriorLogin: true, sameDeviceSeen: false, country: null, countriesSeen: seen() }), true)
})

test('a known device from a country never seen before is new', () => {
  assert.equal(isNewSignIn({ hadPriorLogin: true, sameDeviceSeen: true, country: 'RO', countriesSeen: seen('KE', 'US') }), true)
})

test('an account with no country on record is not flagged for a country (legacy history)', () => {
  assert.equal(isNewSignIn({ hadPriorLogin: true, sameDeviceSeen: true, country: 'KE', countriesSeen: seen() }), false)
})

test('an unknown country (no header) never makes a known device new', () => {
  assert.equal(isNewSignIn({ hadPriorLogin: true, sameDeviceSeen: true, country: null, countriesSeen: seen('KE') }), false)
})

// ── sendEmailSafe retry ─────────────────────────────────────────────
function withFetch(responses, fn) {
  const realFetch = globalThis.fetch
  const prevKey = process.env.RESEND_API_KEY
  process.env.RESEND_API_KEY = 're_test'
  const calls = []
  globalThis.fetch = async (_url, init) => {
    calls.push(init)
    const next = responses.shift()
    if (next instanceof Error) throw next
    return new Response('{}', { status: next })
  }
  return fn(calls).finally(() => {
    globalThis.fetch = realFetch
    if (prevKey === undefined) delete process.env.RESEND_API_KEY
    else process.env.RESEND_API_KEY = prevKey
  })
}
const msg = { to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>' }

test('sendEmailSafe: a first-try success sends once', async () => {
  await withFetch([200], async (calls) => {
    assert.equal(await sendEmailSafe(msg), true)
    assert.equal(calls.length, 1)
  })
})

test('sendEmailSafe: retries once on a 5xx, with the SAME idempotency key', async () => {
  await withFetch([503, 200], async (calls) => {
    assert.equal(await sendEmailSafe(msg), true)
    assert.equal(calls.length, 2)
    const k1 = calls[0].headers['Idempotency-Key']
    assert.ok(k1)
    assert.equal(calls[1].headers['Idempotency-Key'], k1)
  })
})

test('sendEmailSafe: retries once on a network error, then gives up without throwing', async () => {
  await withFetch([new Error('boom'), new Error('boom')], async (calls) => {
    assert.equal(await sendEmailSafe(msg), false)
    assert.equal(calls.length, 2)
  })
})

test('sendEmailSafe: does not retry a 4xx (it would fail the same way)', async () => {
  await withFetch([422], async (calls) => {
    assert.equal(await sendEmailSafe(msg), false)
    assert.equal(calls.length, 1)
  })
})

test('email_change_requested is a durable notice sent to the address held when it was asked', async () => {
  // securityNotices.ts imports through the '@/' alias, which plain node can't resolve — assert on source.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/securityNotices.ts', import.meta.url), 'utf8')
  assert.match(src, /DURABLE_NOTICE_EVENTS[^]*'email_change_requested'[^]*\]\)/)
  assert.match(src, /case 'email_change_requested'[^]*meta\?\.old_email[^]*to: oldEmail/)
  const route = readFileSync(new URL('../app/api/auth/change-email/route.ts', import.meta.url), 'utf8')
  assert.match(route, /recordAndNotify\(\{[^}]*email_change_requested[^}]*old_email/)
})
