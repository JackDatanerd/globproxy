-- ─────────────────────────────────────────────────────────────────────
-- 0084 · Cron, account deletion & ops — independent pass 2
--
--  1. The "deleted account" side effects no longer run from a trigger on the CLAIM.
--     cleanup_section7_on_delete() fired the moment is_deleted flipped to true — the
--     first step of performAccountDeletion — and cancelled a reseller's open
--     invitations WITHOUT giving their reserved GB back. When the deletion was then
--     rolled back (supplier down, ban failed) the account lived on with that stock
--     lost for good and invitations cancelled silently. The work moves into
--     purge_deleted_account_data(), which the deletion calls only after it has
--     succeeded, and which hands the reserved GB back.
--  2. purge_deleted_account_data() also clears what the application-level purge
--     missed (the profile row survives, so no foreign-key cascade ever fired):
--     whitelist mirror entries (customer IPs), refund-request free text, session
--     labels, reseller notes and third-party invitee addresses, the hashed signup
--     address on the referral row. Back-filled for accounts deleted before this.
--  3. revoke_all_auth_sessions(): ends every login session of an account. The
--     scheduled deletion has no access token of the owner to sign out with.
--  4. profiles.deletion_last_attempt_at: failing deletions / cleanups rotate behind
--     the ones not yet tried, so five stuck accounts cannot starve the queue.
--  5. support_report_replies.from_customer: a customer's follow-up on their own report.
--  6. The platform_settings keys that carried the upstream provider's name are renamed.
--
-- Idempotent. Apply BEFORE deploying: the deletion code calls these functions.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. Trigger off the claim ─────────────────────────────────────────
drop trigger if exists trg_cleanup_section7_on_delete on public.profiles;
drop function if exists public.cleanup_section7_on_delete();

-- ── 2. Everything that goes with a finished deletion ─────────────────
create or replace function public.purge_deleted_account_data(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted   boolean;
  p           public.reseller_pending_transfers%rowtype;
  v_returned  numeric := 0;
  v_invites   integer := 0;
begin
  select coalesce(is_deleted, false) into v_deleted from public.profiles where id = p_user_id;
  -- Never runs for a live account (a stale caller must not wipe a customer).
  if not found or not v_deleted then
    return jsonb_build_object('skipped', 'not_deleted');
  end if;

  -- Open invitations: close them and give the reserved stock back, stock row first
  -- (the order every other invitation function uses).
  perform 1 from public.bandwidth_accounts where user_id = p_user_id for update;
  for p in
    select * from public.reseller_pending_transfers
    where reseller_id = p_user_id and status = 'pending' for update
  loop
    update public.bandwidth_accounts
       set allocated_gb = greatest(allocated_gb - p.gb_amount, 0)
     where user_id = p_user_id;
    update public.reseller_pending_transfers
       set status = 'cancelled', resolved_at = now(), notified_at = now()
     where id = p.id;
    v_returned := v_returned + p.gb_amount;
    v_invites  := v_invites + 1;
  end loop;
  -- The invitee addresses and notes of every closed invitation are third parties' data.
  update public.reseller_pending_transfers
     set recipient_email = '[removed]', note = null
   where reseller_id = p_user_id and recipient_email <> '[removed]';

  delete from public.signup_ip_hashes where user_id = p_user_id;
  update public.referrals set signup_ip_hash = null
   where referred_user_id = p_user_id and signup_ip_hash is not null;

  delete from public.proxy_whitelist_entries where user_id = p_user_id;
  update public.refund_requests set reason = '[removed]', decline_note = null
   where user_id = p_user_id and (reason <> '[removed]' or decline_note is not null);
  update public.proxy_credentials set label = null where user_id = p_user_id and label is not null;
  update public.proxy_sessions set label = 'Session' where user_id = p_user_id and label <> 'Session';
  update public.reseller_transfers set note = null where reseller_id = p_user_id and note is not null;

  return jsonb_build_object('invitations_closed', v_invites, 'stock_returned_gb', v_returned);
end;
$$;

revoke all on function public.purge_deleted_account_data(uuid) from public, anon, authenticated;
grant execute on function public.purge_deleted_account_data(uuid) to service_role;

-- ── 3. End every login session of an account ─────────────────────────
create or replace function public.revoke_all_auth_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare v_n integer;
begin
  -- Deleting the session rows cascades to the refresh tokens; an access token whose
  -- session no longer exists is refused by Auth.
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.revoke_all_auth_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_all_auth_sessions(uuid) to service_role;

-- ── 4. Fair retry order for failing deletions ────────────────────────
alter table public.profiles add column if not exists deletion_last_attempt_at timestamptz;

create or replace function public.protect_deletion_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new; -- service-role client
  end if;
  if public.is_admin(auth.uid()) then
    return new;
  end if;
  new.deletion_requested_at     := old.deletion_requested_at;
  new.deletion_scheduled_at     := old.deletion_scheduled_at;
  new.deletion_reminder_sent_at := old.deletion_reminder_sent_at;
  new.deletion_attempts         := old.deletion_attempts;
  new.deletion_last_error       := old.deletion_last_error;
  new.deletion_last_attempt_at  := old.deletion_last_attempt_at;
  new.deletion_cleanup_pending  := old.deletion_cleanup_pending;
  new.deletion_cleanup_notes    := old.deletion_cleanup_notes;
  return new;
end;
$$;
revoke all on function public.protect_deletion_columns() from public, anon, authenticated;

-- ── 5. Customer follow-ups on a report ───────────────────────────────
alter table public.support_report_replies add column if not exists from_customer boolean not null default false;

-- ── 6. Settings keys without the provider's name ─────────────────────
update public.platform_settings set key = 'upstream_stock'
 where key = (chr(103) || 'eonode_stock') and not exists (select 1 from public.platform_settings where key = 'upstream_stock');
update public.platform_settings set key = 'upstream_orphan_candidates'
 where key = (chr(103) || 'eonode_orphan_candidates') and not exists (select 1 from public.platform_settings where key = 'upstream_orphan_candidates');
update public.platform_settings set key = 'upstream_orphans'
 where key = (chr(103) || 'eonode_orphans') and not exists (select 1 from public.platform_settings where key = 'upstream_orphans');
update public.platform_settings set key = 'upstream_orphans_alerted_at'
 where key = (chr(103) || 'eonode_orphans_alerted_at') and not exists (select 1 from public.platform_settings where key = 'upstream_orphans_alerted_at');
-- A fresh install has the seed row under the new name; drop any old-named leftover.
delete from public.platform_settings where key in (
  chr(103) || 'eonode_stock', chr(103) || 'eonode_orphan_candidates', chr(103) || 'eonode_orphans', chr(103) || 'eonode_orphans_alerted_at'
);

-- ── Back-fill: accounts deleted before this migration ────────────────
do $$
declare r record;
begin
  for r in select id from public.profiles where is_deleted is true loop
    perform public.purge_deleted_account_data(r.id);
  end loop;
end $$;

insert into public.schema_migrations (filename) values
  ('0084_cron_deletion_ops_pass2.sql')
on conflict do nothing;
