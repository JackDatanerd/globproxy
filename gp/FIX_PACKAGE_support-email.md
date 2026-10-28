# Support email: Report an issue → support@ inbox, and never miss a customer reply

Built on `13911b4`. **No migration, no env change.** ADMIN_EMAIL (already set, your personal address) is the alert address.

## Report an issue now goes through support@globproxy.com
- Before: a report was saved to `support_reports` and e-mailed straight to ADMIN_EMAIL ("[ISSUE REPORTED]").
- Now: the report is still saved to `support_reports` (customer's Support page, /admin/support) **and filed in the shared inbox** as a conversation from the customer (`ingestReport` in lib/inboxIngest.ts), linked to their account. You read and answer it in /admin/inbox; the reply leaves from support@ with the usual [GP-n] tag, and the customer's answer threads back.
- Follow-ups added from the dashboard land in the same conversation.
- No e-mail hop: the customer is known from their session, so nothing depends on a From header.
- Safety net: if filing in the inbox throws for any reason, the old direct e-mail to ADMIN_EMAIL is sent instead. A report is never silent.
- Filing is idempotent (message id derived from the report id).

## The alert to your personal inbox (one helper, `lib/inboxNotify.ts`)
- Already existed for the first message of a new conversation. Now also used for reports and follow-ups.
- **New:** a customer's reply into an existing conversation alerts you too (subject "[INBOX] New reply from …"), including a reply to a conversation you had closed. To avoid one mail per message in a long back-and-forth, it does not alert if the conversation was already sitting unread; the first unread message of each stretch always alerts.
- Automatic mail (out-of-office, bounces) never alerts. Never sent to an inbox address (would loop). A failed send is now logged (the old code ignored a refused send).

## Checks
tsc clean, supplier-leak OK, 178 tests pass (4 new in tests/support-inbox.test.mjs). The ingest, threading, unread and alert rules were also run against an in-memory database and a stubbed mail API.

## Behaviour to know
- /admin/support still lists reports and its Resolve button is separate from the inbox's Close; resolving one does not close the other. The inbox thread page already shows "N open support reports →" for linked customers.
- Replying from /admin/support still works as before (that e-mail comes from the no-reply address with reply-to support@).
