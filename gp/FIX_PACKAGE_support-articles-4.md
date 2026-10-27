# Support articles — bit 4: "Sticky sessions" how-to

Built on `870c3a4`. Only `lib/blog/posts.ts` changes. No migration, no env change.

## Article added (Guides)
`/blog/sticky-sessions-keep-same-ip` — how stickiness works (it lives in the username: `-lifetime-<min>-session-<id>`), creating a sticky session (durations 1 min–24 h, default 10), switching a rotating session via the Edit tab, the sticky ports (10000 / 12000), named sessions (batches of 1/5/10/25, up to 200 live per sticky session), getting a fresh IP, Remove vs Delete, a Python per-account example, a 7-row "IP changes / doesn't" table, FAQ.

Facts come from `proxyEndpoint` (username format, ports, 1–1440 clamp), `SessionManager`, `dashboard/proxies/[id]/sessions` and `dashboard/sessions/[sessionId]` routes, migration 0059 (200 live / 2000 stored caps), the cron purge of hidden sessions after 7 days, `StickyDurationSelect`, `NewProxyForm`, `CredentialSettings`.

## Deliberately hedged (cannot be verified from code)
When the hold clock starts, and what the provider does when a held peer drops or a window expires. The article says a held IP *can* drop early, and that reconnecting after expiry *may* land on a different IP — nothing stronger.

## Checked
`tsc --noEmit` clean; `npm test` 155/155; supplier-leak ratchet OK; render check passes for all four guides; the sticky username in the article equals `buildProxyUsername` output, the port table equals `getProxyPort`, and two tokens differ only in the id.
