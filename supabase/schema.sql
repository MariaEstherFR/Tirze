-- =============================================================
--  Esquema de base de datos para Supabase (PostgreSQL)
--  Ejecutar COMPLETO en: Supabase → SQL Editor → New query → Run
--  Se puede volver a ejecutar sin perder datos.
-- =============================================================

-- -------------------------------------------------------------
-- 1. Dueño / administrador de la app (solo puede existir UNO)
-- -------------------------------------------------------------
create table if not exists public.app_owner (
  id         boolean primary key default true check (id),   -- fuerza una sola fila
  user_id    uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_owner enable row level security;
revoke all on public.app_owner from anon, authenticated;     -- nadie la toca directamente

-- ¿Ya se creó el administrador? (lo usa la pantalla de inicio)
create or replace function public.owner_exists() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.app_owner) $$;

-- ¿El usuario conectado es el dueño?
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.app_owner where user_id = auth.uid()) $$;

-- El primer usuario que inicia sesión se convierte en dueño; luego queda bloqueado
create or replace function public.claim_owner() returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Debe iniciar sesión';
  end if;
  insert into public.app_owner (id, user_id) values (true, auth.uid())
  on conflict (id) do nothing;
  return public.is_owner();
end;
$$;

revoke execute on function public.owner_exists() from public, anon, authenticated;
revoke execute on function public.is_owner()     from public, anon, authenticated;
revoke execute on function public.claim_owner()  from public, anon, authenticated;
grant  execute on function public.owner_exists() to anon, authenticated;
grant  execute on function public.is_owner()     to authenticated;
grant  execute on function public.claim_owner()  to authenticated;

-- -------------------------------------------------------------
-- 2. Pacientes
-- -------------------------------------------------------------
create table if not exists public.pacientes (
  id               uuid primary key default gen_random_uuid(),
  ci               text not null unique check (length(trim(ci)) between 3 and 20),
  nombre           text not null check (length(trim(nombre)) > 0),
  apellido         text not null check (length(trim(apellido)) > 0),
  fecha_nacimiento date not null check (fecha_nacimiento >= date '1900-01-01'),
  altura_cm        numeric(5,1) not null check (altura_cm between 30 and 250),
  creado_en        timestamptz not null default now(),
  creado_por       uuid default auth.uid() references auth.users (id) on delete set null
);

-- -------------------------------------------------------------
-- 3. Registros de control (peso, IMC, medicamento, dosis)
-- -------------------------------------------------------------
create table if not exists public.registros (
  id             uuid primary key default gen_random_uuid(),
  paciente_id    uuid not null references public.pacientes (id) on delete cascade,
  fecha_registro timestamptz not null default now(),
  peso_kg        numeric(5,1) not null check (peso_kg between 1 and 400),
  altura_cm      numeric(5,1) not null,          -- altura del paciente al momento del registro
  imc            numeric(5,2) not null,          -- calculado por el servidor
  medicamento    text not null check (length(trim(medicamento)) > 0),
  dosis          text not null check (length(trim(dosis)) > 0),
  proxima_dosis  date not null,                  -- fecha de registro + 7 días
  registrado_por uuid default auth.uid() references auth.users (id) on delete set null
);
create index if not exists registros_paciente_fecha_idx
  on public.registros (paciente_id, fecha_registro desc);

-- El servidor fija la fecha, la altura, el IMC y la próxima dosis
-- (no se pueden alterar desde el navegador)
create or replace function public.registros_calcular() returns trigger
language plpgsql set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.fecha_registro := now();
    new.registrado_por := auth.uid();
    select p.altura_cm into new.altura_cm from public.pacientes p where p.id = new.paciente_id;
  else
    new.paciente_id    := old.paciente_id;
    new.fecha_registro := old.fecha_registro;
    new.registrado_por := old.registrado_por;
    new.altura_cm      := old.altura_cm;
  end if;

  new.imc           := round(new.peso_kg / power(new.altura_cm / 100.0, 2), 2);
  new.proxima_dosis := (new.fecha_registro at time zone 'America/La_Paz')::date + 7;
  return new;
end;
$$;

drop trigger if exists registros_calcular on public.registros;
create trigger registros_calcular
  before insert or update on public.registros
  for each row execute function public.registros_calcular();

-- -------------------------------------------------------------
-- 4. Seguridad: SOLO el dueño puede ver o modificar datos
-- -------------------------------------------------------------
alter table public.pacientes enable row level security;
alter table public.registros enable row level security;

revoke all on public.pacientes, public.registros from anon;
grant select, insert, update, delete on public.pacientes, public.registros to authenticated;

drop policy if exists "solo_duenio" on public.pacientes;
create policy "solo_duenio" on public.pacientes
  for all to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

drop policy if exists "solo_duenio" on public.registros;
create policy "solo_duenio" on public.registros
  for all to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));
