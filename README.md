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
   git remote add origin https://github.com/Mare731710/Tirze.git
   git push -u origin main
   ```
3. En el repositorio, ve a **Settings → Pages → Source: Deploy from a branch → main / (root)** y guarda.
4. La app quedará en `https://Mare731710.github.io/Tirze/`.

### 3. Configurar la autenticación en Supabase
1. **Authentication → URL Configuration**:
   - **Site URL:** `https://Mare731710.github.io/Tirze/`
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
