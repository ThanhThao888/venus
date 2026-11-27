-- Venus Hub — 001_core.sql (Phase 2A)
-- Zone B (opt-in sync) tables: user_profile, decisions, user_devices.
-- Mirrors VenusMemoryDB v1 records. Every table: user_id + RLS (auth.uid() = user_id).
-- Soft delete only (deleted_at) → no DELETE policy and no DELETE grant.
-- Only the publishable key + the user's own JWT are ever used from the frontend; never a service_role/secret key.

-- ───────── helper: a revision may only go up (blocks accidental overwrite with an older copy) ─────────
create or replace function public.vpis_guard_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id or new.id is distinct from old.id then
    raise exception 'immutable_key: user_id and id cannot change' using errcode = 'P0001';
  end if;
  if new.revision <= old.revision then
    raise exception 'revision_conflict: stored revision is %, got %', old.revision, new.revision using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- ───────── user_profile ─────────
create table public.user_profile (
  user_id        uuid        not null references auth.users (id) on delete cascade,
  id             uuid        not null,
  revision       integer     not null check (revision >= 1),
  device_id      uuid,
  schema_version integer     not null default 1,
  payload        jsonb       not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  primary key (user_id, id)
);
create trigger user_profile_guard_revision before update on public.user_profile
  for each row execute function public.vpis_guard_revision();

-- ───────── decisions ─────────
-- Latest revision per (user_id, id). Full history lives in sync_changes (append-only, see 002_sync.sql).
create table public.decisions (
  user_id        uuid        not null references auth.users (id) on delete cascade,
  id             uuid        not null,
  revision       integer     not null check (revision >= 1),
  device_id      uuid,
  schema_version integer     not null default 1,
  payload        jsonb       not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  primary key (user_id, id)
);
create trigger decisions_guard_revision before update on public.decisions
  for each row execute function public.vpis_guard_revision();

-- ───────── user_devices ─────────
create table public.user_devices (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  device_id    uuid        not null,
  label        text        not null default '' check (char_length(label) <= 80),
  platform     text        not null default '' check (char_length(platform) <= 120),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_sync_at timestamptz,
  primary key (user_id, device_id)
);

-- ───────── RLS ─────────
alter table public.user_profile enable row level security;
alter table public.decisions    enable row level security;
alter table public.user_devices enable row level security;

create policy user_profile_select on public.user_profile for select to authenticated using ((select auth.uid()) = user_id);
create policy user_profile_insert on public.user_profile for insert to authenticated with check ((select auth.uid()) = user_id);
create policy user_profile_update on public.user_profile for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy decisions_select on public.decisions for select to authenticated using ((select auth.uid()) = user_id);
create policy decisions_insert on public.decisions for insert to authenticated with check ((select auth.uid()) = user_id);
create policy decisions_update on public.decisions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy user_devices_select on public.user_devices for select to authenticated using ((select auth.uid()) = user_id);
create policy user_devices_insert on public.user_devices for insert to authenticated with check ((select auth.uid()) = user_id);
create policy user_devices_update on public.user_devices for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ───────── privileges: not signed in = nothing; signed in = select/insert/update only ─────────
revoke all on table public.user_profile, public.decisions, public.user_devices from anon, authenticated;
grant select, insert, update on table public.user_profile, public.decisions, public.user_devices to authenticated;
