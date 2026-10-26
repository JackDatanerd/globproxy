# Admin inbox — support@globproxy.com

Apply migration **0091_admin_inbox.sql** in Supabase BEFORE deploying.

## What it is
- Mail to support@globproxy.com → Cloudflare Email Routing → the Worker's new `email()` handler (custom-worker.ts)
  → parsed with postal-mime (lib/inboxWorker.ts) → stored by `POST /api/internal/inbound-email` (CRON_SECRET) →
  `inbox_threads` / `inbox_messages` (service-role only, RLS on, no policies).
- Threading: In-Reply-To / References, else the `[GP-n]` ticket tag in the subject (only if the same sender owns that thread).
- Protection: de-duplicated by Message-ID, 40 messages/hour per sender, 10 MB cap, auto-replies/bounces/bulk stored but never
  mark a thread unread or reopen it, mail from support@ itself is dropped, HTML is never stored or rendered, attachments are
  recorded by name/size only.
- Admin UI: /admin/inbox (list, filters, search, unread badge in the sidebar), /admin/inbox/[id] (thread, close/reopen/waiting,
  assign, mark unread, link to the customer's account and open support reports, reply from support@ via Resend).
- Replies: stored first, sent with the row id as Idempotency-Key, marked sent / failed / unknown. Audit-logged (lengths only).
- A new human conversation e-mails ADMIN_EMAIL once (never if that is an inbox address).
- Account deletion removes the customer's conversations.

## Setup (once, in Cloudflare — see the delivery notes)
1. Email → Email Routing → enable for globproxy.com (adds the MX + SPF records).
2. Routing rule: support@globproxy.com → Send to a Worker → the globproxy Worker.
3. Optional: set the `INBOX_COPY_TO` Worker secret to a verified destination address to also get a copy of every stored message.
4. Resend: globproxy.com must be a verified sending domain (it already is for noreply@); support@ needs nothing extra.
