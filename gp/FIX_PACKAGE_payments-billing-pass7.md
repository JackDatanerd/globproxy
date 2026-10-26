# Fix package — Section 3: Payments & billing, round 7

Apply order: **run `supabase/migrations/0096_payments_billing_pass7.sql` in Supabase FIRST**, then push
(deploy.yml's migration gate refuses to deploy until it is recorded). Idempotent; already folded into `schema.sql`.
The refund webhook calls the new function, so deploying before the migration would fail every refund event.

## Bugs fixed
| | What | Where |
|---|---|---|
| B1 | Credit-note numbers could have gaps (a sequence's `nextval` survives a rollback). Now drawn from a counter updated in the refund's own transaction, like invoice numbers since 0093; numbering continues from the highest issued. | `0096`, `apply_order_refund` |
| B2 | Billing offered Cancel / Pay again on an automatic top-up still in flight; the label changed but the charge did not stop, and it dropped out of the 30-day limit total. Both buttons are hidden for auto-recharge orders. | `app/dashboard/billing/page.tsx` |
| B3 | "Save this card" only worked when the webhook was the path that saw the payment. verify-payment and the reconcile cron now store it too (one shared helper). | `lib/autoRecharge.ts`, webhook, verify-payment, cron |
| B4 | A `charge.dispute.resolve` event could overwrite an admin's Dispute lost / won made between its read and write. The write is now conditional on the status it read; if it changed, the newer outcome is kept and the admin alert says so. | webhook |

## Verified
`tsc --noEmit` clean, schema-sync / cron / supplier checks pass, 141 tests pass (4 new in `tests/payments-pass7.test.mjs`).
Not testable here: the migration against a live Postgres.
