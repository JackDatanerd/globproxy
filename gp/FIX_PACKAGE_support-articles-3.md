# Support articles — bit 3: "Pause, resume or delete" guide (+ two corrections)

Built on `80edcc0`. Only `lib/blog/posts.ts` changes. No migration, no env change.

## Article added (Guides)
`/blog/pause-resume-delete-session-bandwidth` — what pause / release / delete each do to GB, credentials and connections (comparison table), the SUSPENDED badge and the three banners that say who stopped a session, resume and the 100-live-session cap (active + queued count; paused do not, but resuming needs a slot), delete accounting (unused GB returned, used GB archived into usage totals, named sticky sessions deleted with it), the bulk bar (Pause / Resume / Add GB / Change country / Delete, batches of 20), a "which one should I use" table, FAQ.

Facts come from `credentialPause`, `adminProxy.enableCredential`, `enforce_credential_limit` (0083), `delete_own_credential`, `ProxyCard`, `ProxyList` and the auto-allocate function (acts only on `status = 'active'`).

## Corrections to the two earlier guides
- **Connect guide:** the troubleshooting row for a paused session now matches the dashboard — the badge reads SUSPENDED (it shows the raw status), and the banner inside the session says who stopped it.
- **Retarget guide:** added the bulk **Change country** action in My Proxies (clears state, city and ISP on the selected sessions) and an `updatedAt`.

## Checked
`tsc --noEmit` clean; `npm test` 155/155; supplier-leak ratchet OK; render check passes for all three guides (no supplier name, no "upstream", description ≤160, title ≤75, unique slugs, username examples equal `buildProxyUsername`).
An earlier suspicion that bulk Change country kept a stale ISP was tested against the real `updateCredentialSettings` with a mock database and is already fixed in this base (asn/state/city all cleared on a country change).
