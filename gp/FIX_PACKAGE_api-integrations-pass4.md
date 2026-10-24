# Public API & integrations — independent pass 4 (migration 0074)

**Run `supabase/migrations/0074_api_integrations_pass4.sql` BEFORE (or with) the deploy.** Until it is applied, saving a webhook endpoint that selects "All events" or one of the three new events is rejected by the database; everything already stored keeps working.
`supabase/schema.sql` is folded through 0074. (Renumbered from 0073: another session landed `0073_admin_section8_pass5` while this pass was in progress.)

## Bugs fixed
1. **Bulk endpoints cached failures for 24 h.** `POST /sub-users/bulk` and `/bulk-topup` returned an "ok" 200 however many items failed, so the response was stored and replayed: retrying after buying bandwidth with the same key returned the stale 402s, and a new key duplicated the items that had succeeded. Now only a fully successful call is stored; any failed item frees the key, and a retry with the same key re-runs only the failed items. Bulk top-up gained real per-item keys (`runItemOnce`, `lib/idempotency.ts`) so a top-up is never applied twice. The docs previously claimed "safe to retry" and "<key>#i" for top-ups; neither was true.
2. **Cursor values broke when pasted unencoded.** `next_before` was `…+00:00`; the `+` became a space and the next page failed with 400. Now emitted as `…Z` (`cursorTs`, microseconds kept) on all four cursor lists, and an already-mangled cursor is repaired on input.
3. **OpenAPI:** optional bodies were `required: true` (`rotate-secret`, `redeliver-failed`, `reclaim`); `PATCH /reseller/settings` said `read` scope (needs `write`); `endpoint_count` was missing; the Section 7 additions (`invitations/{id}/remind`, roster `filter`/`sort`/`limit 100`) were missing.
4. **Supplier guard** was missing on the sessions routes' `connection_username`, on the endpoints route host and on `toApiCredential().host` (now fall back to the GlobProxy host / null).
5. **Lost bandwidth webhook.** The threshold job set its de-dupe flag, then `dispatchWebhook` swallowed an endpoint-lookup/insert failure — the alert was gone until usage fell under 80%. `dispatchWebhook` now reports whether the event was recorded and the flags are put back if not. Threshold events are stored as due-now and the cron runs thresholds before retries, so they still go out in the same tick; each cron step is isolated so one throwing no longer skips the others.
6. Dashboard webhook **DELETE** had no step-up and no throttle (every other mutation had both).
7. **Bulk write budget:** a refused bulk call may already have used part of the budget (the limiter cannot refund); documented rather than changed.
8. `GET /locations/{country}/asns` answered 200 `[]` for a code that is not a country; now 404.

## Gaps built
1. **Wildcard subscription** `event_types: ["*"]` (every event, including future ones) — API, dashboard ("All events" checkbox), `subscribesTo()` everywhere subscriptions are matched, catalog `wildcard` field.
2. New events **`api_key_updated`** (with `widened`) and **`webhook_endpoint_disabled`** (sent to the account's other endpoints).
3. New event **`reseller_low_stock`** next to the existing e-mail.
4. **Buy bandwidth through the API:** `POST /api/v1/orders` (hosted card-checkout link; optional Idempotency-Key; `write` scope) and `GET /api/v1/pricing` (`?gb=N` quote). The dashboard checkout and the API now share `lib/checkout.ts`.
5. Dashboard **"Redeliver all failed"** (`POST /api/dashboard/webhooks/:id/deliveries/redeliver-failed` + button in the delivery log).
6. Webhook verification samples in **Go, PHP and Ruby** (Postman imports `openapi.json` directly).
7. **`scripts/check-api-docs-sync.mjs`** (`npm run check:api-docs`, in CI and `build:cf`): every `app/api/v1` route method must appear in `lib/openapi.ts` and the docs page, and every spec path must have a route. This is what would have caught the `remind` route shipping without a spec entry.

## Not changed on purpose
- A refused bulk call can still spend part of the write budget (limiter limitation, now documented).
- Starting an API checkout cancels the account's other unpaid orders, exactly as the dashboard buy page does.
