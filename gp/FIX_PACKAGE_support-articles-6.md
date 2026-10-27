# Support articles — bit 6: "Paid but no bandwidth?" guide (card + M-Pesa)

Built on `54c9304`. Only `lib/blog/posts.ts` changes. No migration, no env change.

## Article added (Guides)
`/blog/paid-but-no-bandwidth-payment-not-showing` — how a payment becomes bandwidth (order → payment → provider confirmation → credit → email/invoice) and the three independent paths that complete it (provider notification, the page's own verify call, the 5-minute reconcile safety net); where credit lands (account balance, not a session); a messages table; Billing statuses; "a failed/cancelled order can still be credited"; card and M-Pesa specifics; charged-twice and refunds; exactly what to send support.

## Timings stated, and where they come from
Safety net starts ~5 min after the order, rechecks ~hourly for 3 days, then daily to 14 days (`runReconcile`, `*/5` cron). M-Pesa page waits ~60 s (20 × 3 s in `buy/page.tsx`); an unconfirmed M-Pesa prompt counts as "waiting" for 10 minutes (`verify-payment`). Refund policy: 72 h, nothing used since purchase, reply in 2 business days, 5–10 business days to pay out (`/refunds`, `refund-request` route).

## Checked
`tsc` clean; `npm test` 155/155; supplier-leak ratchet OK; all six guides render and sit within the title (≤75) and description (≤160) limits. A check asserts that **every on-screen message the article quotes exists verbatim in the code** (12 messages across verify-payment, PaymentVerifier, checkout, billing emails, payment-hold).

## Wording corrected during review
Three lines that went beyond the code were softened before packaging: the chargeback sentence now says only what `purchaseBlock` does (purchases paused during a dispute; hold after a lost one); the refund sentence now says what `/refunds` says about taking bandwidth back; the "hold" row no longer claims anything about existing bandwidth.

## Looked at, nothing to fix
Billing's **Cancel** button updates `orders` from the browser. That is already locked down: the "Cancel own pending order" policy allows only pending → cancelled on the customer's own row (0003), and the `protect_order_columns` trigger pins every other column for non-admins (0006). A cancelled order is still credited if the payment is later confirmed, which is what the article tells customers.
