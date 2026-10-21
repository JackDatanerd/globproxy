# Fix package — Payments & billing (audit pass 1 close-out, round 2)

**Apply order matters: run `supabase/migrations/0057_payments_billing_pass2.sql` BEFORE deploying the code.**
(Checkout now writes `orders.plan_slug`; the deploy gate `check-migrations-applied` enforces it. schema.sql is folded through 0057.)

## Bugs fixed
1. **Cleanup could overwrite a paid order with `failed`.** `runCleanup` selected stale pending orders, then updated them unconditionally in a loop; an order paid in that gap was flipped to `failed` (invoice page then said "No invoice yet", the admin refund button vanished, revenue dropped it). The update is now conditional on `payment_status = 'pending' AND bandwidth_credited = false`.
2. **Admin refund double-send.** The "already refunding" guard read the audit log first and wrote it after the Paystack call, so two near-simultaneous requests both passed. It is now an atomic, row-locked claim (`claim_refund_request`, `orders.refund_requested_at`), cleared when Paystack reports the refund processed or failed and self-expiring after 24 h; released immediately if Paystack rejects the request.
3. **M-Pesa partial refunds could leave cents un-refunded.** Each partial was converted to USD and rounded on its own, so several partials could total $0.01–$0.02 short and the order never reached `refunded` though every shilling was returned. A refund that clears what is left (within rounding) now takes exactly the remaining USD. Verified on 20,000 random splits: always ends exactly at the invoice total, never closes early.
4. **`verify-payment` shared one 30/min per-address bucket with `checkout/options`.** Each now has its own bucket (matters for Kenyan carrier-grade NAT during M-Pesa polling).
5. Smaller: payment-alert emails built their admin link from the raw env var instead of `appUrl()`; the M-Pesa admin settings saved a markup of 0% when the field was cleared.

## Feature gaps closed
- **Failed-payment handling now exists.** Paystack's documented event list has no `charge.failed`, so the old path (failed state, customer email, admin alert) most likely never fired. A shared `failPendingOrder()` (`lib/orderFailure.ts`) now runs from `/api/verify-payment`, the reconcile cron (after 15 min, so a customer retrying another card is not emailed mid-checkout) and the webhook: one conditional pending → failed transition, customer email once, admin alert once. A later success on the same checkout is still credited.
- **Canary now notices declines.** `chargeAuthorization` returns the decline synchronously and Paystack sends no event for it; the canary ignored it. It now records the failure and alerts immediately. (If the webhook is what is broken, reconcile credits the canary order and says so.)
- **Refund lifecycle events:** `refund.failed` and `refund.needs-attention` alert the admin (needs-attention = complete it in Paystack, typical for M-Pesa refunds); `refund.failed` also releases the refund lock so it can be re-requested.
- **Pricing page keeps the plan the visitor picked:** cards link to `…?plan=<slug>`; signup carries a known slug through email confirmation to `/dashboard/buy?plan=…`.
- **Credit notes:** printable stand-alone credit-note page (`/invoice/<order>/credit/<CN-…>`, linked from the invoice); the billing CSV gains a `credit_notes` column.
- **Invoice buyer-details correction:** "Update billing details" on an invoice re-applies the details currently saved on Billing (VAT id, address, name). Only the buyer block changes; max 3 revisions per invoice; the invoice shows that it was revised.
- **M-Pesa wording:** failed-payment and refund emails name M-Pesa and show the KES amount instead of "card issuer" / USD-only.
- **Orders record the plan bought** (`orders.plan_slug`); invoices read "Growth plan — 100 GB …".

## Notes
- Please confirm in the Paystack dashboard (Settings → API Keys & Webhooks → webhook logs) whether a `charge.failed` event is ever delivered; the code works either way.
- The 15-minute reconcile delay and 3-revision cap are constants in `app/api/cron/[task]/route.ts` and `reissue_invoice_details` (migration 0057).
