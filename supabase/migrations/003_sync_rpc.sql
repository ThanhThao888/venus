-- Venus Hub — 003_sync_rpc.sql (Phase 3A)
-- vpis_push(ops jsonb): the ONLY way a client writes to user_profile / decisions / sync_changes.
--   • SECURITY DEFINER but scoped by auth.uid() on every statement. A user_id sent by the client is never read.
--   • One call = at most 50 ops, processed in order, each in its own sub-transaction (a bad op cannot spoil the others).
--   • Idempotent: an op_id already recorded for this user returns "duplicate" and writes nothing.
--   • Optimistic concurrency: an existing entity accepts only revision = server revision + 1.
--     A brand-new entity accepts any revision >= 1 (a snapshot of an item that already lived on the device).
--   • After the first op of an entity that is not applied (conflict / invalid / error), the later ops of the SAME entity in this
--     call are "blocked": they must not skip over a lost change.
--   • One advisory lock per user makes `seq` order equal commit order, so a cursor `seq > N` never skips a row.
-- Result: { results: [ { op_id, status: ok|duplicate|conflict|blocked|invalid|error, seq?, reason?, server? } , … ] } (same order as ops)
-- Client contract: ok/duplicate → ack the op; conflict → record + hold the entity; blocked → keep; invalid/error → keep, show.

