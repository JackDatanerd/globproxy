#!/usr/bin/env node
// Submits every URL currently in the live sitemap to the IndexNow API
// (consumed by Bing and Yandex; Google does not use IndexNow — GSC
// submission/crawling is still the only path in for Google).
//
// Reads URLs from https://globproxy.com/sitemap.xml directly rather than
// importing lib/blog or lib/locations here — that keeps this script a
// plain, dependency-free Node script (same convention as the other
// scripts/*.mjs files) and, more importantly, means it can never drift
// from what's actually live: it submits exactly what the deployed
// sitemap says exists, not a second, hand-maintained idea of what exists.
//
// Usage (run after a deploy that adds/changes pages):
//   node scripts/indexnow-submit.mjs                    # only pages whose <lastmod> is recent
//   node scripts/indexnow-submit.mjs --since-hours 168  # widen that window (default 48)
//   node scripts/indexnow-submit.mjs --all              # the whole sitemap (e.g. after regenerating /locations)
//
// IndexNow wants NEW or CHANGED URLs. Re-submitting the whole sitemap on every deploy
// (which is what this did) tells the search engines nothing new, and repeated
// full-site pings are how a key gets throttled. Pages with no <lastmod> (the static and
// /locations routes) are therefore only sent with --all or by naming them.
//
// Requires the key file to already be live at
// https://globproxy.com/<key>.txt (see public/<key>.txt in this repo —
// it's already committed and deploys with everything else, nothing extra
// to do there).
//
// To submit only specific URLs instead of the whole sitemap (e.g. right
// after publishing one new post), pass them as arguments:
//   node scripts/indexnow-submit.mjs https://globproxy.com/blog/my-new-post

const HOST = 'globproxy.com'
const KEY = 'ba57d213f99a035b9e6d993d8e4a24b5'
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`
const SITEMAP_URL = `https://${HOST}/sitemap.xml`
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'

// IndexNow accepts up to 10,000 URLs per submission — far more than this
// site needs, so no batching logic required beyond the cap check in main().
//
// Every network call has a hard timeout. Without one, a hung connection held the
// deploy job — and with it the serialised `deploy-production` concurrency group, so
// every later deploy queued behind it — until GitHub's 6-hour job limit.
const FETCH_TIMEOUT_MS = 20_000

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&') // LAST, so "&amp;lt;" decodes to "&lt;"

const argv = process.argv.slice(2)
const ALL = argv.includes('--all')
const sinceIdx = argv.indexOf('--since-hours')
const SINCE_HOURS = sinceIdx >= 0 ? Number(argv[sinceIdx + 1]) : 48
if (!Number.isFinite(SINCE_HOURS) || SINCE_HOURS <= 0) { console.error('[indexnow-submit] --since-hours needs a positive number.'); process.exit(1) }
const explicitUrls = argv.filter((a, i) => !a.startsWith('--') && !(sinceIdx >= 0 && i === sinceIdx + 1))

async function fetchLocs(url, depth = 0) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
  }
  const xml = await res.text()
  // Each <url> block: its <loc>, and its <lastmod> when it has one.
  const entries = /<sitemapindex[\s>]/.test(xml)
    ? [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/g)].map((m) => ({ loc: decodeXml(m[1].trim()), lastmod: null }))
    : [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
        loc: decodeXml((m[1].match(/<loc>\s*([\s\S]*?)\s*<\/loc>/)?.[1] ?? '').trim()),
        lastmod: m[1].match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/)?.[1]?.trim() ?? null,
      })).filter((e) => e.loc)
  const locs = entries.map((e) => e.loc)
  // A sitemap INDEX lists child sitemaps, not pages: follow it (one level) instead of
  // submitting .xml files as if they were pages.
  if (/<sitemapindex[\s>]/.test(xml)) {
    if (depth >= 1) return []
    const pages = []
    for (const child of locs) pages.push(...(await fetchLocs(child, depth + 1)))
    return pages
  }
  return entries
}

async function getSitemapUrls() {
  const entries = await fetchLocs(SITEMAP_URL)
  if (entries.length === 0) throw new Error('the sitemap lists no URLs — refusing to treat that as "nothing changed"')
  if (ALL) return entries.map((e) => e.loc)
  const cutoff = Date.now() - SINCE_HOURS * 3600_000
  const recent = entries.filter((e) => {
    const t = e.lastmod ? Date.parse(e.lastmod) : NaN
    return Number.isFinite(t) && t >= cutoff
  })
  console.log(`[indexnow-submit] ${recent.length} of ${entries.length} sitemap URL(s) changed in the last ${SINCE_HOURS}h.`)
  return recent.map((e) => e.loc)
}

async function submit(urlList) {
  const body = {
    host: HOST,
    key: KEY,
    keyLocation: KEY_LOCATION,
    urlList,
  }

  const res = await fetch(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  // IndexNow returns 200 or 202 on success, with no useful response body —
  // anything else is worth surfacing.
  if (res.status !== 200 && res.status !== 202) {
    const text = await res.text().catch(() => '')
    throw new Error(`IndexNow submission failed: ${res.status} ${res.statusText} ${text}`)
  }

  return res.status
}

async function main() {
  const all = explicitUrls.length > 0 ? explicitUrls : await getSitemapUrls()
  // IndexNow rejects the WHOLE batch (422) if any URL is on another host, so a stray
  // workers.dev or staging URL in the sitemap would silently cost every submission.
  const urls = [...new Set(all.filter((u) => {
    try { return new URL(u).hostname === HOST } catch { return false }
  }))]
  if (urls.length < all.length) console.warn(`[indexnow-submit] skipped ${all.length - urls.length} URL(s) not on ${HOST}`)
  if (urls.length > 10000) {
    console.error(`[indexnow-submit] ${urls.length} URLs exceeds the 10,000 per-request limit — submit in batches.`)
    process.exit(1)
  }

  if (urls.length === 0) {
    // Nothing changed is a normal outcome for most deploys; only an EMPTY sitemap is wrong.
    console.log('[indexnow-submit] Nothing new to submit.')
    return
  }

  console.log(`[indexnow-submit] Submitting ${urls.length} URL(s) to IndexNow...`)
  const status = await submit(urls)
  console.log(`[indexnow-submit] Done — IndexNow responded ${status}.`)
}

main().catch((err) => {
  console.error('[indexnow-submit]', err.message)
  process.exit(1)
})
