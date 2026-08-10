-- ============================================================
-- 0019 — Account-level default auto-allocate
-- ============================================================
-- Auto-allocate (migration 0017) is configured per-session, which meant
-- every new session needed its own threshold/amount typed in even for
-- someone who wants the exact same behavior on all of them. This adds a
-- default on the account itself: set once, and every new session's
-- creation form pre-fills from it (still overridable per session before
-- submitting — this is a starting point, not a forced policy).
--
-- Deliberately does NOT retroactively apply to existing sessions when
-- changed — set_default_auto_topup() below only ever touches
-- bandwidth_accounts, never proxy_credentials. Changing your default
-- shouldn't silently flip auto-allocate on for sessions you already
-- configured (or deliberately left off) one at a time.

alter table public.bandwidth_accounts
  add column if not exists default_auto_topup_enabled boolean not null default false,
  add column if not exists default_auto_topup_threshold_gb numeric,
  add column if not exists default_auto_topup_amount_gb numeric;

alter table public.bandwidth_accounts
  add constraint bwacct_default_auto_topup_threshold_nonneg
    check (default_auto_topup_threshold_gb is null or default_auto_topup_threshold_gb >= 0);
alter table public.bandwidth_accounts
  add constraint bwacct_default_auto_topup_amount_positive
    check (default_auto_topup_amount_gb is null or default_auto_topup_amount_gb > 0);
alter table public.bandwidth_accounts
  add constraint bwacct_default_auto_topup_requires_config
    check (
      not default_auto_topup_enabled
      or (default_auto_topup_threshold_gb is not null and default_auto_topup_amount_gb is not null)
    );

-- bandwidth_accounts has select-own RLS only (schema.sql: "Own
-- bandwidth") — no update policy, same reasoning as proxy_credentials:
-- writes go through a service_role RPC that validates the input, not
-- direct client writes. Mirrors set_auto_topup() (0017) exactly, just
-- scoped to the account row instead of a single credential.
create or replace function public.set_default_auto_topup(
  p_user_id uuid,
  p_enabled boolean,
  p_threshold_gb numeric,
  p_amount_gb numeric
)
returns void
language plpgsql
security definer
as $$
begin
  if p_enabled then
    if p_threshold_gb is null or p_threshold_gb < 0 then
      raise exception 'threshold_gb must be 0 or greater';
    end if;
    if p_amount_gb is null or p_amount_gb <= 0 then
      raise exception 'amount_gb must be greater than 0';
    end if;
  end if;

  update public.bandwidth_accounts
  set default_auto_topup_enabled = p_enabled,
      default_auto_topup_threshold_gb = case when p_enabled then p_threshold_gb else null end,
      default_auto_topup_amount_gb = case when p_enabled then p_amount_gb else null end
  where user_id = p_user_id;

  if not found then
    raise exception 'Bandwidth account not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.set_default_auto_topup(uuid, boolean, numeric, numeric) from public;
grant execute on function public.set_default_auto_topup(uuid, boolean, numeric, numeric) to service_role;
