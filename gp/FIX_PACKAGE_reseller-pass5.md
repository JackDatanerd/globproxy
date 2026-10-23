# Reseller, affiliates & payouts — pass 5

**Apply migration `0072_section7_reseller_affiliates_pass5.sql` BEFORE deploying.**
The app now reads/writes `profiles.payout_hold_reason`, `reseller_pending_transfers.reminder_count`
and calls the new `reseller_client_roster` / `remind_pending_reseller_transfer` signatures.

## Bugs fixed
- **Users CSV export stopped after 100 clients.** The route paged in steps of 500 but the roster RPC returns
  at most 100 rows per call, so the first (short) page looked like the last. Now pages by `ROSTER_MAX_PAGE`.
- **`GET /api/v1/reseller/clients` accepted `limit` up to 200 (and the docs promised it) but returned 100.**
  Cap, route and docs now agree on 100.
- **Reclaim swept back admin credits.** `reclaim_reseller_allocation` counted later orders, transfers and referral
  bonuses as the client's own, but not later admin credits. Reproduced: transfer 10 GB, client commits 8, admin
  credits +5 → old reclaim took 7 (5 of it the admin credit); fixed, it takes 2.
- **Payout hold copy was wrong after a password / email / 2FA change.** The 48 h hold shares one timestamp between
  "payout method changed" and "account-security event"; the banner always said the payout details changed.
  New `payout_hold_reason` says which; dashboard banner, "last changed" line, admin affiliate page and the
  payout-cycle roll-over e-mail now word it correctly. Users cannot relabel their own hold (trigger).
- **ResellerCalc quoted prices you can't buy** (e.g. 490 GB at the Growth per-GB rate). It now prices the cheapest
  real pack mix that covers the target and shows what you would actually buy.
- **Unstable ordering**: the roster (tie on `last_transfer_at`) and the transfers page (tie on `created_at`) could
  repeat or drop rows across pages; both now tie-break on id.

## Feature gaps closed
- Resend an invitation (dashboard "Resend" + `POST /api/v1/reseller/invitations/:id/remind`): one per 24 h, max 3,
  paced atomically in the database; only addresses without a usable account are mailed.
- Partial reclaim from the Transfers page (blank = everything unused, or a number of GB).
- Client roster filter (haven't used it / used everything sent / idle 30 d) and sort (latest, most sent, most used,
  least remaining, email A–Z) — also on the v1 API and carried into the CSV export.
- Per-client transfer history (`/reseller/transfers?client=<id>`, "View history →" on each roster card).
- The reseller now gets an e-mail record when a reclaim happens (previously only the client was told).

## Checked, nothing to do
Payout-method change e-mail already exists; suspend/reinstate already covers revoking a reseller; TRON and M-Pesa
validators are correct; payout-method and hold columns were introduced together so no legacy NULL-timestamp rows;
`schema.sql` manifest line was stale (still said 0070 although 0071 was folded) — now 0072.

## Verified
`tsc --noEmit` clean; `check:schema` and `check:cron` pass; migration loaded into a scratch Postgres 16 with the
full schema and exercised (old vs new reclaim, roster filters/sorts/paging over 132 clients, reminder pacing,
hold-reason triggers).
