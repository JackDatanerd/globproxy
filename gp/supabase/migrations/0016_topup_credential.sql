-- ============================================================
-- 0016 — Atomic credential top-up
-- ============================================================
-- Lets a customer add GB to a credential they already own instead of
-- always having to create a brand-new one when they run out. Two moving
-- parts have to stay in lockstep: (1) the account-level reservation in
-- bandwidth_accounts.allocated_gb and (2) that specific credential's
-- proxy_credentials.gb_allocated. Doing these as two separate statements
-- from application code would reopen the exact class of bug migration
-- 0015 just fixed for orders: if the process died or errored between
-- step 1 and step 2, the account would have reserved GB that no
-- credential's gb_allocated ever reflects — a stuck reservation with no
-- automatic recovery. Folding both into one plpgsql function means an
-- error anywhere rolls back everything, same rationale as
-- claim_and_credit_order() in 0015.
--
-- service_role-only (see grant below), not also granted to authenticated
-- — per migration 0012's point #3, new security-definer functions default
-- service_role-only unless there's a specific reason the browser session
-- needs direct RPC access. This one doesn't: the API route already
-- verifies the caller's identity via their own session before ever
-- calling this with createAdminClient(), same as claim_and_credit_order.
--
-- Ownership/eligibility are enforced inside the function too, defense in
-- depth against this function ever being called incorrectly:
--   - created_by must be null (self-owned). Reseller-allocated credentials
--     are their reseller's commitment to the client, not the client's own
--     balance to spend against — same rule DELETE already enforces.
--   - status must be 'active' or 'pending'. A 'suspended' credential
--     (set on account deletion — see admin/delete-user, user/delete-account)
--     must not be extendable.
--
-- Returns the credential's NEW gb_allocated total, so the caller knows
-- exactly what trafficLimitMB to PATCH into upstream for 'active'
-- credentials with a real sub-user already provisioned. For 'pending'
-- credentials (no sub-user yet, provider was down at creation time), no
-- upstream call is needed here — activateBandwidth()'s existing
-- retry-on-next-order logic already reads gb_allocated fresh when it
-- eventually provisions them.

create or replace function public.topup_credential(
  p_credential_id uuid,
  p_user_id uuid,
  p_gb numeric
)
returns numeric
language plpgsql
security definer
as $$
declare
  v_status text;
  v_created_by uuid;
  v_new_total numeric;
  v_reserved numeric;
begin
  if p_gb is null or p_gb <= 0 then
    raise exception 'Top-up amount must be greater than 0';
  end if;

  select status, created_by into v_status, v_created_by
  from public.proxy_credentials
  where id = p_credential_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;

  if v_created_by is not null then
    raise exception 'This credential was allocated by your reseller and cannot be topped up directly. Contact them.';
  end if;

  if v_status not in ('active', 'pending') then
    raise exception 'Only active or pending credentials can be topped up.';
  end if;

  -- Reserve against the account balance first — same locked-update guard
  -- reserve_credential_bandwidth() uses (migration 0009's corrected
  -- total_gb - allocated_gb formula).
  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_user_id
    and (total_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_reserved;

  if v_reserved is null then
    raise exception 'Insufficient bandwidth in your account.' using errcode = 'P0001';
  end if;

  -- Only now, with the reservation already committed in this same
  -- transaction, bump the credential's own allocation.
  update public.proxy_credentials
  set gb_allocated = gb_allocated + p_gb
  where id = p_credential_id
  returning gb_allocated into v_new_total;

  return v_new_total;
end;
$$;

revoke all on function public.topup_credential(uuid, uuid, numeric) from public;
grant execute on function public.topup_credential(uuid, uuid, numeric) to service_role;
