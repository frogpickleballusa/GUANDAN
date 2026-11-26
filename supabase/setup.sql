-- Guandan Table: one-time setup. Paste into Supabase → SQL Editor → Run.

-- Public part of each table: setup, seats, and the game as everyone may see it (no hands).
create table if not exists public.rooms (
  code text primary key,
  cfg jsonb not null,
  seats jsonb not null,
  pub jsonb,
  ver bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- The full game including every hand. No policies: only the server function can read it.
create table if not exists public.room_private (
  code text primary key references public.rooms(code) on delete cascade,
  full_state jsonb
);

-- Each seat's cards. A player can only ever read rows for their own seats.
create table if not exists public.hands (
  code text not null references public.rooms(code) on delete cascade,
  seat int not null,
  uid uuid not null,
  cards jsonb not null,
  opts jsonb,
  primary key (code, seat)
);

alter table public.rooms enable row level security;
alter table public.room_private enable row level security;
alter table public.hands enable row level security;

drop policy if exists "rooms are readable by players" on public.rooms;
create policy "rooms are readable by players" on public.rooms for select to authenticated using (true);

drop policy if exists "players read only their own hand" on public.hands;
create policy "players read only their own hand" on public.hands for select to authenticated using (uid = auth.uid());

-- Live updates for rooms and hands.
do $$ begin
  begin alter publication supabase_realtime add table public.rooms; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.hands; exception when duplicate_object then null; end;
end $$;

-- Atomic save used by the server function. Fails (returns -1) if someone else saved first.
create or replace function public.save_room(
  p_code text, p_ver bigint, p_cfg jsonb, p_seats jsonb, p_pub jsonb,
  p_full jsonb, p_hands jsonb, p_clear_hands boolean
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  update rooms set cfg = p_cfg, seats = p_seats, pub = p_pub, ver = ver + 1, updated_at = now()
    where code = p_code and ver = p_ver returning ver into v;
  if v is null then return -1; end if;
  insert into room_private (code, full_state) values (p_code, p_full)
    on conflict (code) do update set full_state = excluded.full_state;
  if p_clear_hands then delete from hands where code = p_code; end if;
  insert into hands (code, seat, uid, cards, opts)
    select p_code, (h->>'seat')::int, (h->>'uid')::uuid, h->'cards', nullif(h->'opts', 'null'::jsonb)
    from jsonb_array_elements(coalesce(p_hands, '[]'::jsonb)) h
    on conflict (code, seat) do update set uid = excluded.uid, cards = excluded.cards, opts = excluded.opts;
  return v;
end $$;

revoke all on function public.save_room(text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.save_room(text, bigint, jsonb, jsonb, jsonb, jsonb, jsonb, boolean) to service_role;

-- Tables untouched for 30 days are removed, so the free database stays small.
create or replace function public.cleanup_old_rooms() returns void
language sql security definer set search_path = public as $$
  delete from rooms where updated_at < now() - interval '30 days';
$$;
revoke all on function public.cleanup_old_rooms() from public, anon, authenticated;
grant execute on function public.cleanup_old_rooms() to service_role;
