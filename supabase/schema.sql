-- Бухлоплан для Telegram: схема Supabase.
-- Выполните целиком в Supabase → SQL Editor → New query → Run.

-- 1. Документы (аналог базы артефакта: коллекция + id + JSON)
create table if not exists public.docs (
  collection text not null,           -- "events", "events/<id>/msgs", "promos", ...
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  created_by text default (auth.jwt() ->> 'sub'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
create index if not exists docs_collection_idx on public.docs (collection);
alter table public.docs replica identity full;   -- чтобы realtime присылал и удаления

-- 2. Профили участников (заполняет функция tg-auth при входе)
create table if not exists public.profiles (
  id         text primary key,        -- "tg_<telegram id>"
  name       text,
  avatar_url text,
  color      text,
  updated_at timestamptz not null default now()
);

-- 3. Глубокое слияние JSON (как update() в артефакте)
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb)
returns jsonb language sql immutable as $$
  select case
    when jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
      coalesce((
        select jsonb_object_agg(k,
          case when a ? k and b ? k then public.jsonb_deep_merge(a -> k, b -> k)
               when b ? k then b -> k
               else a -> k end)
        from (select jsonb_object_keys(a) k union select jsonb_object_keys(b)) keys
      ), '{}'::jsonb)
    else b end
$$;

-- update(): слить patch в документ. Работает с правами вызывающего (RLS действует).
create or replace function public.doc_update(p_collection text, p_id text, p_patch jsonb)
returns void language plpgsql security invoker as $$
begin
  update public.docs
     set data = public.jsonb_deep_merge(data, p_patch), updated_at = now()
   where collection = p_collection and id = p_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
end $$;

-- 4. Права (RLS)
alter table public.docs enable row level security;
alter table public.profiles enable row level security;

create or replace function public.me() returns text language sql stable as $$
  select auth.jwt() ->> 'sub'
$$;

-- Читать могут только вошедшие через Telegram
drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated using (true);

-- Афиша, места и служебные данные пишет только сервисный ключ (ежедневная задача)
-- Статус «тех. перерыва» — только свой. Остальное (тусовки, чат, фото) — все участники.
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated with check (
  collection not in ('promos','venues','meta')
  and (collection <> 'status' or id = public.me())
);

drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (collection not in ('promos','venues','meta') and (collection <> 'status' or id = public.me()))
  with check (collection not in ('promos','venues','meta') and (collection <> 'status' or id = public.me()));

-- Удалять тусовку/фото может только автор; статус — только свой; сообщения — автор.
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (
  collection not in ('promos','venues','meta')
  and (
    (collection = 'status' and id = public.me())
    or (collection <> 'status' and (data ->> 'by' = public.me() or created_by = public.me()))
  )
);

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.docs to authenticated;
grant select on public.profiles to authenticated;
grant execute on function public.doc_update(text, text, jsonb) to authenticated;

-- 5. Realtime
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 6. Хранилище фото: публичный бакет, загрузка только для вошедших, удаление — своих
insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
on conflict (id) do nothing;

drop policy if exists photos_insert on storage.objects;
create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = public.me());
drop policy if exists photos_delete on storage.objects;
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = public.me());
