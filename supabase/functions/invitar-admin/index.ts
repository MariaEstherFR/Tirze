// Invita a un nuevo administrador por correo. Solo la dueña puede usarla.
// Desplegar: supabase functions deploy invitar-admin --project-ref <ref>
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // 1. Verificar que quien llama es la dueña
    const usuario = createClient(url, anon, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false },
    });
    const { data: esDuenia, error: errDuenia } = await usuario.rpc('is_owner');
    if (errDuenia || !esDuenia) return json({ error: 'Solo la dueña puede invitar administradores' }, 403);

    // 2. Validar datos
    const { email, redirectTo } = await req.json();
    const correo = String(email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) return json({ error: 'Correo no válido' }, 400);

    // 3. Autorizar el correo e invitar
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const { error: errLista } = await admin.from('app_admins').upsert({ email: correo });
    if (errLista) return json({ error: errLista.message }, 500);

    const { error: errInvita } = await admin.auth.admin.inviteUserByEmail(correo, { redirectTo });
    if (errInvita) {
      if (/already been registered|already exists/i.test(errInvita.message)) {
        return json({ ok: true, yaExistia: true });
      }
      return json({ error: errInvita.message }, 500);
    }
    return json({ ok: true, yaExistia: false });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
