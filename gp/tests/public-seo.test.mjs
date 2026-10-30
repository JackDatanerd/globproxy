// Section 11 (public site & SEO) regression tests: metadata inheritance, SEO titles, sitemap/robots,
// referral-click bot guard, locations data, colour-contrast tokens, and the shared page shell.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { BLOG_POSTS } from '../lib/blog/posts.ts'
import { SEO_TITLES, SEO_TITLE_MAX, seoTitle } from '../lib/blog/seoTitles.ts'
import { pageMetadata } from '../lib/seo.ts'
import { isAutomatedClient } from '../lib/botUa.ts'
import { LOCATION_COUNTRIES } from '../lib/locations/data.ts'

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8')

// ── metadata ────────────────────────────────────────────────────────────
test('pageMetadata sets canonical, og and twitter from the same title/description/path', () => {
  const m = pageMetadata({ title: 'Terms — GlobProxy', description: 'd', path: '/terms' })
  assert.equal(m.title, 'Terms — GlobProxy')
  assert.equal(m.alternates.canonical, '/terms')
  assert.equal(m.openGraph.url, '/terms')
  assert.equal(m.openGraph.title, 'Terms — GlobProxy')
  assert.equal(m.openGraph.description, 'd')
  assert.equal(m.twitter.title, 'Terms — GlobProxy')
  assert.ok(m.openGraph.images?.length, 'a default og:image is included so the root image is not lost')
  assert.ok(m.twitter.images?.length)
})

test('pageMetadata: articles use their own social title and leave the image to opengraph-image', () => {
  const m = pageMetadata({
    title: 'Short — GlobProxy', socialTitle: 'The full headline', description: 'd', path: '/blog/x', defaultImage: false,
    article: { publishedTime: '2026-01-01', modifiedTime: '2026-02-01' },
  })
  assert.equal(m.openGraph.type, 'article')
  assert.equal(m.openGraph.title, 'The full headline')
  assert.equal(m.openGraph.modifiedTime, '2026-02-01')
  assert.equal(m.openGraph.images, undefined)
})

