# Control de Pacientes

App web (HTML + JavaScript) para registrar pacientes, su peso, el IMC, el medicamento y la dosis, y calcular la próxima dosis cada 7 días.

- **Frontend:** archivos estáticos publicados gratis en **GitHub Pages**.
- **Base de datos en la nube:** **Supabase** (PostgreSQL, plan gratuito), con inicio de sesión y seguridad a nivel de fila (RLS).

## Qué hace

| Función | Detalle |
|---|---|
| Administrador único | El primer usuario que se crea queda como dueño. Nadie más puede leer ni escribir datos. |
| Pacientes | Nombre, apellido, CI (único), fecha de nacimiento y altura. La **edad** se calcula sola. |
| Registros | Peso, medicamento y dosis. La **fecha de registro**, el **IMC** y la **próxima dosis (+7 días)** los calcula el servidor, así que no se pueden falsificar desde el navegador. |
| Próximas dosis | Lista de todos los pacientes ordenada por fecha, marcando las dosis vencidas, las de hoy y las de la semana. |
| Respaldo | Exportación a CSV (se abre en Excel). |
| Seguridad | Solo el dueño accede a los datos (RLS), la sesión se cierra tras 30 min sin actividad y todo el texto se escapa para evitar XSS. |

---

## Instalación paso a paso

### 1. Crear la base de datos (Supabase)
1. Crea una cuenta en <https://supabase.com> y haz clic en **New project** (plan Free).
   Te conviene elegir la región **South America (São Paulo)**.
2. Entra a **SQL Editor → New query**, pega todo el contenido de [`supabase/schema.sql`](supabase/schema.sql) y presiona **Run**.
3. Ve a **Project Settings → API** y copia:
   - **Project URL**
   - **anon / publishable key**
4. Pega esos dos valores en [`js/config.js`](js/config.js).
   > La *anon key* es pública por diseño. **Nunca** pongas la `service_role` key en este proyecto.

### 2. Publicar en GitHub Pages
1. Crea un repositorio en GitHub (puede ser **privado** si tienes GitHub Pro; si es público, el código queda visible, pero los datos no).
2. Sube todos los archivos de esta carpeta:
   ```bash
   git init
   git add .
   git commit -m "Primera versión"
   git branch -M main
   git remote add origin https://github.com/MariaEstherFR/Tirze.git
   git push -u origin main
   ```
3. En el repositorio, ve a **Settings → Pages → Source: Deploy from a branch → main / (root)** y guarda.
4. La app quedará en `https://MariaEstherFR.github.io/Tirze/`.

### 3. Configurar la autenticación en Supabase
1. **Authentication → URL Configuration**:
   - **Site URL:** `https://MariaEstherFR.github.io/Tirze/`
   - **Redirect URLs:** agrega esa misma URL (y `http://localhost:5500/` si vas a hacer pruebas en tu computadora).

### 4. Crear el administrador
1. Abre la app. Como todavía no hay dueño, aparecerá la pantalla **Crear administrador**.
2. Ingresa tu correo y una contraseña segura.
3. Confirma el correo que te envía Supabase y luego inicia sesión. En ese momento quedas registrado como **dueño**.

### 5. ⚠️ Cerrar el registro de nuevos usuarios
Con el administrador ya creado, ve a **Authentication → Sign In / Providers** y **desactiva "Allow new users to sign up"**.
Aunque alguien más lograra crear una cuenta, no podría ver datos porque no es el dueño. Aun así, desactivar el registro es la medida recomendada.

---

## Probar en tu computadora
Abre la carpeta con un servidor local, por ejemplo con la extensión **Live Server** de VS Code (clic derecho en `index.html` → *Open with Live Server*), o con:
```bash
python -m http.server 5500
```

## Notas
- **Zona horaria:** está configurada para Bolivia (`America/La_Paz`), en `js/app.js` y en `supabase/schema.sql`.
- **Plan gratuito de Supabase:** el proyecto se **pausa después de 7 días sin uso**. Se reactiva desde el panel de Supabase y no se pierden los datos. El plan gratuito no incluye copias de seguridad automáticas, así que usa **Exportar CSV** de vez en cuando.
- **Altura:** cada registro guarda la altura que tenía el paciente en ese momento. Si después editas la altura, los registros nuevos calcularán el IMC con el valor actualizado.
- **Recuperar contraseña:** desde el panel de Supabase, en **Authentication → Users → Send password recovery**.

---

## Parte 2: frascos, inventario y más administradores

- **Base de datos:** después de `schema.sql`, ejecuta también [`supabase/02_inventario_y_admins.sql`](supabase/02_inventario_y_admins.sql).
- **Función para invitar administradores:** se despliega con
  `supabase functions deploy invitar-admin --project-ref <ref> --use-api`
  (código en [`supabase/functions/invitar-admin`](supabase/functions/invitar-admin/index.ts)).

### Cómo funciona el control de frascos
1. **Inventario → Nuevo producto:** por ejemplo "Tirzepatida 10 mg", con 10 mg por frasco, 4 frascos por caja y el precio de venta.
2. **Inventario → Registrar compra:** cajas y/o frascos sueltos más el costo total. El sistema calcula el costo por frasco y suma el stock.
3. **Ficha del paciente → Vender frasco:** el frasco sale del stock y sus mg pasan al saldo del paciente.
4. **Registrar peso y dosis (en mg):** cada dosis de tirzepatida se descuenta del saldo del paciente, a partir de su primera compra.
5. El sistema indica si al paciente le **quedan dosis**, si le **queda 1 dosis** o si **debe comprar**.

### Administradores
En la pestaña **Administradores** (solo la dueña la ve) escribes el correo de la persona. Le llega un correo para crear su contraseña y queda con acceso completo. Desde ahí también puedes quitarle el acceso.

---

## Parte 3: aviso diario por notificación (7:00 a. m.)

- Base de datos: ejecutar [`supabase/03_notificaciones.sql`](supabase/03_notificaciones.sql) y crear en Vault el secreto `cron_secret`.
- Función: `supabase functions deploy aviso-diario --no-verify-jwt --use-api`. Necesita los secretos `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `CRON_SECRET` y `APP_URL`.
- La clave pública VAPID va en `js/config.js`. La privada **nunca** se sube al repositorio.

**Activar en el iPhone (iOS 16.4 o superior):** abre la app en Safari → Compartir (□↑) → **Agregar a pantalla de inicio** → abre la app desde ese ícono → pestaña **Próximas dosis** → **Activar en este dispositivo** → Permitir.
