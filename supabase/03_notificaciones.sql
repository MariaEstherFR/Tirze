-- =============================================================
--  Parte 3: notificaciones push (aviso diario de dosis)
--  Ejecutar DESPUÉS de 02_inventario_y_admins.sql.
-- =============================================================

-- Dispositivos que activaron las notificaciones
create table if not exists public.push_suscripciones (
  endpoint    text primary key,
  p256dh      text not null,
  auth        text not null,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  dispositivo text,
  creado_en   timestamptz not null default now()
);
alter table public.push_suscripciones enable row level security;
revoke all on public.push_suscripciones from anon;
grant select, insert, update, delete on public.push_suscripciones to authenticated;

drop policy if exists "propias" on public.push_suscripciones;
create policy "propias" on public.push_suscripciones for all to authenticated
  using (user_id = auth.uid() and (select public.is_admin()))
  with check (user_id = auth.uid() and (select public.is_admin()));

-- Tarea programada: todos los días a las 7:00 de Bolivia (11:00 UTC)
-- Requiere un secreto en Vault llamado 'cron_secret' (el mismo valor que
-- el secreto CRON_SECRET de la función aviso-diario):
--   select vault.create_secret('<valor>', 'cron_secret');
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('aviso-diario')
where exists (select 1 from cron.job where jobname = 'aviso-diario');

select cron.schedule(
  'aviso-diario',
  '0 11 * * *',
  $$
  select net.http_post(
    url     := 'https://lrwdhpydogwpquuxflla.supabase.co/functions/v1/aviso-diario',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body    := '{}'::jsonb
  );
  $$
);
