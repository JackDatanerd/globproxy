# Proxy lifecycle — independent pass 3 (fix round) — migration 0083

Built on `d0c155d`. Run `supabase/migrations/0083_proxy_lifecycle_pass4.sql` (schema.sql already folded), then deploy.

## Bugs fixed
| # | What |
|---|------|
| B1 | **Resume could bypass the 100-session cap.** The cap trigger only fired on INSERT; resuming a paused session (UPDATE) went past it. The trigger now also guards status updates (0083). `enableCredential` activates the row first and lifts the upstream cap only afterwards (and reverts the row if the upstream call fails) — previously a refused resume left the session proxying upstream while shown as paused, uncounted by usage sync. Resume answers 409 with a clear message; admin re-enable answers 409. |
| B2 | **Password rotation could diverge from the provider.** When verification said "provider ignored it", a slow provider could still apply the new password afterwards and lock the customer out of the stored one. Every not-committed path (echo mismatch, ambiguous timeout, ignored) now re-asserts the stored password upstream. |
| B3 | **Stock exposure ignored paused sessions.** Pausing returns the unused headroom to the supplier pool; resume re-takes it. Customer-paused unused GB is now part of exposure (`paused_resume_gb`), shown in the admin panel and the alert email. |
| B4 | **Dashboard bulk pause/resume/delete cost one request, one usage sync and one rate-limit hit per session.** New `POST /api/dashboard/proxies/bulk-action` (20 per request, one sync per request); the bulk bar uses it. |
| B5 | **Auto-allocate notices shared one flag**, so after one notice kind the others were swallowed. `auto_topup_alert_kind` (0083): each kind is sent once per episode. |
| B6 | Probe response buffer is capped (64 KB). |

## Feature gaps closed
| # | What |
|---|------|
| G1 | Export no longer does one sequential GET per sticky session: new `GET /api/dashboard/proxies/named-sessions` returns all named sessions in one read. |

## Already fixed by other sessions (verified, not redone)
Low-bandwidth alert claim (guarded), auto-top-up route rate limit, retry route read-back.

## Not changed / needs live data
Whitelist semantics (see pass 2 live check #2) can't be resolved from code. Benchmark probing stays HTTP-only by design (admin picks the benchmark credential).
