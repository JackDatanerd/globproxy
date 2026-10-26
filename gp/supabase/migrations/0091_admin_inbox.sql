-- 0091: Admin shared inbox (support@globproxy.com)
--
-- Mail sent to support@globproxy.com is received by the Cloudflare Worker's email() handler
-- (custom-worker.ts), parsed there, and handed to POST /api/internal/inbound-email, which stores
-- it here. Staff read and answer it in /admin/inbox; replies leave through Resend from
-- support@globproxy.com and are stored as outbound messages on the same thread.
--
--   inbox_threads   one conversation with one customer address (ticket_no is the human reference
--                   put in the subject as [GP-1042] so a reply that lost its headers still threads)
--   inbox_messages  every inbound and outbound message; text only — HTML is never stored or
--                   rendered, and attachments are recorded by name / type / size, not kept
--
-- Both tables are for the service role ONLY: row-level security is on and no policy exists, so a
-- customer's own session can never read another customer's mail. A trigger keeps the thread's
-- counters, unread flag and status right whichever code path inserts a message.
--
-- Safe to run against the live DB: idempotent.

create table if not exists public.inbox_threads (
  id               uuid primary key default gen_random_uuid(),
  ticket_no        bigint generated always as identity,
  mailbox          text not null default 'support',
  subject          text not null default '(no subject)',
  customer_email   text not null,
  customer_user_id uuid references public.profiles(id) on delete set null,
  status           text not null default 'open',
  assigned_to      uuid references public.profiles(id) on delete set null,
  unread           boolean not null default true,
  message_count    integer not null default 0,
  last_message_at  timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  constraint inbox_threads_status_valid check (status in ('open', 'pending', 'closed')),
  constraint inbox_threads_ticket_unique unique (ticket_no)
);

create index if not exists inbox_threads_status_last_idx on public.inbox_threads (status, last_message_at desc);
create index if not exists inbox_threads_customer_email_idx on public.inbox_threads (customer_email);
create index if not exists inbox_threads_customer_user_idx on public.inbox_threads (customer_user_id) where customer_user_id is not null;
create index if not exists inbox_threads_assigned_idx on public.inbox_threads (assigned_to) where assigned_to is not null;

create table if not exists public.inbox_messages (
  id               uuid primary key default gen_random_uuid(),
  thread_id        uuid not null references public.inbox_threads(id) on delete cascade,
  direction        text not null,
  message_id       text,                       -- RFC 5322 Message-ID, without the angle brackets
  in_reply_to      text,
  reference_ids    text[] not null default '{}',
  from_email       text not null,
  from_name        text,
  to_emails        text[] not null default '{}',
  cc_emails        text[] not null default '{}',
  subject          text,
  text_body        text not null default '',
  had_html         boolean not null default false,
  attachments      jsonb not null default '[]'::jsonb,   -- [{ filename, type, size }] — metadata only
  is_auto          boolean not null default false,       -- auto-reply / bounce / bulk: never reopens or un-reads a thread
  sent_by          uuid references public.profiles(id) on delete set null,
  provider_id      text,                                  -- Resend id of an outbound message
  delivery_status  text,                                  -- outbound only: sent | failed | unknown
  delivery_error   text,
  created_at       timestamptz not null default now(),
  constraint inbox_messages_direction_valid check (direction in ('in', 'out')),
  constraint inbox_messages_delivery_valid check (delivery_status is null or delivery_status in ('sent', 'failed', 'unknown'))
);

create unique index if not exists inbox_messages_message_id_uniq on public.inbox_messages (message_id) where message_id is not null;
create index if not exists inbox_messages_thread_idx on public.inbox_messages (thread_id, created_at);
create index if not exists inbox_messages_from_recent_idx on public.inbox_messages (from_email, created_at desc) where direction = 'in';

alter table public.inbox_threads  enable row level security;
alter table public.inbox_messages enable row level security;
revoke all on public.inbox_threads  from anon, authenticated;
revoke all on public.inbox_messages from anon, authenticated;
grant all on public.inbox_threads  to service_role;
grant all on public.inbox_messages to service_role;

-- Keeps the thread honest whichever code path adds a message:
--   * every message counts and moves last_message_at
--   * a human inbound message marks the thread unread and reopens a closed one
--   * automatic mail (is_auto) changes neither the unread flag nor the status
--   * a delivered outbound message does not touch them either (the reply route sets 'pending')
create or replace function public.inbox_message_inserted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.inbox_threads t set
    message_count   = t.message_count + 1,
    last_message_at = greatest(t.last_message_at, new.created_at),
    unread          = case when new.direction = 'in' and not new.is_auto then true else t.unread end,
    status          = case when new.direction = 'in' and not new.is_auto and t.status = 'closed' then 'open' else t.status end
  where t.id = new.thread_id;
  return new;
end $$;

drop trigger if exists inbox_message_inserted on public.inbox_messages;
create trigger inbox_message_inserted after insert on public.inbox_messages
  for each row execute function public.inbox_message_inserted();

revoke all on function public.inbox_message_inserted() from public, anon, authenticated;

insert into public.schema_migrations (filename) values
  ('0091_admin_inbox.sql')
on conflict do nothing;
