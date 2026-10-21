# Public API & integrations — pass 2 (audit section 6)

Built on 609e778. No migration.

## Bugs
- `rotateApiKey` (lib/apiKeys.ts): every write is now checked. grace 0 revokes the old key FIRST (frees its slot under the 25-key cap, and a failed revoke is an error instead of a silent "revoked"), then mints the replacement, restoring the old key if minting fails. grace > 0: if the old key's grace expiry cannot be set, the replacement is revoked again and the call fails (no half-rotation). Cap error on a graceful rotate now says how to proceed.
- Rotation webhooks: `api_key_created` carries `rotated_from`; an immediately-revoked old key now fires `api_key_revoked` (`reason: "rotated"`, `replaced_by`).
- Housekeeping (delivery/idempotency/request-log pruning + `api_key_expiring` warnings) moved out of the dependent daily `alerts → summary → cleanup` chain into the independent */5 `webhooks` task (hourly, throttled via platform_settings `integration_housekeeping_at`). `MAX_PER_RUN` for key warnings 25 → 10 (runs hourly).
- `bandwidth_threshold_crossed` subscribers who do not subscribe to `bandwidth_exhausted` now get a final `threshold_pct: 100` event.

## Gaps closed
- Webhook retry engine: 8 → 24 per tick, at most 3 per endpoint per tick, endpoints worked 6 in parallel (deferred first attempts from usage sync / auto top-up depend on this task).
- `POST /sub-users/:id/release` accepts `Idempotency-Key` (no stale takeover, like top-up); OpenAPI + docs updated.
- Dashboard API Keys: "Revoke the old key now" rotation option; edit form changes access level and expiry (only changed fields are sent, so narrowing never asks for step-up).

## Judged and left as is
- Per-key `X-RateLimit-Remaining/Reset`: the Cloudflare limiter binding cannot report either truthfully.
- DNS-rebinding window / DoH fail-open on webhook delivery: Workers cannot reach private networks; documented risk only.
- 50-consecutive-failure auto-disable counts attempts (documented as such).
- `rotate-password` is deliberately not idempotent: replaying would store a plaintext password in the idempotency table.
