# Fix package — Payments & billing (audit pass 1 close-out)

**Apply order matters: run `supabase/migrations/0047_payments_billing_closeout.sql` BEFORE deploying the code.**
(The deploy gate `check-migrations-applied` enforces it; schema.sql is folded through 0047.)

## Bugs fixed
1. **Checkout 401 outage (critical).** `/api/checkout` accepted only an `Authorization: Bearer` header; the buy page stopped sending it (commit 4587ce8). It now authenticates by session cookie first, Bearer as fallback, with a same-origin (CSRF) guard on cookie calls and a per-user rate limit.
2. **Refund-before-credit race.** A refund that arrived before its charge was credited was dropped (webhook answered 200) and the later credit paid out in full. `apply_order_refund` now records it (fully refunded → never credited; partially refunded → `claim_and_credit_order` credits only the un-refunded share).
3. **Settling payments shown as failures.** `verify-payment` returns 202 `pending` for ongoing/pending/processing; client helper `confirmPayment()` polls (8 × 3 s) for pending *and* for the 503 "confirmed, crediting" case. Both the popup and the redirect-return flow use it and show neutral notices, never a red error for money that is arriving. Redirect flow only runs on `payment=success` and always cleans the URL.
4. **verify-payment unrate-limited** → `PAYMENT_RATE_LIMITER` binding (wrangler.jsonc, namespace 1006, 30/min per IP).
5. **Billing page**: "Total GB purchased" now net of partial refunds; decline reason shown.
6. **Daily summary email** now net of refunds (matches admin pages). Confirmation email year is dynamic.

## Feature gaps closed
- Customer emails: receipt (amount + invoice no. + link) inside the "bandwidth activated" email, payment-failed email (once, on pending→failed), refund email with credit-note number.
- Disputes: `charge.dispute.create/resolve` flag the order (`orders.dispute_status`), checkout is paused while one is open, admin Orders has an "open dispute" filter. Resolution does not guess the winner — it lifts the pause and tells the admin to act.
- Resume payment: pending/failed orders get "Pay now"/"Try again" (preselects the plan on the buy page); failure reason visible.
- Invoices: seller legal address / tax id from env (`INVOICE_SELLER_NAME`, `INVOICE_SELLER_ADDRESS`, `INVOICE_SELLER_TAX_ID` — set these in Cloudflare); buyer billing address + tax/VAT id editable on Billing (`profiles.billing_address`, `tax_id`), **snapshotted onto the order when paid** so old invoices never change; sequential credit notes (`CN-YYYY-NNNNNN`) per refund shown on the invoice with net paid. Billing CSV gains `net_usd`, `failure_reason`. Account deletion wipes the new profile fields (order snapshots are kept for accounting).

## Not built (needs a decision / external account)
- M-Pesa / crypto checkout — needs a provider and credentials.
- Recovering GB a refunded customer already consumed — policy call (currently reported to admin as `gb_not_recoverable`).
- Custom-quantity top-ups; self-serve Scale plan.
