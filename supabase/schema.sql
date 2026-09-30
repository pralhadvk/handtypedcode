-- handtypedcode database setup
-- Paste this whole file into Supabase > SQL Editor and click "Run".
-- Safe to run again: it drops and recreates the function, policies and trigger.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  username    text not null unique,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

create table if not exists public.snippets (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 90),
  lang        text not null,
  code        text not null check (char_length(code) between 20 and 8000),
  stats       jsonb not null,           -- computed by the server from the recording
  rhythm      jsonb,                    -- small chart data for gallery cards
  created_at  timestamptz not null default now()
);

create index if not exists snippets_created_at_idx on public.snippets (created_at desc);
create index if not exists snippets_author_idx on public.snippets (author_id, created_at desc);

-- The keystroke recording lives in its own table so the gallery stays light.
create table if not exists public.snippet_logs (
  snippet_id  uuid primary key references public.snippets (id) on delete cascade,
  ops         jsonb not null            -- [[ms_since_last_key, position, chars_deleted, text_inserted], ...]
);

-- ---------------------------------------------------------------------------
-- Row level security: everyone can read, nobody writes directly.
-- New snippets only go in through publish_snippet() below.
-- ---------------------------------------------------------------------------

alter table public.profiles     enable row level security;
alter table public.snippets     enable row level security;
alter table public.snippet_logs enable row level security;

drop policy if exists "profiles are public"      on public.profiles;
drop policy if exists "snippets are public"      on public.snippets;
drop policy if exists "logs are public"          on public.snippet_logs;
drop policy if exists "authors delete snippets"  on public.snippets;

create policy "profiles are public"     on public.profiles     for select using (true);
create policy "snippets are public"     on public.snippets     for select using (true);
create policy "logs are public"         on public.snippet_logs for select using (true);
create policy "authors delete snippets" on public.snippets     for delete to authenticated
  using ((select auth.uid()) = author_id);

-- ---------------------------------------------------------------------------
-- Profiles: created automatically from the GitHub account on first sign-in.
-- ---------------------------------------------------------------------------

create or replace function public.ensure_profile(uid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta  jsonb;
  base  text;
  uname text;
  n     int := 0;
begin
  if exists (select 1 from public.profiles where id = uid) then
    return;
  end if;
  select raw_user_meta_data into meta from auth.users where id = uid;
  base := lower(regexp_replace(coalesce(meta ->> 'user_name', meta ->> 'preferred_username', 'typist'), '[^A-Za-z0-9_-]', '', 'g'));
  if base = '' then base := 'typist'; end if;
  uname := base;
  while exists (select 1 from public.profiles where username = uname) loop
    n := n + 1;
    uname := base || '-' || n;
  end loop;
  insert into public.profiles (id, username, avatar_url)
  values (uid, uname, meta ->> 'avatar_url')
  on conflict (id) do nothing;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ensure_profile(new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- publish_snippet: the only way to add a snippet.
-- It replays the whole recording on the server and refuses to save unless
-- the keystrokes rebuild the code exactly, with no chunks over 16 characters
-- inserted at once and a typing speed a human could manage.
-- Stats are computed here too, so they can't be edited by hand.
-- ---------------------------------------------------------------------------

drop function if exists public.publish_snippet(text, text, text, jsonb, jsonb);

create function public.publish_snippet(
  p_title  text,
  p_lang   text,
  p_code   text,
  p_ops    jsonb,
  p_rhythm jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid        uuid := auth.uid();
  t          text := '';
  op         jsonb;
  dt         bigint;
  pos        int;
  del        int;
  ins        text;
  n_ops      int;
  duration   bigint := 0;
  active     bigint := 0;
  typed      int := 0;
  deleted    int := 0;
  fixes      int := 0;
  longest    bigint := 0;
  multi      int := 0;
  new_id     uuid;
  langs      text[] := array['javascript','typescript','python','go','rust','c','cpp','java','kotlin','swift','ruby','php','xml','css','sql','bash','plaintext'];
begin
  if uid is null then
    raise exception 'Sign in to publish.';
  end if;

  p_title := btrim(coalesce(p_title, ''));
  if char_length(p_title) not between 1 and 90 then
    raise exception 'Titles need 1 to 90 characters.';
  end if;
  if not (p_lang = any (langs)) then
    raise exception 'Unknown language.';
  end if;
  if p_code is null or char_length(p_code) not between 20 and 8000 then
    raise exception 'Snippets need 20 to 8,000 characters.';
  end if;
  if jsonb_typeof(p_ops) is distinct from 'array' then
    raise exception 'The recording is missing.';
  end if;
  n_ops := jsonb_array_length(p_ops);
  if n_ops < 10 or n_ops > 30000 then
    raise exception 'The recording is too short or too long.';
  end if;

  -- One person, at most 30 snippets a day.
  if (select count(*) from public.snippets
      where author_id = uid and created_at > now() - interval '1 day') >= 30 then
    raise exception 'Daily limit reached. Try again tomorrow.';
  end if;

  for op in select value from jsonb_array_elements(p_ops) loop
    if jsonb_typeof(op) is distinct from 'array' or jsonb_array_length(op) <> 4
       or jsonb_typeof(op -> 0) <> 'number' or jsonb_typeof(op -> 1) <> 'number'
       or jsonb_typeof(op -> 2) <> 'number' or jsonb_typeof(op -> 3) <> 'string' then
      raise exception 'The recording is damaged.';
    end if;
    dt  := (op ->> 0)::numeric::bigint;
    pos := (op ->> 1)::int;
    del := (op ->> 2)::int;
    ins := op ->> 3;
    if dt < 0 or pos < 0 or del < 0 or pos + del > char_length(t) then
      raise exception 'The recording is damaged.';
    end if;
    -- No pasting: more than 16 characters in one step is only allowed for whitespace (auto-indent).
    if char_length(ins) > 16 and ins !~ '^\s+$' then
      raise exception 'The recording contains a pasted chunk.';
    end if;

    t := substr(t, 1, pos) || ins || substr(t, pos + del + 1);

    duration := duration + dt;
    active   := active + least(dt, 5000);
    typed    := typed + char_length(ins);
    deleted  := deleted + del;
    if del > 0 then fixes := fixes + 1; end if;
    if dt > longest then longest := dt; end if;
    if char_length(ins) > 1 and ins !~ '^\s+$' then multi := multi + 1; end if;
  end loop;

  if t <> p_code then
    raise exception 'The recording does not rebuild this code.';
  end if;

  -- Faster than any human typist is a script, not a person.
  if active = 0 or (typed / 5.0) / (active / 60000.0) > 300 then
    raise exception 'That recording is faster than a human can type.';
  end if;

  perform public.ensure_profile(uid);

  insert into public.snippets (author_id, title, lang, code, stats, rhythm)
  values (
    uid, p_title, p_lang, p_code,
    jsonb_build_object(
      'duration', duration,
      'keys', n_ops,
      'typed', typed,
      'deleted', deleted,
      'corrections', fixes,
      'longestPause', longest,
      'multi', multi,
      'wpm', case when active > 0 then round((typed / 5.0) / (active / 60000.0)) else 0 end
    ),
    case when jsonb_typeof(p_rhythm) = 'object' and pg_column_size(p_rhythm) < 4000 then p_rhythm else null end
  )
  returning id into new_id;

  insert into public.snippet_logs (snippet_id, ops) values (new_id, p_ops);
  return new_id;
end;
$$;

revoke all on function public.publish_snippet(text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.publish_snippet(text, text, text, jsonb, jsonb) to authenticated;
revoke all on function public.ensure_profile(uuid) from public, anon, authenticated;
