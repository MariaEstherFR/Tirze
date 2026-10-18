-- =============================================================
--  Parte 2: administradores adicionales, frascos e inventario
--  Ejecutar DESPUÉS de schema.sql. Se puede volver a ejecutar.
-- =============================================================

-- -------------------------------------------------------------
-- 1. Administradores adicionales (los agrega solo la dueña)
-- -------------------------------------------------------------
create table if not exists public.app_admins (
  email        text primary key check (email = lower(trim(email)) and email like '%@%'),
  agregado_en  timestamptz not null default now(),
  agregado_por uuid default auth.uid() references auth.users (id) on delete set null
);
alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon;
grant select, insert, delete on public.app_admins to authenticated;

-- Dueña o administrador invitado
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_owner()
      or exists (select 1 from public.app_admins
                 where email = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;
revoke execute on function public.is_admin() from public, anon, authenticated;
grant  execute on function public.is_admin() to authenticated;

drop policy if exists "admins_leen" on public.app_admins;
create policy "admins_leen" on public.app_admins
  for select to authenticated using ((select public.is_admin()));
drop policy if exists "duenia_agrega" on public.app_admins;
create policy "duenia_agrega" on public.app_admins
  for insert to authenticated with check ((select public.is_owner()));
drop policy if exists "duenia_quita" on public.app_admins;
create policy "duenia_quita" on public.app_admins
  for delete to authenticated using ((select public.is_owner()));

-- Pacientes y registros: ahora los ve cualquier administrador
drop policy if exists "solo_duenio" on public.pacientes;
drop policy if exists "solo_admins" on public.pacientes;
create policy "solo_admins" on public.pacientes for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "solo_duenio" on public.registros;
drop policy if exists "solo_admins" on public.registros;
create policy "solo_admins" on public.registros for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- -------------------------------------------------------------
-- 2. Dosis en mg (para descontar del frasco)
-- -------------------------------------------------------------
alter table public.registros add column if not exists dosis_mg numeric(6,2) check (dosis_mg > 0);

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

  if new.dosis_mg is not null then
    new.dosis := rtrim(rtrim(new.dosis_mg::text, '0'), '.') || ' mg';
  end if;

  new.imc           := round(new.peso_kg / power(new.altura_cm / 100.0, 2), 2);
  new.proxima_dosis := (new.fecha_registro at time zone 'America/La_Paz')::date + 7;
  return new;
end;
$$;

-- Registros anteriores: extrae los mg del texto ("2.5 mg" → 2.5)
update public.registros
set dosis_mg = (regexp_match(replace(dosis, ',', '.'), '([0-9]+(\.[0-9]+)?)'))[1]::numeric
where dosis_mg is null and dosis ~ '[0-9]';

-- -------------------------------------------------------------
-- 3. Productos (presentaciones de frasco)
-- -------------------------------------------------------------
create table if not exists public.productos (
  id               uuid primary key default gen_random_uuid(),
  nombre           text not null unique check (length(trim(nombre)) > 0),
  mg_por_frasco    numeric(7,2) not null check (mg_por_frasco > 0),
  frascos_por_caja integer not null default 1 check (frascos_por_caja > 0),
  precio_venta     numeric(12,2) not null default 0 check (precio_venta >= 0),
  creado_en        timestamptz not null default now()
);

-- -------------------------------------------------------------
-- 4. Compras (entradas al inventario)
-- -------------------------------------------------------------
create table if not exists public.compras (
  id              uuid primary key default gen_random_uuid(),
  fecha           date not null default ((now() at time zone 'America/La_Paz')::date),
  producto_id     uuid not null references public.productos (id) on delete restrict,
  cajas           integer not null default 0 check (cajas >= 0),
  frascos_sueltos integer not null default 0 check (frascos_sueltos >= 0),
  frascos         integer not null check (frascos > 0),          -- calculado
  costo_total     numeric(12,2) not null check (costo_total >= 0),
  costo_unitario  numeric(12,2) not null,                       -- calculado
  proveedor       text,
  registrado_en   timestamptz not null default now(),
  registrado_por  uuid default auth.uid() references auth.users (id) on delete set null
);
create index if not exists compras_producto_idx on public.compras (producto_id);

create or replace function public.compras_calcular() returns trigger
language plpgsql set search_path = public
as $$
declare v_fpc integer;
begin
  select frascos_por_caja into v_fpc from public.productos where id = new.producto_id;
  if v_fpc is null then raise exception 'Producto no encontrado'; end if;
  new.frascos        := new.cajas * v_fpc + new.frascos_sueltos;
  if new.frascos <= 0 then raise exception 'La compra debe tener al menos 1 frasco'; end if;
  new.costo_unitario := round(new.costo_total / new.frascos, 2);
  new.registrado_en  := now();
  new.registrado_por := auth.uid();
  return new;
end;
$$;
drop trigger if exists compras_calcular on public.compras;
create trigger compras_calcular before insert on public.compras
  for each row execute function public.compras_calcular();

-- -------------------------------------------------------------
-- 5. Ventas de frascos a pacientes (salidas del inventario)
-- -------------------------------------------------------------
create table if not exists public.ventas (
  id              uuid primary key default gen_random_uuid(),
  fecha_venta     timestamptz not null default now(),
  paciente_id     uuid not null references public.pacientes (id) on delete restrict,
  producto_id     uuid not null references public.productos (id) on delete restrict,
  frascos         integer not null check (frascos > 0),
  precio_unitario numeric(12,2) not null check (precio_unitario >= 0),
  total           numeric(12,2) not null,   -- calculado
  costo_unitario  numeric(12,2) not null,   -- costo promedio al momento de vender
  mg_total        numeric(9,2) not null,    -- calculado
  registrado_por  uuid default auth.uid() references auth.users (id) on delete set null
);
create index if not exists ventas_paciente_idx on public.ventas (paciente_id);
create index if not exists ventas_producto_idx on public.ventas (producto_id);

create or replace function public.stock_producto(p_producto uuid) returns integer
language sql stable set search_path = public
as $$
  select (coalesce((select sum(frascos) from public.compras where producto_id = p_producto), 0)
        - coalesce((select sum(frascos) from public.ventas  where producto_id = p_producto), 0))::integer
$$;

create or replace function public.ventas_calcular() returns trigger
language plpgsql set search_path = public
as $$
declare v_mg numeric; v_stock integer; v_costo numeric;
begin
  select mg_por_frasco into v_mg from public.productos where id = new.producto_id;
  if v_mg is null then raise exception 'Producto no encontrado'; end if;

  perform pg_advisory_xact_lock(hashtext(new.producto_id::text));
  v_stock := public.stock_producto(new.producto_id);
  if new.frascos > v_stock then
    raise exception 'Stock insuficiente: solo quedan % frasco(s) de este producto', v_stock;
  end if;

  select sum(costo_total) / nullif(sum(frascos), 0) into v_costo
  from public.compras where producto_id = new.producto_id;

  new.fecha_venta    := now();
  new.registrado_por := auth.uid();
  new.mg_total       := new.frascos * v_mg;
  new.total          := round(new.frascos * new.precio_unitario, 2);
  new.costo_unitario := round(coalesce(v_costo, 0), 2);
  return new;
end;
$$;
drop trigger if exists ventas_calcular on public.ventas;
create trigger ventas_calcular before insert on public.ventas
  for each row execute function public.ventas_calcular();

-- No se puede borrar una compra cuyos frascos ya se vendieron
create or replace function public.compras_validar_borrado() returns trigger
language plpgsql set search_path = public
as $$
begin
  if public.stock_producto(old.producto_id) < 0 then
    raise exception 'No se puede eliminar esta compra: sus frascos ya fueron vendidos';
  end if;
  return old;
end;
$$;
drop trigger if exists compras_validar_borrado on public.compras;
create trigger compras_validar_borrado after delete on public.compras
  for each row execute function public.compras_validar_borrado();

-- -------------------------------------------------------------
-- 6. Vistas de resumen
-- -------------------------------------------------------------
create or replace view public.inventario with (security_invoker = true) as
select p.id, p.nombre, p.mg_por_frasco, p.frascos_por_caja, p.precio_venta,
       coalesce(c.frascos, 0)                          as frascos_comprados,
       coalesce(v.frascos, 0)                          as frascos_vendidos,
       coalesce(c.frascos, 0) - coalesce(v.frascos, 0) as stock,
       round(c.costo / nullif(c.frascos, 0), 2)        as costo_promedio,
       coalesce(c.costo, 0)                            as invertido,
       coalesce(v.ingresos, 0)                         as ingresos,
       coalesce(v.costo_vendido, 0)                    as costo_vendido
from public.productos p
left join (select producto_id, sum(frascos) frascos, sum(costo_total) costo
           from public.compras group by producto_id) c on c.producto_id = p.id
left join (select producto_id, sum(frascos) frascos, sum(total) ingresos,
                  sum(frascos * costo_unitario) costo_vendido
           from public.ventas group by producto_id) v on v.producto_id = p.id;

-- Saldo de tirzepatida de cada paciente. Las dosis se descuentan
-- desde su primera compra de frasco.
create or replace view public.saldo_pacientes with (security_invoker = true) as
select v.paciente_id,
       v.frascos                          as frascos_comprados,
       v.mg                               as mg_comprados,
       coalesce(r.mg, 0)                  as mg_aplicados,
       v.mg - coalesce(r.mg, 0)           as mg_disponibles
from (select paciente_id, sum(frascos) frascos, sum(mg_total) mg, min(fecha_venta) primera
      from public.ventas group by paciente_id) v
left join lateral (
  select sum(dosis_mg) mg from public.registros r
  where r.paciente_id = v.paciente_id
    and r.fecha_registro >= v.primera
    and r.dosis_mg is not null
    and r.medicamento ~* '(tirzepatida|mounjaro|zepbound)'
) r on true;

-- -------------------------------------------------------------
-- 7. Seguridad de las tablas nuevas
-- -------------------------------------------------------------
alter table public.productos enable row level security;
alter table public.compras   enable row level security;
alter table public.ventas    enable row level security;

revoke all on public.productos, public.compras, public.ventas,
              public.inventario, public.saldo_pacientes from anon;
grant select, insert, update, delete on public.productos to authenticated;
grant select, insert, delete on public.compras, public.ventas to authenticated;
grant select on public.inventario, public.saldo_pacientes to authenticated;
revoke execute on function public.stock_producto(uuid) from public, anon;
grant  execute on function public.stock_producto(uuid) to authenticated;

drop policy if exists "solo_admins" on public.productos;
create policy "solo_admins" on public.productos for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "solo_admins" on public.compras;
create policy "solo_admins" on public.compras for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "solo_admins" on public.ventas;
create policy "solo_admins" on public.ventas for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
