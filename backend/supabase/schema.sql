create extension if not exists pgcrypto;

-- One profile is created with each Supabase Auth user. A unique lowercase key
-- reserves usernames without regard to capitalization.
create table if not exists public.player_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  username_key text generated always as (lower(username)) stored unique,
  created_at timestamptz not null default now()
);

create or replace function public.create_player_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.player_profiles (id, username)
  values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
exception when unique_violation then
  raise exception 'That username is already reserved.';
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users
for each row execute function public.create_player_profile();

alter table public.player_profiles enable row level security;
grant all on public.player_profiles to service_role;

-- Presence records support approximate live counts without depending on the
-- backend process staying awake. Account rows are shared across their tabs.
create table if not exists public.player_presence (
  id text primary key,
  account_id uuid references auth.users(id) on delete cascade,
  guest_id uuid,
  last_seen timestamptz not null default now(),
  check ((account_id is not null and guest_id is null) or (account_id is null and guest_id is not null))
);

create index if not exists player_presence_active_accounts
  on public.player_presence (last_seen desc) where account_id is not null;
create index if not exists player_presence_active_guests
  on public.player_presence (last_seen desc) where guest_id is not null;
alter table public.player_presence enable row level security;
grant all on public.player_presence to service_role;

create table if not exists public.game_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-F0-9]{6}$'),
  visibility text not null check (visibility in ('public', 'private')),
  status text not null check (status in ('waiting', 'playing', 'finished')),
  creator_name text not null check (char_length(creator_name) between 1 and 24),
  player1_name text not null check (char_length(player1_name) between 1 and 24),
  player2_name text check (player2_name is null or char_length(player2_name) between 1 and 24),
  player1_token_hash text not null,
  player2_token_hash text,
  board jsonb not null default jsonb_build_array(),
  scores jsonb not null default '{"X":0,"O":0}'::jsonb,
  turn text not null default 'X' check (turn in ('X', 'O')),
  winner_seat text check (winner_seat is null or winner_seat in ('X', 'O')),
  last_move integer check (last_move is null or last_move between 0 and 99),
  winning_cells jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz default (now() + interval '24 hours')
);

alter table public.game_rooms add column if not exists winner_seat text;

create index if not exists game_rooms_public_waiting_created
  on public.game_rooms (created_at desc)
  where visibility = 'public' and status = 'waiting';

alter table public.game_rooms enable row level security;
grant all on public.game_rooms to service_role;
-- The browser never accesses this table directly. The Render backend uses the
-- Supabase service role key, which bypasses RLS; do not add public policies.
