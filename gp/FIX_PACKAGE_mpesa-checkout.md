# Fix package — M-Pesa checkout, self-serve Scale, custom quantity

**Apply order: run `supabase/migrations/0048_mpesa_checkout.sql` BEFORE deploying the code.** (0047 must already be applied.)

## M-Pesa (KES) via Paystack mobile money
- Buy page offers "Card (USD)" or "M-Pesa (KES)" when a rate is available. M-Pesa uses Paystack's `mobile_money` channel through the same popup/webhook/verify/reconcile/refund pipeline as cards (STK push to the customer's phone).
- Prices and invoices stay in USD. An M-Pesa order locks the KES amount (`orders.pay_amount`, whole shillings, rounded up) and the rate (`orders.fx_rate`) at creation. Verification, reconcile and the webhook compare against that KES amount/currency (`expectedCharge` in lib/paystack.ts); a USD payment against a KES order (or vice-versa) is rejected as a mismatch.
- Refunds arrive in KES and are converted to USD with the order's own locked ratio (full KES refund = full USD price), then go through the same `apply_order_refund` (claw-back, credit note, emails).
- **Live FX** (lib/fx.ts): market rate from open.er-api.com, falling back to a second feed (currency-api via jsDelivr); cached in `platform_settings` for 6 h; a rate outside 50–500 KES or >15 % away from the last good one is rejected; stale cache (≤72 h) → admin manual fallback → otherwise M-Pesa is hidden (never guesses). Customer rate = market + markup (default 2 %, max 10 %).
- If the rate moves >1 % between the page load and clicking pay, checkout answers 409 and the page shows the new KES price for re-confirmation — customers are never charged an amount they didn't see.
- Admin → Settings has an "M-Pesa checkout" panel: on/off switch, markup %, manual fallback rate, live quote readout, "Refresh rate now". Changes are audit-logged.
- Invoice, billing page, receipt email, CSV export and admin Orders show the KES charged for M-Pesa orders.

## Self-serve Scale
Scale (500 GB, $1,000) is now bought through normal checkout like every other plan; the buy page footer keeps a "contact sales" line for >499 GB.

## Custom quantity
Any whole number of GB 1–499. Per-GB rate = the largest plan that fits; total is capped at the next plan up, so nobody pays more for fewer GB than a bigger bundle (9 GB = $35 because 10 GB = $35). Priced server-side from `resolveOrder()` (lib/plans.ts), shared with the UI. "Pay now"/"Try again" on Billing reopens custom and M-Pesa orders correctly.

## Still manual / not done
- Paystack must have M-Pesa enabled for the KES currency on the live account (confirmed).
- The two FX feeds could not be reached from the build sandbox, so the response parsing is written to each provider's documented shape and covered by simulated-feed tests, not a live call. First checkout after deploy will show the real result under Admin → Settings → M-Pesa (source: live).
