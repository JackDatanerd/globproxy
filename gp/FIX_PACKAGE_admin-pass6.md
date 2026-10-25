# Admin & Verified Operators — pass 6 (independent audit, baseline f3fd30c)

Migration: 0085_admin_section8_pass6.sql (folded into schema.sql). Apply it before deploying —
the audit page and CSV export now call admin_audit_search().

Bugs
- affiliates/[id]: the Verified Operator history matched every `verified_operator.*` action, so each "Mark reviewed" showed up as "Revoked" (and read d.reason where reviews store d.note). Now Granted / Reviewed / Revoked, with the note.
- MpesaSettings: an unreadable manual rate ("129 KES") became NaN → JSON null → the server CLEARED the fallback rate and reported success. Input is validated client-side; markup likewise.
- users list: the Actions menu sat inside an overflow-hidden table card and was clipped (entirely, on a short list). Now fixed-positioned, opens upward near the bottom of the screen.
- Overview "Refunds to confirm" counted append-only audit rows, so it never cleared. Now counts orders still carrying a refund lock (refund_requested_at), "Refunds awaiting Paystack", linking to the new order filter.
- Customers on an ADMIN-placed payment hold were told a dispute had been lost. lib/checkout.ts now picks the message from the hold's source (lib/paymentHold.ts).
- placePaymentHold returned false for both "already held" and a failed write, so a bad id / FK error showed as "already on payment hold"; a failed hold after a lost dispute was silent. It now throws on write failure; the route validates the target (exists, not admin, not deleted); dispute-outcome and lib/disputes.ts surface/alert a failed hold.
- payouts CSV "Account state" ignored account-level suspension (markPayoutPaid blocks it). Now flagged.
- audit log "who" search: up to 200 ids were put in the URL twice (~15 KB, past the gateway limit) and capped at 200 accounts. Done in SQL (admin_audit_search): complete, paged, no URL growth; LIKE wildcards in the search text are matched literally.
- suspendAccount: on a failed ban the rollback cleared is_suspended even when this call had not set it (concurrent suspend). Now only undoes its own change.
- Approving a reseller / affiliate / API access, and make_reseller, on a SUSPENDED account now refuse (409) until reinstated (the Verified Operator grant already did).
- unban-email: accounts the ban had suspended stayed suspended silently. The response and a toast now say how many.
- affiliates/[id]: hard-coded 0.3 / 0.15 replaced by the DEFAULT_AFFILIATE_* constants.
- Overview tile "Paid, bandwidth not credited" counts orders older than 15 min but its link listed all; label now says so.

Feature gaps closed
- Refund in flight: orders show "refund sent to Paystack <time> — awaiting confirmation / unconfirmed over 24 h", a "refund awaiting Paystack" filter (page + CSV), the order_refunds history per order, and a reason-required "Release refund lock" action (POST /api/admin/release-refund-lock, audited).
- Demoting a reseller (make_user) cancels their open invitations and returns the reserved GB (lib/adminInvitations.ts); the claim function only checked suspended/deleted, not role.
- Verified Operator reviews: Overview tile links to ?due=1 (only overdue operators; shared helper lib/adminVo.ts), "Mark reviewed" on overdue rows of the list, an operator with no recorded grant date is due immediately (was permanently exempt), and the daily summary e-mail now lists overdue reviews.
- Users: "On payment hold" filter and a hold badge on the list.
- Support: search (e-mail / message) and per-customer filter on /admin/support; the user page lists that customer's reports.
- clear-referral-flag and confirm-referral-fraud now require a reason (audited), like the void routes.
- Overview: any failed count query now shows a banner instead of reading as 0.

Already closed by another session before this pass: admin 2FA is required (layout + authorizeAdmin).
Tests: tests/admin-pass6.test.mjs. Verified: tsc clean, check:schema / cron / api-docs / supplier OK, 72/72 tests, migration exercised on Postgres 16.