test('every public page builds its metadata with pageMetadata (no bare title-only exports)', () => {
  const pages = [
    'app/terms/page.tsx', 'app/privacy/page.tsx', 'app/refunds/page.tsx', 'app/status/page.tsx',
    'app/locations/page.tsx', 'app/locations/[country]/page.tsx', 'app/blog/page.tsx', 'app/blog/[slug]/page.tsx',
    'app/help/page.tsx', 'app/help/[slug]/page.tsx', 'app/docs/api/page.tsx',
  ]
  for (const p of pages) assert.match(read(p), /pageMetadata\(/, `${p} should use pageMetadata`)
  assert.match(read('app/page.tsx'), /canonical: '\/'/, 'the homepage needs its own canonical')
  assert.doesNotMatch(read('app/layout.tsx'), /alternates/, 'a root-layout canonical would be inherited by every page')
})

// ── SEO titles ──────────────────────────────────────────────────────────
test('every post has a short SEO title, and none is orphaned', () => {
  const slugs = new Set(BLOG_POSTS.map((p) => p.slug))
  for (const p of BLOG_POSTS) {
    assert.ok(SEO_TITLES[p.slug], `${p.slug} has no entry in lib/blog/seoTitles.ts`)
    const t = seoTitle(p)
    assert.ok(t.length <= SEO_TITLE_MAX, `${p.slug}: <title> is ${t.length} characters`)
  }
  for (const k of Object.keys(SEO_TITLES)) assert.ok(slugs.has(k), `seoTitles.ts has an entry for a post that does not exist: ${k}`)
})

// ── sitemap / robots / referral clicks ──────────────────────────────────
test('sitemap lists the status and legal pages; robots keeps crawlers off /r/', () => {
  const sm = read('app/sitemap.ts')
  for (const r of ['/status', '/terms', '/privacy', '/refunds']) assert.ok(sm.includes('`${BASE_URL}' + r + '`'), `sitemap is missing ${r}`)
  assert.match(read('app/robots.ts'), /'\/r\/'/)
})

test('referral-click bot guard', () => {
  for (const ua of [null, '', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Slackbot-LinkExpanding 1.0', 'facebookexternalhit/1.1', 'WhatsApp/2.23', 'curl/8.4.0', 'python-requests/2.31']) {
    assert.equal(isAutomatedClient(ua), true, String(ua))
  }
  for (const ua of [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  ]) assert.equal(isAutomatedClient(ua), false, ua)
  assert.match(read('app/r/[code]/route.ts'), /isAutomatedClient\(/)
})

// ── supplier never public ───────────────────────────────────────────────
test('admin-typed benchmark text is guarded before it reaches the public status page', () => {
  assert.match(read('app/api/admin/record-benchmark/route.ts'), /leaksSupplier\(targetLabel\) \|\| leaksSupplier\(notes\)/)
  assert.match(read('app/status/page.tsx'), /leaksSupplier\(row\.target_label\)/)
  assert.match(read('app/status/page.tsx'), /leaksSupplier\(row\.notes\)/)
})

// ── locations data ──────────────────────────────────────────────────────
const fold = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

test('locations: every major city exists in the geo data (accent-aware) and counts match', () => {
  for (const c of LOCATION_COUNTRIES) {
    const geo = JSON.parse(read(`public/geo/countries/${c.code}.json`))
    const names = new Set(geo.states.flatMap((s) => s.cities.map((x) => x.name)))
    for (const city of c.majorCities) assert.ok(names.has(city), `${c.code}: ${city} is not a city in the geo data`)
    assert.equal(geo.states.length, c.stateCount, `${c.code} stateCount`)
    if (c.code !== 'sg') assert.equal(geo.states.reduce((n, s) => n + s.cities.length, 0), c.cityCount, `${c.code} cityCount`)
  }
})

test('locations: Brazil lists Brasília (not the town Brasiléia) and Singapore is one city', () => {
  const br = LOCATION_COUNTRIES.find((c) => c.code === 'br')
  assert.ok(br.majorCities.includes('Brasília'))
  assert.ok(!br.majorCities.includes('Brasiléia'))
  assert.equal(LOCATION_COUNTRIES.find((c) => c.code === 'sg').cityCount, 1)
  assert.equal(fold('Brasília'), 'brasilia')
  assert.notEqual(fold('Brasiléia'), fold('Brasília'))
  assert.match(read('scripts/generate-locations.py'), /unicodedata\.normalize\("NFKD"/)
})

// ── colour contrast (WCAG AA = 4.5:1 for small text) ────────────────────
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = (h) => { const n = parseInt(h.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

test('AA text tokens meet 4.5:1 on the light surfaces they are used on', () => {
  const colors = createRequire(import.meta.url)('../tailwind.config.js').theme.extend.colors
  for (const bg of ['#ffffff', colors.surface, colors['accent-light']]) {
    assert.ok(ratio(colors.subtle, bg) >= 4.5, `subtle on ${bg}: ${ratio(colors.subtle, bg).toFixed(2)}`)
  }
  for (const bg of ['#ffffff', colors['accent2-light'], colors.surface]) {
    assert.ok(ratio(colors['accent2-dark'], bg) >= 4.5, `accent2-dark on ${bg}: ${ratio(colors['accent2-dark'], bg).toFixed(2)}`)
  }
})

// ── shared page shell ───────────────────────────────────────────────────
test('public pages share one footer and a #main landmark; the navbar has a mobile menu and no per-page getUser()', () => {
  for (const p of [
    'app/page.tsx', 'app/terms/page.tsx', 'app/privacy/page.tsx', 'app/refunds/page.tsx', 'app/status/page.tsx',
    'app/locations/page.tsx', 'app/locations/[country]/page.tsx', 'app/blog/page.tsx', 'app/help/page.tsx',
    'app/docs/api/page.tsx', 'components/blog/PostArticle.tsx',
  ]) {
    const s = read(p)
    assert.match(s, /<Footer \/>/, `${p} needs the shared Footer`)
    assert.match(s, /<main id="main"/, `${p} needs <main id="main">`)
  }
  // Every page that renders the Navbar must have the #main target its skip link points at.
  const walk = (dir) => fs.readdirSync(new URL('../' + dir, import.meta.url), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))
  for (const f of [...walk('app'), ...walk('components')].filter((f) => f.endsWith('.tsx') && f !== 'components/Navbar.tsx')) {
    if (/from '@\/components\/Navbar'/.test(read(f))) assert.match(read(f), /<main id="main"/, `${f} renders the Navbar but has no <main id="main">`)
  }
  const nav = read('components/Navbar.tsx')
  assert.match(nav, /aria-controls="mobile-menu"/)
  assert.match(nav, /href="#main"/)
  assert.doesNotMatch(nav, /auth\.getUser\(/, 'getUser() is a network round-trip on every page view')
})

test('fonts are self-hosted, not pulled from Google at render time', () => {
  assert.doesNotMatch(read('app/globals.css'), /googleapis|gstatic|@import/)
  assert.doesNotMatch(read('lib/csp.ts'), /googleapis|gstatic/)
  assert.match(read('app/layout.tsx'), /fontSans\.variable/)
})

test('navbar switches to the menu button below 1024px and article text can wrap long tokens', () => {
  const nav = read('components/Navbar.tsx')
  assert.match(nav, /hidden lg:flex/)
  assert.match(nav, /lg:hidden inline-flex/)
  assert.doesNotMatch(nav, /md:hidden|md:flex/, 'the 7 links + buttons overflow at 768px')
  assert.match(read('components/blog/PostBody.tsx'), /overflow-wrap:anywhere/)
  assert.match(read('app/docs/api/page.tsx'), /<div className="overflow-x-auto mb-4">/)
})
