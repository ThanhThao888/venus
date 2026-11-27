-- Venus Hub — 002_sync.sql (Phase 2A)
-- sync_changes: ordered, append-only change log. Devices pull with `seq > last_sync_cursor` (Phase 3).
-- op_id makes pushes idempotent: the same op can never be recorded twice for a user.
-- Clients can only READ this table. Writing will go through a Phase 3 RPC that checks expected_revision
-- and writes the row + the change record in one transaction, so there is intentionally no INSERT policy or grant here.

create table public.sync_changes (
  seq         bigint      generated always as identity primary key,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  op_id       uuid        not null,
  entity_type text        not null check (entity_type in ('profile', 'decision')),
  entity_id   uuid        not null,
  revision    integer     not null check (revision >= 1),
  op          text        not null check (op in ('upsert', 'delete')),
  device_id   uuid,
  payload     jsonb       not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  created_at  timestamptz not null default now(),
  unique (user_id, op_id)
);
create index sync_changes_user_seq_idx on public.sync_changes (user_id, seq);
create index sync_changes_entity_idx   on public.sync_changes (user_id, entity_type, entity_id, revision);

alter table public.sync_changes enable row level security;
create policy sync_changes_select on public.sync_changes for select to authenticated using ((select auth.uid()) = user_id);

revoke all on table public.sync_changes from anon, authenticated;
grant select on table public.sync_changes to authenticated;
