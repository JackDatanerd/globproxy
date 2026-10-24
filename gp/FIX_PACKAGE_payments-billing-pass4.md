# Fix package — Section 3: Payments & billing, round 4

Apply order: **run `supabase/migrations/0076_payments_billing_pass4.sql` in Supabase FIRST**, then push
(deploy.yml's migration gate refuses to deploy until it is recorded). Idempotent; already folded into `schema.sql`.
The billing page, checkout and invoices read the new columns, so deploying before the migration shows load errors.

## Gaps closed
| | What | Where |
|---|---|---|
| G1 | Customers are told about disputes: e-mail when a chargeback opens (why purchases paused) and when it is lost (GB removed, credit note); Billing shows a banner and a "Payment disputed" tag. | `lib/billingEmails.ts`, `lib/disputes.ts`, webhook, billing page |
| G2 | A lost dispute puts the account on **payment hold** (`payment_holds`): no new purchases (dashboard, API `POST /orders`, auto-recharge) until an admin clears it. Admin → user shows the hold with Clear / "Put on payment hold" buttons; both audit-logged. | `lib/paymentHold.ts`, `lib/checkout.ts` (`purchaseBlock`), `app/api/admin/payment-hold`, `AdminPaymentHold` |
| G3 | `charge.dispute.remind` is handled: admin is re-alerted (at most every 12 h per order) while a dispute is unanswered. | webhook |
| G4 | Optional tax line. Set `INVOICE_TAX_RATE_PCT` (e.g. `16`) and optionally `INVOICE_TAX_LABEL` (default `VAT`): invoices and credit notes show "Includes VAT at 16%". The rate is **frozen on each order** when placed, so changing it never rewrites an issued invoice. CSV export gains tax columns. Unset = unchanged. | `lib/invoiceTax.ts`, invoice pages, export |
| G5 | **Customer auto-recharge.** Tick "Save this card for auto-recharge" when paying by card; Billing → Auto-recharge sets the rule (below N GB → buy plan X; never more than $Y per 30 days). New `recharge` cron task every 5 min. Safeguards: MFA step-up, per-attempt claim + 30-min cooldown, 30-day cap (customer e-mailed once), switches itself off after 3 failed charges (e-mailed), suspended / disputed / held accounts skipped, card removed on account deletion, authorization code never sent to the browser. Orders are normal orders (invoice, confirmation e-mail, reconcile safety net). | `lib/autoRecharge.ts`, `lib/rechargeRules.ts`, `app/api/dashboard/billing/auto-recharge`, `AutoRechargePanel`, cron wiring |
| G6 | A declined refund's reason is visible on Billing (was hover-only). | billing page |

## Bugs fixed
| | What | Where |
|---|---|---|
| B1 | Invoice access lost the destination: 2FA sent people to Billing, sign-in dropped the link. Middleware now forwards the requested path. | `middleware.ts`, `app/invoice/layout.tsx` |
| B2 | A dispute on a never-credited order could not be recorded as lost (only a false "won"), leaving the account paused forever. Now recorded as lost (no clawback) and the account held. | `app/api/admin/dispute-outcome` |
| B3 | Invoice labelled chargeback credit notes "Refund". | invoice page |
| B4 | Last partial M-Pesa refund could ask Paystack for a shilling more than was left. Now capped to what remains of the charge. | `app/api/admin/refund-order` |
| B5 | Hardened `PaymentVerifier` against Paystack gluing `?trxref=…` onto the callback's own query string. | `components/PaymentVerifier.tsx` |

## After pushing
1. Run 0076 (above). 2. Optional: set `INVOICE_TAX_RATE_PCT` / `INVOICE_TAX_LABEL` Worker vars.
3. Admin → Settings → Scheduled tasks should list `recharge` after the next 5-minute tick.
4. Test once with a real card: tick "save card", pay, turn auto-recharge on with a threshold above your balance, watch one top-up.

## Verified / not verifiable here
- `npm run check` passes (schema sync, cron wiring, API docs, supplier ratchet, 21 tests, tsc). No new supplier-name mentions.
- Not testable from here: a live Paystack `charge_authorization` and the refund-remainder behaviour (B4's cap is defensive either way).
