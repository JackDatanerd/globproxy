# Dashboard UI — pass 4 (bugs only)

1. Bulk "Add GB" no longer targets paused sessions. `topup_credential` only
   accepts active/pending sessions, so paused ones always failed, inflated the
   balance check and confirm text, and stayed selected for a retry that could
   never succeed. (components/dashboard/ProxyList.tsx)
2. "Retry now" on a still-pending session: the route returned 502 for the
   "adding capacity, no action needed" outcome, shown as a red error. It now
   returns 200 `{ success:false, status:'pending', message }` and the card shows
   an info toast. (retry/route.ts, ProxyCard.tsx)
3. Auto top-up forms (new session, session card, Settings default) reject more
   than 4 decimal places up front, matching the server rule. (lib/clientApi.ts
   `hasAtMostDecimals`)
4. Settings shows the scheduled deletion date in UTC, matching the banner and
   emails, so the two can no longer differ by a day.
5. API key revoke / revoke-all use `toastApiError`, so no stray error toast
   flashes during the 2FA redirect.

No migrations. Type check (tsc --noEmit) clean.
