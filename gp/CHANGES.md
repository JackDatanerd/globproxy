# IP Whitelisting for proxy credentials

Implements the gap flagged in the screenshot: Geonode's reseller API has always
had full whitelisted-IP endpoints for a sub-user (list / add / bulk-add /
remove-by-ip / bulk-remove), but GlobProxy never surfaced any of it. Right now
a credential's only access control is its username/password pair — this adds
the IP-based lock-on-top that resellers/customers commonly expect.

## New files
- `lib/ipWhitelist.ts` — IPv4/IPv6 validation, description validation
  (spec: 1–100 chars), and a shared Geonode-error → HTTP-response mapper.
- `app/api/dashboard/proxies/[id]/whitelist/route.ts` — GET (list),
  POST (add one), DELETE (remove one, via `?ip=`).
- `app/api/dashboard/proxies/[id]/whitelist/bulk/route.ts` — POST
  (bulk-create, max 150), DELETE (bulk-delete, max 150).
- `components/dashboard/IpWhitelist.tsx` — list/add/bulk-add/select/
  bulk-remove UI, styled to match the existing `SessionManager.tsx`.

## Modified files
- `lib/geonode.ts` — added `GeonodeApiError` (carries the real Geonode
  HTTP status instead of a formatted string) and the five whitelist API
  calls (`listWhitelistedIps`, `addWhitelistedIp`, `bulkAddWhitelistedIps`,
  `removeWhitelistedIp`, `bulkRemoveWhitelistedIps`), all under the same
  `resellerUid/serviceType/sub-users/{subUid}` path every other sub-user
  call in the file already uses.
- `components/dashboard/ProxyCard.tsx` — added an "IP whitelist" tab next
  to Credentials / Bandwidth / Endpoints / Code snippets.

## Design notes
- **Ownership, not `created_by`.** Whitelist routes check `user_id` only
  (same pattern as `sessions/route.ts`), not the `created_by` restriction
  used by delete/topup. Locking a credential to specific IPs doesn't
  reverse a reseller's bandwidth allocation the way deleting or topping up
  does, so any owner — self-created or reseller-allocated — can manage it
  on their own credential.
- **Still-provisioning credentials.** A credential with no
  `geonode_sub_user_id` yet returns `{ ips: [], provisioning: true }` from
  GET (not an error), and a clear 409 on write, instead of a confusing
  failure during the normal pending → active window.
- **Error mapping.** Geonode 401/403 on this endpoint means *our* reseller
  key was rejected, not the end user's fault — those collapse to a 502
  with a generic message (logged server-side with the real cause). 404
  ("not found") and 409 ("already exists" / "limit reached") pass through
  with Geonode's own message so the UI can show something meaningful.
- **IP format only, no CIDR.** The live spec's `ip` schema is
  `format: "ip"`, not a CIDR/network type — validation only accepts plain
  IPv4/IPv6 addresses, matching what Geonode actually accepts.
- **No local persistence of the whitelist itself.** The list is proxied
  live from Geonode on every load rather than mirrored into
  `proxy_credentials` — Geonode is the source of truth and every one of
  its whitelist endpoints already returns the full current list, so there
  is no reconciliation to do.

## Verified
- `npx tsc --noEmit` — clean.
- `npx next build` — succeeds; both new routes
  (`/api/dashboard/proxies/[id]/whitelist` and `.../whitelist/bulk`) show
  up correctly in the route table.
- No unrelated files touched (`package-lock.json` diff from `npm install`
  was reverted before packaging).

## What's NOT included (flagging, not guessing)
- No Supabase migration — nothing new to persist locally, so none needed.
- No cap on total whitelisted IPs enforced client-side beyond the 150-per-
  bulk-request spec limit — the overall per-sub-user ceiling lives on
  Geonode's side (409 "limit reached"), same as today.
