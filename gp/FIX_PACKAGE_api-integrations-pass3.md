# Public API & integrations — pass 3 (audit section 6)

Built on dab420f. **One migration: `0069_api_integrations_pass3.sql`** — apply it BEFORE deploying this code
(it adds `auto_topup_updated` to the `webhook_endpoints.event_types` CHECK; without it, subscribing to the new
event is accepted by the API and refused by the database). Also folded into `schema.sql`.

## Bugs
- **Reclaim: a malformed body became "reclaim everything"** (`reseller/allocations/:id/reclaim`). Unreadable /
  non-object JSON fell back to `{}`, and `gb` is optional, so `{"gb": 5` took back the whole unused allocation.
  New `readOptionalJsonObject`: no body = defaults, a body that is present must be a valid JSON object (400 otherwise).
- **v1 allocate/reclaim lacked the per-ACCOUNT limiter** the dashboard routes apply (only the per-address one ran), and
  their 429 had no `code`. Both limiters now run; 429s use the documented `{error, code: "rate_limited"}` shape.
- **Allocate-key IP pin was weak** (a `/8` = 16.7M addresses counted as "pinned"). `allocate` keys now need single
  addresses or blocks no wider than `/24` (IPv4) / `/48` (IPv6) — enforced at create, edit, rotate (checked before
  anything is revoked) and per request, so keys made earlier are held to it too.
- **Sessions PATCH/DELETE answered 500** for a non-object JSON body (`'label' in 5` throws) and for malformed ids
  (Postgres 22P02). Now 400 / 404.
- **Silent DB-write failures** (supabase-js returns `{error}`, it does not throw): webhook delivery results, and
  idempotency complete/release. Each write is checked, retried once and logged. A delivery that succeeded no longer
  stays "retrying" (re-sent) because the status write failed quietly.
- **Bandwidth-threshold webhooks silently stopped for everyone at scale**: the endpoint scan hit PostgREST's 1000-row
  cap and `.in('user_id', …)` put every id in the URL (reproduced: 1500 subscribed accounts -> 0 alerted, error never
  read). Paged scan, 100-id chunks, errors logged.
- **OpenAPI**: `locations/{country}` was typed as a UUID; `Activity` described a nested `key` the API never returns;
  `SubUser` lacked `session_type/protocol/pending_reason/can_resume/auto_topup`. Response headers documented.
- **Revoke-all (the panic button)** ran up to 25 sequential rounds of audit-row + webhook lookups (subrequest-cap risk
  mid-loop). Now one audit insert + one webhook batch (3 DB requests for 25 keys); `reason` is `manual` | `revoke_all`.
- `has_more` was `rows === limit`, so an exactly-full last page advertised a phantom empty page (activity, deliveries,
  transfers) — now fetches `limit + 1`. Deliveries also reject an unknown `status` (it used to return everything).
- v1 `PATCH auto-topup`: unexpected database errors came back as 400 with raw text; now 500 with a neutral message,
  and a malformed id is a 404 (dashboard route too).
- `X-RateLimit-Limit` said 120 on every response; it is now the limit that applies (120 read / 30 write / 10 history).
- `1.2.3.4` and `1.2.3.4/32` were stored as two entries; canonicalised (and key edits compare canonically).
- Dashboard API Keys labelled a `read + allocate` key "read-only".
- Webhook `session_suspended`/`session_resumed` source drift: fixed upstream in the same window (`admin|account|customer`);
  that wording is kept.

## Supplier exposure (never show the upstream provider to customers)
No direct leak was found. Closed the one path that could: the proxy username the provider returns is stored and shown as
`username`/`connection_username`. `lib/supplierGuard.ts`: provisioning now refuses (and deletes the just-created upstream
sub-user, so retries cannot orphan more) a username that names the supplier; API responses and the new endpoint list
withhold such a stored username. Verify once on live with the admin debug probe (`username_matches_requested`).

## Gaps closed
- `GET /v1/reseller/clients` — client roster (same RPC as the dashboard CSV).
- `GET /v1/reseller/invitations`, `DELETE /v1/reseller/invitations/:id` — list / cancel unclaimed invitations (no API
  way existed to find a `pending_id` again or free stock locked for 30 days by a typo'd e-mail).
- `GET /v1/account/usage?days=` — account-wide daily usage from the local ledger (no provider fan-out, 365 days).
- `GET /v1/sub-users/:id/endpoints?count=&format=json|txt` — proxy-list generation matching the dashboard export.
- `POST /v1/webhooks/:id/deliveries/redeliver-failed` — catch-up after an outage (oldest first, <=10, stops after 2
  consecutive failures).
- Webhooks: `auto_topup_updated` event (API + dashboard); `api_version: "v1"` in every payload; `event_type` filter on
  the delivery log.
- `GET /v1/sub-users` filters `session_type` and `protocol`.
- Dashboard API Keys: "Read + allocate only" access level (least privilege for a bot that only moves bandwidth).

## Judged and left as is
- Per-key `X-RateLimit-Remaining/Reset` (binding cannot report them) and the DNS-rebinding window — unchanged from pass 2.
- Dashboard `DELETE` routes without their own cross-site check: the edge pipeline now enforces same-origin centrally.
- Offset vs cursor pagination split between lists: kept for compatibility.
