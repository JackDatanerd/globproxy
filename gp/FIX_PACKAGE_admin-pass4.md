# Admin & Verified Operators — pass 4 (independent audit, baseline a00c89f)

Bugs
- affiliates page: pending-payout destinations were serialised in full (wallet, M-Pesa phone, bank account number) into the page, readable without step-up. Now masked (lib/maskPayout.ts); the full destination stays in the step-up payout CSV.
- orders page + orders-csv: customer search resolved only the first 200 (page) / 500 (CSV) profiles and the refund-request filter only the first 500 open requests — rows past the cap vanished silently. Both are now embedded inner joins filtered by PostgREST (no cap, no long ?in.() URL).
- orders-csv: `refund_requested` filter was missing, so the Orders page's export button on that view exported EVERY order. Now supported.
- lib/adminSuspend.ts suspendAccount: a zero-row profile update (unknown id) went on to ban a non-existent auth user and report success. Now 404; "already suspended" still proceeds (re-asserts ban + proxies).
- void-payout: reason of 1 character was accepted (and is e-mailed to the affiliate); now >= 3 like reverse-payout.
- run-payout-cycle: arbitrary cycle ranges were accepted (the label is the dedupe slot). Now one whole half-month only.

Feature gaps closed
- Overview: "Verified Operator reviews due" tile (links to /admin/affiliates?vo=1).
- Credentials: "exhausted" badge when used >= allocated; warning when an owner search matches more than 200 accounts.

Not changed on purpose
- the upstream debug route stays (off unless ENABLE_DEBUG_ENDPOINTS=true); keep that variable unset in production.
