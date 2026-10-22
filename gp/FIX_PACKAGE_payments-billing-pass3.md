# Payments & billing — audit round 3 (fixes + gaps)

Base: upstream 6ad8744. **Run migration 0065 before deploying the app code** (the Paystack webhook now passes new `apply_order_refund` arguments and several pages read the new columns).

## Deploy checklist
1. Run `supabase/migrations/0065_payments_billing_pass3.sql` (idempotent; `schema.sql` already includes it).
2. Deploy. `wrangler.jsonc` adds the `PAYMENT_VERIFY_RATE_LIMITER` binding (namespace 1007) — `/api/health` reports it if it is missing.
3. Optional env: `INVOICE_TAX_NOTE` (printed under invoice / credit-note totals, e.g. "Prices include all applicable taxes").
4. Operational: the Scale plan promises an account manager / white-label / custom geo. A Scale purchase now emails the admin ("SCALE order — onboard…") and tells the customer to expect contact within one business day — someone has to act on that email.

## Bugs fixed
- B1 verify-payment: transient failures (DB, Paystack unreachable/timeout) now answer 503 `pending:true`; `lib/verifyPayment.ts` treats any 5xx as "still confirming" instead of a red failure.
- B2 verify rate limit: per-address bucket (300/min, new binding) + per-address-and-reference bucket (30/min) instead of one 30/min per address.
- B3 refund idempotency key no longer collapses two equal partial refunds; an ambiguous duplicate raises an admin alert.
- B4 `bandwidth_credited` webhook + confirmation email report the GB actually credited when a refund beat the credit.
- B5 M-Pesa amount must equal what the customer saw (exact whole KES); a missing `expected_kes` is answered with the amount to confirm.
- B6 mismatch alert is sent once per order (`orders.mismatch_alerted_at`) across webhook / verify / reconcile.
- B7 reconcile keeps looking daily at uncredited orders up to 14 days old (5 per run).
- B8 a fresh (<10 min) M-Pesa order reading `abandoned` is treated as pending, not a failure. (Still worth one live M-Pesa test.)

## Gaps closed
- G1 Lost / accepted disputes: webhook `charge.dispute.resolve` with an accepted resolution takes the proportional GB back + credit note (`lib/disputes.ts`); other resolutions stay `resolved` and the admin settles them with **Dispute lost / won** on Admin → Orders (`/api/admin/dispute-outcome`). A late webhook never overwrites a decided outcome.
- G2 Admin **Verify & credit** on uncredited orders (`/api/admin/verify-order`, mismatch override needs a reason, audit-logged); filter chip "paid? (uncredited)".
- G3 Scale onboarding notice (admin + customer), copy updated.
- G4 Customer **Request refund** on Billing (`/api/dashboard/billing/refund-request`), eligibility computed server-side (72h + nothing used), admin sees it on Admin → Orders / Overview (Decline button; the normal Refund button approves and closes it), customer emailed. Refund policy page updated.
- G5 Credit notes record and show the KES refunded (`order_refunds.charged_*`), credit notes listed on Billing, billing export gains `plan`, `refunded_charged_amount`, `invoice_url`, optional invoice tax note.

## Not changed on purpose
Checkout is still only paused while a dispute is *open* (a lost dispute alerts the admin and claws back; it does not lock the account).
