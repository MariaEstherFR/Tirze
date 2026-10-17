// Datos de conexión a Supabase (Supabase → Project Settings → API).
// La "anon / publishable key" es PÚBLICA por diseño: la seguridad la dan
// las políticas RLS de supabase/schema.sql. NUNCA pongas aquí la "service_role key".
window.APP_CONFIG = {
  SUPABASE_URL: 'https://TU-PROYECTO.supabase.co',
  SUPABASE_ANON_KEY: 'TU-ANON-KEY',
};
