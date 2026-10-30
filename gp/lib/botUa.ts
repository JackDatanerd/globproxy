// Crawlers, search engines and link-preview fetchers. Deliberately a conservative substring list: a
// real browser UA never contains these tokens, and a missed bot only costs one rate-limited click.
// Plain data/regex, no imports, so tests can load it directly.
const BOT_UA = /bot\b|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|skype|slack|discord|embedly|pinterest|vkshare|headlesschrome|curl\/|wget\/|python-requests|go-http-client|okhttp|axios|node-fetch/i

/** True for a missing user-agent or one belonging to a known crawler / unfurler / scripted client. */
export function isAutomatedClient(userAgent: string | null | undefined): boolean {
  return !userAgent || BOT_UA.test(userAgent)
}
