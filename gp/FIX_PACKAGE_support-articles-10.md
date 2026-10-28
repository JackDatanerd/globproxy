# Support articles, bit 10: Refund guide

Built on `0a5114e` (includes the ASN round-2 help-article edits). Changes: `lib/blog/posts.ts`, `lib/blog/help.ts`. No migration, no env change.

## Article added (help centre, Bandwidth & Pricing)
- `/help/request-a-refund-eligibility-and-timeline`: "How to Request a Refund: Eligibility, Steps and What Happens Next" (~5 min, 7 FAQs). Listed on /help under "Bandwidth and payments".
- Covers: who is eligible (policy page wording), problems that look like refund cases but have a faster fix (wrong country, payment not showing, session out of GB), freeing the GB first (Release unused GB), the exact Request refund steps, what each status and email means (Refund requested, processed email, credit note, refunded, declined with note, two-declined limit), where the money goes and timing (card vs M-Pesa in KES at the order's rate; 2 business days to reply, 5-10 to process), partial refunds (proportional GB taken back), special cases (charged twice, open dispute, used GB, deleting a session) and what to send support.
- Every on-screen label, toast and email string quoted was asserted against the code (billing page, refund-request route, billingEmails, policy page, ProxyCard); constants (72 h, 2 declines, 3-500 character reason) read from the route. The partial-refund example uses the same formula as apply_order_refund (GB x refund / amount). No supplier name, no "upstream". Description 152, title 65.

## Checks
tsc clean, supplier-leak OK, 195 tests pass.

## Observation, not changed
- A refund only takes back GB that are still in "Free to assign" (apply_order_refund caps the claw-back at the free balance and records the rest as a shortfall). The customer-facing policy says the same in one sentence; the article tells people to release unused GB first. If you want, a later change could show the shortfall to the admin on the order; today it is only in order_refunds.gb_shortfall.

## Also in this package
- One stale sentence in the "wrong city" help article (`ip-lookup-shows-wrong-city-proxy-location`): it still said a very narrow target is "one city plus one internet provider". Since ISP targeting is now country-wide and exclusive with state/city (your ASN round-2 commit), it now says "a single city".