create or replace function public.vpis_push(ops jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_results  jsonb := '[]'::jsonb;
  v_blocked  text[] := '{}';
  v_re_uuid  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_re_iso   constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$';
  o          jsonb;
  v_op_id    uuid;
  v_type     text;
  v_eid      uuid;
  v_op       text;
  v_rev      integer;
  v_dev      uuid;
  v_payload  jsonb;
  v_key      text;
  v_found    boolean;
  s_rev      integer;
  s_payload  jsonb;
  s_dev      uuid;
  s_del      timestamptz;
  v_del      timestamptz;
  v_sv       integer;
  v_seq      bigint;
  v_reason   text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if ops is null or jsonb_typeof(ops) <> 'array' then
    raise exception 'bad_request: ops must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(ops) > 50 then
    raise exception 'too_many_ops: at most 50 per call' using errcode = '54000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('vpis_push:' || v_uid::text, 0));

  for o in select value from jsonb_array_elements(ops) loop
    v_op_id := null; v_key := null;   -- nothing may leak from the previous op
    begin
      -- ── parse ──
      if jsonb_typeof(o) <> 'object' then
        v_results := v_results || jsonb_build_object('op_id', null, 'status', 'invalid', 'reason', 'op_not_object');
        continue;
      end if;
      if jsonb_typeof(o->'op_id') <> 'string' or (o->>'op_id') !~ v_re_uuid then
        v_results := v_results || jsonb_build_object('op_id', null, 'status', 'invalid', 'reason', 'bad_op_id');
        continue;
      end if;
      v_op_id := (o->>'op_id')::uuid;

      -- ── idempotency ──
      select c.seq into v_seq from public.sync_changes c where c.user_id = v_uid and c.op_id = v_op_id;
      if found then
        v_results := v_results || jsonb_build_object('op_id', v_op_id, 'status', 'duplicate', 'seq', v_seq);
        continue;
      end if;

      -- ── validate ──
      v_type := o->>'entity_type';
      v_op   := o->>'op';
      v_payload := o->'payload';
      v_reason := case
        when v_type is null or v_type not in ('profile', 'decision') then 'bad_entity_type'
        when jsonb_typeof(o->'entity_id') <> 'string' or (o->>'entity_id') !~ v_re_uuid then 'bad_entity_id'
        when v_op is null or v_op not in ('upsert', 'delete') then 'bad_op'
        when jsonb_typeof(o->'revision') <> 'number' or (o->>'revision') !~ '^[0-9]{1,9}$' or (o->>'revision')::int < 1 then 'bad_revision'
        when v_payload is null or jsonb_typeof(v_payload) <> 'object' then 'bad_payload'
        when octet_length(v_payload::text) > 65536 then 'payload_too_large'
        when jsonb_typeof(v_payload->'id') <> 'string' or lower(v_payload->>'id') <> lower(o->>'entity_id') then 'payload_id_mismatch'
        when jsonb_typeof(v_payload->'revision') <> 'number' or (v_payload->>'revision') <> (o->>'revision') then 'payload_revision_mismatch'
        else null end;
      if v_reason is not null then
        if v_type in ('profile', 'decision') and (o->>'entity_id') ~ v_re_uuid then
          v_blocked := v_blocked || (v_type || ':' || lower(o->>'entity_id'));
        end if;
        v_results := v_results || jsonb_build_object('op_id', v_op_id, 'status', 'invalid', 'reason', v_reason);
        continue;
      end if;
      v_eid := (o->>'entity_id')::uuid;
      v_rev := (o->>'revision')::int;
      v_dev := case when (o->>'device_id') ~ v_re_uuid then (o->>'device_id')::uuid else null end;
      v_key := v_type || ':' || v_eid::text;

      if v_key = any (v_blocked) then
        v_results := v_results || jsonb_build_object('op_id', v_op_id, 'status', 'blocked', 'reason', 'earlier_op_for_entity_not_applied');
        continue;
      end if;

      -- ── current server copy ──
      if v_type = 'profile' then
        select t.revision, t.payload, t.device_id, t.deleted_at into s_rev, s_payload, s_dev, s_del
          from public.user_profile t where t.user_id = v_uid and t.id = v_eid;
      else
        select t.revision, t.payload, t.device_id, t.deleted_at into s_rev, s_payload, s_dev, s_del
          from public.decisions t where t.user_id = v_uid and t.id = v_eid;
      end if;
      v_found := found;

      if v_found and v_rev <> s_rev + 1 then
        v_blocked := v_blocked || v_key;
        v_results := v_results || jsonb_build_object(
          'op_id', v_op_id, 'status', 'conflict',
          'reason', case when v_rev <= s_rev then 'stale_revision' else 'revision_gap' end,
          'entity_type', v_type, 'entity_id', v_eid,
          'server', jsonb_build_object('revision', s_rev, 'payload', s_payload, 'device_id', s_dev, 'deleted_at', s_del));
        continue;
      end if;

      -- ── apply: row + change record in the same (sub)transaction ──
      v_del := case when v_op = 'delete'
                    then case when (v_payload->>'deleted_at') ~ v_re_iso then (v_payload->>'deleted_at')::timestamptz else now() end
                    else null end;
      v_sv := case when (v_payload->>'schema_version') ~ '^[0-9]{1,4}$' then (v_payload->>'schema_version')::int else 1 end;

      if v_type = 'profile' then
        insert into public.user_profile as t (user_id, id, revision, device_id, schema_version, payload, deleted_at)
          values (v_uid, v_eid, v_rev, v_dev, v_sv, v_payload, v_del)
        on conflict (user_id, id) do update
          set revision = excluded.revision, device_id = excluded.device_id, schema_version = excluded.schema_version,
              payload = excluded.payload, deleted_at = excluded.deleted_at, updated_at = now();
      else
        insert into public.decisions as t (user_id, id, revision, device_id, schema_version, payload, deleted_at)
          values (v_uid, v_eid, v_rev, v_dev, v_sv, v_payload, v_del)
        on conflict (user_id, id) do update
          set revision = excluded.revision, device_id = excluded.device_id, schema_version = excluded.schema_version,
              payload = excluded.payload, deleted_at = excluded.deleted_at, updated_at = now();
      end if;

      insert into public.sync_changes (user_id, op_id, entity_type, entity_id, revision, op, device_id, payload)
        values (v_uid, v_op_id, v_type, v_eid, v_rev, v_op, v_dev, v_payload)
        returning seq into v_seq;

      v_results := v_results || jsonb_build_object('op_id', v_op_id, 'status', 'ok', 'seq', v_seq);

    exception when others then
      -- this op's writes are rolled back; later ops of the same entity must not run ahead of it
      if v_key is not null then v_blocked := v_blocked || v_key; end if;
      v_results := v_results || jsonb_build_object('op_id', v_op_id, 'status', 'error', 'reason', 'server_error', 'code', sqlstate);
    end;
  end loop;

  return jsonb_build_object('results', v_results);
end;
$$;

revoke all on function public.vpis_push(jsonb) from public, anon, authenticated;
grant execute on function public.vpis_push(jsonb) to authenticated;

-- Single write path: a direct INSERT/UPDATE would skip sync_changes, so other devices would never see it.
-- (The insert/update RLS policies from 001 stay in place but are unreachable without the grant.) Reads are unchanged.
revoke insert, update on table public.user_profile, public.decisions from authenticated;
