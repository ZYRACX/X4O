-- Apply this in Supabase SQL Editor for projects created with an older schema.
-- The room API selects winner_seat, and guest display names are stored as "G <name>".
alter table public.game_rooms add column if not exists winner_seat text;

alter table public.game_rooms drop constraint if exists game_rooms_creator_name_check;
alter table public.game_rooms
  add constraint game_rooms_creator_name_check check (char_length(creator_name) between 1 and 26);

alter table public.game_rooms drop constraint if exists game_rooms_player1_name_check;
alter table public.game_rooms
  add constraint game_rooms_player1_name_check check (char_length(player1_name) between 1 and 26);

alter table public.game_rooms drop constraint if exists game_rooms_player2_name_check;
alter table public.game_rooms
  add constraint game_rooms_player2_name_check check (player2_name is null or char_length(player2_name) between 1 and 26);
