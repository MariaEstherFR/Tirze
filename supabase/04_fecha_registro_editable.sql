-- =============================================================
--  Parte 4: permitir registrar dosis con fecha pasada
--  (para cargar el historial de pacientes que ya estaban en tratamiento).
--  Si no se envía fecha, se usa la actual. No se aceptan fechas futuras.
-- =============================================================
create or replace function public.registros_calcular() returns trigger
language plpgsql set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.fecha_registro := coalesce(new.fecha_registro, now());
    if new.fecha_registro > now() + interval '5 minutes' then
      raise exception 'La fecha de registro no puede ser futura';
    end if;
    if new.fecha_registro < timestamptz '2000-01-01' then
      raise exception 'La fecha de registro no es válida';
    end if;
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
