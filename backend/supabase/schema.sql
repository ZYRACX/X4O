create extension if not exists pgcrypto;

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
  last_move integer check (last_move is null or last_move between 0 and 99),
  winning_cells jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz default (now() + interval '24 hours')
);

create index if not exists game_rooms_public_waiting_created
  on public.game_rooms (created_at desc)
  where visibility = 'public' and status = 'waiting';

alter table public.game_rooms enable row level security;
grant all on public.game_rooms to service_role;
-- The browser never accesses this table directly. The Render backend uses the
-- Supabase service role key, which bypasses RLS; do not add public policies.
