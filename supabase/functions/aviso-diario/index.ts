// Envía el aviso diario de dosis a los dispositivos suscritos.
// La llama pg_cron cada mañana (con x-cron-secret) o un administrador
// desde la app para enviarse una prueba (con su sesión).
// Desplegar: supabase functions deploy aviso-diario --no-verify-jwt --use-api
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const ZONA = 'America/La_Paz';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const hoyISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date());
const diasEntre = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const corto = (p: { nombre: string; apellido: string }) => `${p.nombre.split(' ')[0]} ${p.apellido.split(' ')[0]}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const cronSecret = Deno.env.get('CRON_SECRET');

    // ¿Quién llama? La tarea programada o un administrador (prueba)
    let soloUsuario: string | null = null;
    const esCron = !!cronSecret && req.headers.get('x-cron-secret') === cronSecret;
    if (!esCron) {
      const usuario = createClient(url, anon, {
        global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
        auth: { persistSession: false },
      });
      const { data: { user } } = await usuario.auth.getUser();
      const { data: esAdmin } = await usuario.rpc('is_admin');
      if (!user || !esAdmin) return json({ error: 'No autorizado' }, 401);
      soloUsuario = user.id;
    }

    const admin = createClient(url, service, { auth: { persistSession: false } });

    // Pacientes con su último registro y su saldo de frasco
    const [pr, sr] = await Promise.all([
      admin.from('pacientes')
        .select('id, nombre, apellido, registros(proxima_dosis, dosis_mg, fecha_registro)')
        .order('fecha_registro', { referencedTable: 'registros', ascending: false })
        .limit(1, { referencedTable: 'registros' }),
      admin.from('saldo_pacientes').select('paciente_id, mg_disponibles'),
    ]);
    if (pr.error) throw pr.error;
    if (sr.error) throw sr.error;
    const saldos = new Map(sr.data.map((s) => [s.paciente_id, Number(s.mg_disponibles)]));

    const hoy = hoyISO();
    const deHoy: string[] = [], atrasados: string[] = [], comprar: string[] = [];
    for (const p of pr.data) {
      const u = p.registros?.[0];
      if (!u) continue;
      const d = diasEntre(hoy, u.proxima_dosis);
      if (d === 0) deHoy.push(corto(p));
      else if (d < 0) atrasados.push(`${corto(p)} (${-d} d)`);
      const saldo = saldos.get(p.id);
      if (saldo !== undefined && u.dosis_mg && saldo + 1e-6 < Number(u.dosis_mg)) comprar.push(corto(p));
    }

    // La tarea diaria solo avisa si hay algo que hacer
    if (esCron && !deHoy.length && !atrasados.length) return json({ ok: true, enviados: 0, motivo: 'sin dosis hoy' });

    const titulo = deHoy.length
      ? `💉 Hoy toca dosis a ${deHoy.length} paciente${deHoy.length > 1 ? 's' : ''}`
      : atrasados.length ? `⚠️ ${atrasados.length} dosis atrasada${atrasados.length > 1 ? 's' : ''}` : '✅ Hoy no hay dosis programadas';
    const lineas = [];
    if (deHoy.length) lineas.push(`Hoy: ${deHoy.join(', ')}`);
    if (atrasados.length) lineas.push(`Atrasados: ${atrasados.join(', ')}`);
    if (comprar.length) lineas.push(`Deben comprar frasco: ${comprar.join(', ')}`);
    const payload = JSON.stringify({
      title: titulo,
      body: lineas.join('\n') || 'No hay pacientes con dosis para hoy.',
      url: Deno.env.get('APP_URL') ?? './',
    });

    webpush.setVapidDetails(
      Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!,
    );
    let consulta = admin.from('push_suscripciones').select('endpoint, p256dh, auth');
    if (soloUsuario) consulta = consulta.eq('user_id', soloUsuario);
    const { data: subs, error: errSubs } = await consulta;
    if (errSubs) throw errSubs;

    let enviados = 0, fallidos = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
        enviados++;
      } catch (e) {
        fallidos++;
        const codigo = (e as { statusCode?: number }).statusCode;
        if (codigo === 404 || codigo === 410) await admin.from('push_suscripciones').delete().eq('endpoint', s.endpoint);
      }
    }
    return json({ ok: true, enviados, fallidos });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
