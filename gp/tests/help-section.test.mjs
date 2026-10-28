import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BLOG_POSTS } from '../lib/blog/posts.ts'
import { HELP_TOPICS } from '../lib/blog/help.ts'

const helpSlugs = BLOG_POSTS.filter((p) => p.section === 'help').map((p) => p.slug)

test('the seven first-published help articles are all in the help section', () => {
  for (const s of [
    'how-to-connect-to-globproxy-proxy',
    'retarget-session-or-get-bandwidth-back',
    'pause-resume-delete-session-bandwidth',
    'sticky-sessions-keep-same-ip',
    'auto-allocate-and-auto-recharge-never-run-dry',
    'paid-but-no-bandwidth-payment-not-showing',
    'two-factor-authentication-setup-backup-codes-recovery',
  ]) assert.ok(helpSlugs.includes(s), `${s} is a help article`)
})

test('every help article is listed on the hub exactly once, and the hub lists no unknown slug', () => {
  const listed = HELP_TOPICS.flatMap((t) => t.slugs)
  assert.equal(new Set(listed).size, listed.length, 'no slug listed twice')
  assert.deepEqual([...listed].sort(), [...helpSlugs].sort())
})

test('slugs are unique across blog and help (they share one lookup table)', () => {
  const all = BLOG_POSTS.map((p) => p.slug)
  assert.equal(new Set(all).size, all.length)
})

test('next.config redirects every old /blog help URL to /help, permanently', () => {
  const cfg = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8')
  assert.match(cfg, /async redirects\(\)/)
  assert.match(cfg, /p\.section === 'help'/)
  assert.match(cfg, /source: `\/blog\/\$\{p\.slug\}`/)
  assert.match(cfg, /destination: `\/help\/\$\{p\.slug\}`/)
  assert.match(cfg, /permanent: true/)
})

test('help articles never carry the supplier name or "upstream" in customer copy', () => {
  for (const p of BLOG_POSTS.filter((x) => x.section === 'help')) {
    const text = JSON.stringify(p)
    assert.ok(!/geo\s*node/i.test(text), `${p.slug}: supplier name`)
    assert.ok(!/upstream/i.test(text), `${p.slug}: "upstream"`)
    assert.ok(p.description.length <= 160, `${p.slug}: description length`)
  }
})

test('the edge cache and sitemap know about /help', () => {
  assert.match(readFileSync(new URL('../custom-worker.ts', import.meta.url), 'utf8'), /\^\\\/help\(\\\/\[\^\/\]\+\)\?\$/)
  const sm = readFileSync(new URL('../app/sitemap.ts', import.meta.url), 'utf8')
  assert.match(sm, /\/help`/)
  assert.match(sm, /getHelpArticles\(\)/)
})
