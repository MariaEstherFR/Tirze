(() => {
  'use strict';

  const ZONA_HORARIA = 'America/La_Paz';
  const MINUTOS_INACTIVIDAD = 30;            // cierre de sesión automático
  const cfg = window.APP_CONFIG || {};
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  // Enlaces de invitación / recuperación de contraseña (se leen antes de que Supabase limpie la URL)
  const paramsEnlace = new URLSearchParams(location.hash.slice(1));
  let necesitaPassword = ['invite', 'recovery'].includes(paramsEnlace.get('type'));
  const errorEnlace = paramsEnlace.get('error_description');

  let sb = null;
  const state = {
    esDuenia: false, emailUsuario: '',
    pacientes: [], actual: null, registros: [], ventasPaciente: [],
    inventario: [], compras: [], ventas: [], admins: [], dosisRecientes: [],
  };

  // ================= Utilidades =================
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const urlBase = () => location.origin + location.pathname;

  // Convierte "1,5" o "1.5" en número
  const num = (v) => {
    const n = Number(String(v ?? '').trim().replace(',', '.'));
    return String(v ?? '').trim() === '' ? NaN : n;
  };

  // Hoy en formato YYYY-MM-DD según la zona horaria de Bolivia
  const hoyISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date());

  // Fecha y hora actual de Bolivia para <input type="datetime-local"> (YYYY-MM-DDTHH:MM)
  function ahoraLocal() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }
  const OFFSET_BOLIVIA = '-04:00';   // Bolivia no usa horario de verano

  function partes(iso) {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return { y, m, d };
  }
  const aUTC = (iso) => { const { y, m, d } = partes(iso); return Date.UTC(y, m - 1, d); };
  const sumarDias = (iso, n) => new Date(aUTC(iso) + n * 86400000).toISOString().slice(0, 10);
  const diasEntre = (desde, hasta) => Math.round((aUTC(hasta) - aUTC(desde)) / 86400000);

  function calcularEdad(fechaNac) {
    const h = partes(hoyISO()), n = partes(fechaNac);
    let edad = h.y - n.y;
    if (h.m < n.m || (h.m === n.m && h.d < n.d)) edad--;
    return edad;
  }

  function fmtFecha(iso) {
    if (!iso) return '—';
    const { y, m, d } = partes(iso);
    return `${pad(d)}/${pad(m)}/${y}`;
  }
  const fmtFechaHora = (ts) => new Date(ts).toLocaleString('es-BO', {
    timeZone: ZONA_HORARIA, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const fmtNum = (n, dec = 1) => Number(n).toLocaleString('es-BO', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const fmtMg = (n) => `${Number(n).toLocaleString('es-BO', { maximumFractionDigits: 2 })} mg`;
  const fmtBs = (n) => `Bs ${fmtNum(n || 0, 2)}`;

  function calcularIMC(pesoKg, alturaCm) {
    const m = alturaCm / 100;
    return m > 0 ? pesoKg / (m * m) : NaN;
  }

  // Clasificación OMS
  function categoriaIMC(v) {
    if (!isFinite(v)) return { txt: '—', cls: '' };
    if (v < 18.5) return { txt: 'Bajo peso', cls: 'warn' };
    if (v < 25) return { txt: 'Normal', cls: 'ok' };
    if (v < 30) return { txt: 'Sobrepeso', cls: 'warn' };
    if (v < 35) return { txt: 'Obesidad I', cls: 'bad' };
    if (v < 40) return { txt: 'Obesidad II', cls: 'bad' };
    return { txt: 'Obesidad III', cls: 'bad' };
  }

  function estadoDosis(iso) {
    const d = diasEntre(hoyISO(), iso);
    if (d < 0) return { txt: `Vencida hace ${-d} día${d === -1 ? '' : 's'}`, cls: 'bad' };
    if (d === 0) return { txt: 'Hoy', cls: 'warn' };
    if (d === 1) return { txt: 'Mañana', cls: 'warn' };
    return { txt: `En ${d} días`, cls: 'ok' };
  }

  // ¿Le alcanza el frasco para la siguiente dosis?
  function estadoFrasco(p) {
    const s = p.saldo;
    if (!s) return { txt: 'Sin frasco', cls: '', mg: null, n: null };
    const mg = Number(s.mg_disponibles);
    const dosis = Number(p.ultimo?.dosis_mg) || 0;
    if (!dosis) return { txt: `${fmtMg(mg)} disponibles`, cls: mg > 0 ? 'ok' : 'bad', mg, n: null };
    const n = Math.floor((mg + 1e-6) / dosis);
    if (n <= 0) return { txt: 'Debe comprar', cls: 'bad', mg, n };
    if (n === 1) return { txt: 'Queda 1 dosis', cls: 'warn', mg, n };
    return { txt: `Quedan ${n} dosis`, cls: 'ok', mg, n };
  }

  function estadoStock(stock) {
    if (stock <= 0) return { txt: 'Agotado', cls: 'bad' };
    if (stock <= 2) return { txt: `${stock} (bajo)`, cls: 'warn' };
    return { txt: String(stock), cls: 'ok' };
  }

  // "maria  de los ANGELES" → "Maria de los Angeles"
  const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e']);
  function capitalizar(texto) {
    return texto.trim().replace(/\s+/g, ' ').toLocaleLowerCase('es')
      .split(' ')
      .map((p, i) => (i > 0 && PARTICULAS.has(p) ? p : p.charAt(0).toLocaleUpperCase('es') + p.slice(1)))
      .join(' ');
  }

  // Acepta metros (1.72 / 1,72) o centímetros (172) y devuelve centímetros
  function normalizarAltura(valor) {
    const n = num(valor);
    if (!isFinite(n) || n <= 0) return NaN;
    return n < 3 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
  }

  const chip = (o) => `<span class="chip ${o.cls}">${esc(o.txt)}</span>`;

  // Tarjeta de resumen con ícono circular. `valor` y `extra` pueden traer HTML ya escapado.
  const stat = (etiqueta, valor, { extra = '', icono = 'bx-pulse', color = '' } = {}) => `
    <div class="stat ${color ? `c-${color}` : ''}">
      <div class="stat-body"><span class="stat-label">${esc(etiqueta)}</span><strong>${valor}</strong>${extra}</div>
      <div class="stat-icon"><i class="bx ${icono}"></i></div>
    </div>`;

  // Fecha local (Bolivia) de una marca de tiempo, en formato YYYY-MM-DD
  const fechaLocal = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date(ts));
  const lunesDe = (iso) => sumarDias(iso, -((new Date(aUTC(iso)).getUTCDay() + 6) % 7));
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const PALETA = ['#556ee6', '#34c38f', '#f1b44c', '#50a5f1', '#f46a6a', '#74788d', '#6f42c1'];
  const graficos = {};
  function graficar(id, config) {
    if (!window.Chart) return;
    graficos[id]?.destroy();
    graficos[id] = new window.Chart($(`#${id}`), config);
  }

  let toastTimer;
  function toast(msg, tipo = 'ok') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast ${tipo} visible`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('visible'), 4000);
  }

  function mensajeError(err) {
    if (!err) return 'Error desconocido';
    const m = err.message || String(err);
    if (err.code === '23505') {
      if (/productos/.test(m)) return 'Ya existe un producto con ese nombre.';
      if (/app_admins/.test(m)) return 'Ese correo ya es administrador.';
      return 'Ya existe un paciente con ese CI.';
    }
    if (err.code === '23503') return 'No se puede eliminar: tiene ventas o compras asociadas. Elimínalas primero.';
    if (err.code === '42501') return 'No tienes permiso para realizar esta acción.';
    if (err.code === '23514') return 'Algún dato está fuera de rango. Revisa el formulario.';
    if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/Email not confirmed/i.test(m)) return 'Debes confirmar tu correo antes de ingresar.';
    if (/Signups not allowed/i.test(m)) return 'El registro de nuevos usuarios está deshabilitado.';
    if (/rate limit/i.test(m)) return 'Se enviaron demasiados correos. Espera unos minutos e inténtalo de nuevo.';
    if (/should be different/i.test(m)) return 'La nueva contraseña debe ser distinta a la anterior.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Sin conexión con el servidor.';
    return m;
  }

  function ocupado(form, si) {
    $$('button, input, select', form).forEach((el) => { el.disabled = si; });
  }

  function confirmarConError(err) {
    if (err) toast(mensajeError(err), 'error');
    return !err;
  }

  // ================= Vistas =================
  function mostrarVista(nombre) {
    $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== nombre; });
  }

  const TITULOS = {
    inicio: 'Inicio', pacientes: 'Pacientes', dosis: 'Próximas dosis',
    inventario: 'Inventario', admins: 'Administradores', detalle: 'Ficha del paciente',
  };

  function irA(tab) {
    $$('[data-tab]').forEach((s) => { s.hidden = s.dataset.tab !== tab; });
    const activa = tab === 'detalle' ? 'pacientes' : tab;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.go === activa));
    $('#page-title').textContent = TITULOS[tab];
    $('#page-crumb').textContent = TITULOS[tab];
    $(`.tabs button[data-go="${activa}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (tab === 'inicio') renderInicio();
    if (tab === 'dosis') { renderDosis(); estadoNotificaciones(); }
    if (tab === 'pacientes') renderPacientes();
    if (tab === 'inventario') cargarInventario();
    if (tab === 'admins') cargarAdmins();
    window.scrollTo(0, 0);
  }

  // ================= Autenticación =================
  async function enrutar(session) {
    if (!session) {
      const { data: existe, error } = await sb.rpc('owner_exists');
      if (error) return mostrarError(error);
      mostrarVista(existe ? 'login' : 'setup');
      return;
    }

    if (necesitaPassword) {
      $('#password-email').textContent = session.user.email;
      mostrarVista('password');
      return;
    }

    let { data: esAdmin, error } = await sb.rpc('is_admin');
    if (error) return mostrarError(error);

    if (!esAdmin) {
      const r = await sb.rpc('owner_exists');
      if (r.error) return mostrarError(r.error);
      if (!r.data) {
        const c = await sb.rpc('claim_owner');
        if (c.error) return mostrarError(c.error);
        esAdmin = c.data;
        if (esAdmin) toast('Administrador creado correctamente');
      }
    }
    if (!esAdmin) return mostrarVista('denied');

    const { data: esDuenia } = await sb.rpc('is_owner');
    state.esDuenia = !!esDuenia;
    state.emailUsuario = session.user.email;
    $('#tab-admins').hidden = !state.esDuenia;
    const usuario = session.user.email.split('@')[0];
    $('#user-email').textContent = session.user.email;
    $('#user-avatar').textContent = usuario.slice(0, 2).toUpperCase();
    $('#welcome-avatar').textContent = usuario.charAt(0).toUpperCase();
    $('#welcome-nombre').textContent = usuario;
    $('#welcome-rol').textContent = state.esDuenia ? 'Dueña' : 'Administrador';
    mostrarVista('main');
    iniciarVigilanciaInactividad();
    await Promise.all([cargarPacientes(), cargarInventario(), cargarDosisRecientes()]);
    irA('inicio');
  }

  function mostrarError(err) {
    $('#error-detalle').textContent = mensajeError(err);
    mostrarVista('error');
  }

  async function crearAdmin(e) {
    e.preventDefault();
    const f = e.target;
    const email = f.email.value.trim();
    const password = f.password.value;
    if (password !== f.password2.value) return toast('Las contraseñas no coinciden', 'error');

    ocupado(f, true);
    const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: urlBase() } });
    ocupado(f, false);
    if (error) return toast(mensajeError(error), 'error');

    if (data.session) {
      await enrutar(data.session);
    } else {
      avisoLogin(`Te enviamos un correo a ${email}. Ábrelo y confirma tu cuenta; luego inicia sesión aquí.`);
      $('#form-login').email.value = email;
      mostrarVista('login');
    }
  }

  function avisoLogin(texto) {
    const aviso = $('#login-aviso');
    aviso.textContent = texto;
    aviso.hidden = false;
  }

  async function iniciarSesion(e) {
    e.preventDefault();
    const f = e.target;
    const email = f.email.value.trim();
    const password = f.password.value;
    ocupado(f, true);
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    ocupado(f, false);
    if (error) return toast(mensajeError(error), 'error');
    f.reset();
    $('#login-aviso').hidden = true;
    await enrutar(data.session);
  }

  async function olvideContrasena(e) {
    e.preventDefault();
    const email = $('#form-login').email.value.trim();
    if (!email) return toast('Escribe tu correo arriba y vuelve a presionar el enlace', 'warn');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: urlBase() });
    if (error) return toast(mensajeError(error), 'error');
    avisoLogin(`Si ${email} tiene cuenta, recibirá un correo para crear una nueva contraseña.`);
  }

  async function guardarContrasena(e) {
    e.preventDefault();
    const f = e.target;
    if (f.password.value !== f.password2.value) return toast('Las contraseñas no coinciden', 'error');
    ocupado(f, true);
    const { data, error } = await sb.auth.updateUser({ password: f.password.value });
    ocupado(f, false);
    if (error) return toast(mensajeError(error), 'error');
    f.reset();
    necesitaPassword = false;
    history.replaceState(null, '', urlBase());
    toast('Contraseña guardada');
    const { data: { session } } = await sb.auth.getSession();
    await enrutar(session || (data && data.session));
  }

  const cerrarSesion = () => sb.auth.signOut();

  let ultimaActividad = Date.now();
  let vigilancia = null;
  function iniciarVigilanciaInactividad() {
    if (vigilancia) return;
    ['click', 'keydown', 'touchstart', 'scroll'].forEach((ev) =>
      document.addEventListener(ev, () => { ultimaActividad = Date.now(); }, { passive: true }));
    vigilancia = setInterval(() => {
      if (Date.now() - ultimaActividad > MINUTOS_INACTIVIDAD * 60000) {
        toast('Sesión cerrada por inactividad', 'warn');
        cerrarSesion();
      }
    }, 60000);
  }
  function detenerVigilancia() {
    clearInterval(vigilancia);
    vigilancia = null;
  }

  // ================= Pacientes =================
  async function cargarPacientes() {
    const [pr, sr] = await Promise.all([
      sb.from('pacientes')
        .select('*, registros(id, fecha_registro, peso_kg, imc, medicamento, dosis, dosis_mg, proxima_dosis)')
        .order('apellido').order('nombre')
        .order('fecha_registro', { referencedTable: 'registros', ascending: false })
        .limit(1, { referencedTable: 'registros' }),
      sb.from('saldo_pacientes').select('*'),
    ]);
    if (!confirmarConError(pr.error) || !confirmarConError(sr.error)) return;
    const saldos = new Map(sr.data.map((s) => [s.paciente_id, s]));
    state.pacientes = pr.data.map((p) => ({ ...p, ultimo: p.registros?.[0] || null, saldo: saldos.get(p.id) || null }));
    if (state.actual) state.actual = state.pacientes.find((p) => p.id === state.actual.id) || null;
    renderPacientes();
  }

  function renderPacientes() {
    const q = $('#buscar').value.trim().toLowerCase();
    const lista = state.pacientes.filter((p) =>
      !q || `${p.ci} ${p.nombre} ${p.apellido}`.toLowerCase().includes(q));

    $('#contador').textContent = `${lista.length} de ${state.pacientes.length} paciente(s)`;
    $('#sin-pacientes').hidden = lista.length > 0;
    $('#tabla-pacientes tbody').innerHTML = lista.map((p) => {
      const u = p.ultimo;
      return `<tr data-id="${esc(p.id)}" tabindex="0">
        <td data-label="CI">${esc(p.ci)}</td>
        <td data-label="Paciente"><strong>${esc(p.apellido)}, ${esc(p.nombre)}</strong></td>
        <td data-label="Edad">${calcularEdad(p.fecha_nacimiento)} años</td>
        <td data-label="Último peso">${u ? `${fmtNum(u.peso_kg)} kg` : '—'}</td>
        <td data-label="IMC">${u ? `${fmtNum(u.imc, 2)} ${chip(categoriaIMC(Number(u.imc)))}` : '—'}</td>
        <td data-label="Próxima dosis">${u
          ? `${fmtFecha(u.proxima_dosis)} ${chip(estadoDosis(u.proxima_dosis))}`
          : '<span class="muted">Sin registros</span>'}</td>
        <td data-label="Frasco">${chip(estadoFrasco(p))}</td>
      </tr>`;
    }).join('');
  }

  function abrirDlgPaciente(p = null) {
    const f = $('#form-paciente');
    f.reset();
    f.dataset.id = p?.id || '';
    $('#dlg-paciente-titulo').textContent = p ? 'Editar paciente' : 'Nuevo paciente';
    f.fecha_nacimiento.max = hoyISO();
    if (p) {
      f.nombre.value = p.nombre;
      f.apellido.value = p.apellido;
      f.ci.value = p.ci;
      f.fecha_nacimiento.value = p.fecha_nacimiento;
      f.altura_cm.value = p.altura_cm;
    }
    actualizarEdadPreview();
    actualizarAlturaPreview();
    $('#dlg-paciente').showModal();
  }

  function actualizarAlturaPreview() {
    const input = $('#form-paciente').altura_cm;
    const cm = normalizarAltura(input.value);
    const valida = cm >= 30 && cm <= 250;
    input.setCustomValidity(!input.value || valida ? '' : 'Escribe la altura en metros (1.72) o en centímetros (172)');
    $('#pac-altura-hint').textContent = valida ? `= ${fmtNum(cm)} cm (${fmtNum(cm / 100, 2)} m)` : '';
  }

  function actualizarEdadPreview() {
    const v = $('#form-paciente').fecha_nacimiento.value;
    $('#pac-edad').textContent = v && v <= hoyISO() ? `${calcularEdad(v)} años` : '—';
  }

  async function guardarPaciente(e) {
    e.preventDefault();
    const f = e.target;
    const id = f.dataset.id;
    const datos = {
      nombre: capitalizar(f.nombre.value),
      apellido: capitalizar(f.apellido.value),
      ci: f.ci.value.trim().toUpperCase(),
      fecha_nacimiento: f.fecha_nacimiento.value,
      altura_cm: normalizarAltura(f.altura_cm.value),
    };
    if (datos.fecha_nacimiento > hoyISO()) return toast('La fecha de nacimiento no puede ser futura', 'error');
    if (!(datos.altura_cm >= 30 && datos.altura_cm <= 250)) return toast('Altura no válida: usa metros (1.72) o centímetros (172)', 'error');

    ocupado(f, true);
    const { error } = id
      ? await sb.from('pacientes').update(datos).eq('id', id)
      : await sb.from('pacientes').insert(datos);
    ocupado(f, false);
    if (error) return toast(mensajeError(error), 'error');

    $('#dlg-paciente').close();
    toast(id ? 'Paciente actualizado' : 'Paciente registrado');
    await cargarPacientes();
    if (id && state.actual) renderFicha();
  }

  async function eliminarPaciente() {
    const p = state.actual;
    if (!p) return;
    if (!confirm(`¿Eliminar a ${p.nombre} ${p.apellido} (CI ${p.ci}) y TODOS sus registros?\nEsta acción no se puede deshacer.`)) return;
    const { error } = await sb.from('pacientes').delete().eq('id', p.id);
    if (error) return toast(mensajeError(error), 'error');
    toast('Paciente eliminado');
    state.actual = null;
    await cargarPacientes();
    irA('pacientes');
  }

  // ================= Ficha y registros =================
  async function abrirPaciente(id) {
    state.actual = state.pacientes.find((p) => p.id === id) || null;
    if (!state.actual) return;
    state.registros = [];
    state.ventasPaciente = [];
    renderFicha();
    renderRegistros();
    renderVentasPaciente();
    irA('detalle');
    await cargarRegistros();
  }

  function renderFicha() {
    const p = state.actual;
    $('#ficha-nombre').textContent = `${p.nombre} ${p.apellido}`;
    $('#ficha-datos').innerHTML = `
      <div><dt>CI</dt><dd>${esc(p.ci)}</dd></div>
      <div><dt>Fecha de nacimiento</dt><dd>${fmtFecha(p.fecha_nacimiento)}</dd></div>
      <div><dt>Edad</dt><dd>${calcularEdad(p.fecha_nacimiento)} años</dd></div>
      <div><dt>Altura</dt><dd>${fmtNum(p.altura_cm)} cm</dd></div>`;
  }

  async function cargarRegistros() {
    const id = state.actual.id;
    const [rr, vr] = await Promise.all([
      sb.from('registros').select('*').eq('paciente_id', id).order('fecha_registro', { ascending: false }),
      sb.from('ventas').select('*, productos(nombre)').eq('paciente_id', id).order('fecha_venta', { ascending: false }),
    ]);
    if (!confirmarConError(rr.error) || !confirmarConError(vr.error)) return;
    if (state.actual?.id !== id) return;    // el usuario cambió de paciente mientras cargaba
    state.registros = rr.data;
    state.ventasPaciente = vr.data;
    renderRegistros();
    renderVentasPaciente();
  }

  function renderRegistros() {
    const p = state.actual;
    const regs = state.registros;
    const u = regs[0];
    const primero = regs[regs.length - 1];
    const fr = estadoFrasco(p);

    const tarjetaFrasco = stat('Frasco', fr.mg === null ? '—' : fmtMg(fr.mg), {
      extra: `${chip(fr)}<small>${p.saldo ? `${p.saldo.frascos_comprados} frasco(s) comprados` : 'Usa "Vender frasco" para registrarlo'}</small>`,
      icono: 'bx-test-tube', color: 'warning',
    });

    if (u) {
      const dif = regs.length > 1 ? Number(u.peso_kg) - Number(primero.peso_kg) : null;
      $('#ficha-resumen').innerHTML =
        stat('Peso actual', `${fmtNum(u.peso_kg)} kg`, {
          extra: dif !== null ? `<small class="${dif <= 0 ? 'txt-ok' : 'txt-bad'}">${dif > 0 ? '+' : ''}${fmtNum(dif)} kg desde el inicio</small>` : '',
          icono: 'bx-body',
        }) +
        stat('IMC', fmtNum(u.imc, 2), { extra: chip(categoriaIMC(Number(u.imc))), icono: 'bx-line-chart', color: 'info' }) +
        stat('Tratamiento', esc(u.dosis), { extra: `<small>${esc(u.medicamento)}</small>`, icono: 'bx-injection', color: 'success' }) +
        stat('Próxima dosis', fmtFecha(u.proxima_dosis), { extra: chip(estadoDosis(u.proxima_dosis)), icono: 'bx-calendar', color: 'danger' }) +
        tarjetaFrasco;
    } else {
      $('#ficha-resumen').innerHTML = tarjetaFrasco;
    }

    // Gráfico de evolución del peso
    $('#card-peso').hidden = regs.length < 2;
    if (regs.length >= 2) {
      const orden = [...regs].reverse();
      graficar('grafico-peso', {
        type: 'line',
        data: {
          labels: orden.map((r) => fmtFecha(fechaLocal(r.fecha_registro)).slice(0, 5)),
          datasets: [{
            label: 'Peso (kg)', data: orden.map((r) => Number(r.peso_kg)),
            borderColor: '#556ee6', backgroundColor: 'rgba(85,110,230,.12)', fill: true, tension: .35,
            pointBackgroundColor: '#556ee6', pointRadius: 4,
          }],
        },
        options: opcionesGrafico({ leyenda: false }),
      });
    }

    $('#sin-registros').hidden = regs.length > 0;
    $('#tabla-registros tbody').innerHTML = regs.map((r) => `
      <tr>
        <td data-label="Fecha de registro">${fmtFechaHora(r.fecha_registro)}</td>
        <td data-label="Peso">${fmtNum(r.peso_kg)} kg</td>
        <td data-label="IMC">${fmtNum(r.imc, 2)} ${chip(categoriaIMC(Number(r.imc)))}</td>
        <td data-label="Medicamento">${esc(r.medicamento)}</td>
        <td data-label="Dosis">${esc(r.dosis)}</td>
        <td data-label="Próxima dosis">${fmtFecha(r.proxima_dosis)}</td>
        <td><button class="btn ghost small danger-txt" data-del="${esc(r.id)}" title="Eliminar registro">✕</button></td>
      </tr>`).join('');
  }

  function renderVentasPaciente() {
    const vs = state.ventasPaciente;
    $('#sin-ventas-paciente').hidden = vs.length > 0;
    $('#tabla-ventas-paciente tbody').innerHTML = vs.map((v) => `
      <tr>
        <td data-label="Fecha">${fmtFechaHora(v.fecha_venta)}</td>
        <td data-label="Producto">${esc(v.productos?.nombre)}</td>
        <td data-label="Frascos">${v.frascos}</td>
        <td data-label="mg">${fmtMg(v.mg_total)}</td>
        <td data-label="Total">${fmtBs(v.total)}</td>
      </tr>`).join('');
  }

  function abrirDlgRegistro() {
    const p = state.actual;
    const f = $('#form-registro');
    f.reset();
    const u = state.registros[0];
    if (u) {
      f.medicamento.value = u.medicamento;
      if (u.dosis_mg) f.dosis_mg.value = Number(u.dosis_mg);
    } else {
      f.medicamento.value = 'Tirzepatida (Mounjaro)';
    }
    $('#reg-paciente').textContent = `${p.nombre} ${p.apellido} · CI ${p.ci} · ${calcularEdad(p.fecha_nacimiento)} años`;
    $('#reg-altura').textContent = `${fmtNum(p.altura_cm)} cm`;
    f.fecha_registro.value = ahoraLocal();
    f.fecha_registro.max = ahoraLocal();
    actualizarProximaPreview();
    actualizarIMCPreview();
    actualizarFrascoPreview();
    $('#dlg-registro').showModal();
    f.peso_kg.focus();
  }

  function actualizarProximaPreview() {
    const v = $('#form-registro').fecha_registro.value;
    $('#reg-proxima').textContent = v ? fmtFecha(sumarDias(v.slice(0, 10), 7)) : '—';
  }

  function actualizarIMCPreview() {
    const peso = Number($('#form-registro').peso_kg.value);
    const out = $('#reg-imc');
    if (!peso || !state.actual) { out.textContent = '—'; return; }
    const v = calcularIMC(peso, Number(state.actual.altura_cm));
    out.innerHTML = `${fmtNum(v, 2)} ${chip(categoriaIMC(v))}`;
  }

  function actualizarFrascoPreview() {
    const f = $('#form-registro');
    const caja = $('#reg-frasco');
    const p = state.actual;
    const esTirze = /tirzepatida|mounjaro|zepbound/i.test(f.medicamento.value);
    if (!p || !esTirze) { caja.hidden = true; return; }
    caja.hidden = false;
    caja.className = 'aviso';
    if (!p.saldo) {
      caja.textContent = 'Este paciente no tiene frasco registrado; la dosis no se descontará. Usa "Vender frasco" si le vendiste uno.';
      caja.classList.add('warn');
      return;
    }
    // Las dosis anteriores a la primera compra de frasco no se descuentan
    const primeraVenta = state.ventasPaciente[state.ventasPaciente.length - 1];
    if (primeraVenta && f.fecha_registro.value && f.fecha_registro.value.slice(0, 10) < fechaLocal(primeraVenta.fecha_venta)) {
      caja.textContent = 'Esta dosis es anterior a la primera compra de frasco del paciente: se guarda en el historial sin descontarse del frasco.';
      return;
    }
    const disp = Number(p.saldo.mg_disponibles);
    const dosis = num(f.dosis_mg.value);
    if (!(dosis > 0)) { caja.textContent = `Frasco: ${fmtMg(disp)} disponibles.`; return; }
    const queda = disp - dosis;
    if (queda < -1e-6) {
      caja.textContent = `⚠ No alcanza: tiene ${fmtMg(disp)} y la dosis es de ${fmtMg(dosis)}. Debe comprar otro frasco.`;
      caja.classList.add('bad');
    } else {
      const sig = Math.floor((queda + 1e-6) / dosis);
      caja.textContent = `Frasco: ${fmtMg(disp)} → después de esta dosis quedan ${fmtMg(queda)} (${sig} dosis más).`;
      if (sig === 0) {
        caja.textContent += ' Debe comprar para la próxima.';
        caja.classList.add('warn');
      }
    }
  }

  async function guardarRegistro(e) {
    e.preventDefault();
    const f = e.target;
    const dosisMg = num(f.dosis_mg.value);
    if (!(dosisMg > 0 && dosisMg <= 100)) return toast('Escribe la dosis en mg, por ejemplo 2.5', 'error');
    const fecha = f.fecha_registro.value;
    if (!fecha) return toast('Indica la fecha de registro', 'error');
    if (fecha > ahoraLocal()) return toast('La fecha de registro no puede ser futura', 'error');
    // El IMC y la próxima dosis (fecha + 7 días) los calcula el servidor
    const datos = {
      paciente_id: state.actual.id,
      peso_kg: Number(f.peso_kg.value),
      medicamento: f.medicamento.value.trim(),
      dosis: `${dosisMg} mg`,
      dosis_mg: dosisMg,
      fecha_registro: `${fecha}:00${OFFSET_BOLIVIA}`,
    };
    ocupado(f, true);
    const { error } = await sb.from('registros').insert(datos);
    ocupado(f, false);
    if (error) return toast(mensajeError(error), 'error');

    $('#dlg-registro').close();
    toast('Registro guardado');
    await Promise.all([cargarPacientes(), cargarDosisRecientes()]);
    await cargarRegistros();
  }

  async function eliminarRegistro(id) {
    const r = state.registros.find((x) => x.id === id);
    if (!r || !confirm(`¿Eliminar el registro del ${fmtFechaHora(r.fecha_registro)}?`)) return;
    const { error } = await sb.from('registros').delete().eq('id', id);
    if (error) return toast(mensajeError(error), 'error');
    toast('Registro eliminado');
    await Promise.all([cargarPacientes(), cargarDosisRecientes()]);
    await cargarRegistros();
  }

  // ================= Ventas de frascos =================
  function opcionesProductos(select, { soloConStock = false } = {}) {
    select.innerHTML = state.inventario.map((p) => {
      const sinStock = soloConStock && p.stock <= 0;
      return `<option value="${esc(p.id)}" ${sinStock ? 'disabled' : ''}>${esc(p.nombre)} · ${fmtMg(p.mg_por_frasco)} · stock ${p.stock}</option>`;
    }).join('');
    const primero = state.inventario.find((p) => !soloConStock || p.stock > 0);
    if (primero) select.value = primero.id;
  }

  async function abrirDlgVenta() {
    await cargarInventario();
    if (!state.inventario.length) return toast('Primero crea un producto y registra una compra en Inventario', 'warn');
    if (!state.inventario.some((p) => p.stock > 0)) return toast('No hay frascos en stock. Registra una compra en Inventario', 'warn');
    const p = state.actual;
    const f = $('#form-venta');
    f.reset();
    $('#venta-paciente').textContent = `${p.nombre} ${p.apellido} · CI ${p.ci}`;
    opcionesProductos(f.producto_id, { soloConStock: true });
    alCambiarProductoVenta();
    $('#dlg-venta').showModal();
  }

  function alCambiarProductoVenta() {
    const f = $('#form-venta');
    const prod = state.inventario.find((x) => x.id === f.producto_id.value);
    if (prod) {
      f.precio_unitario.value = Number(prod.precio_venta);
      f.frascos.max = prod.stock;
    }
    actualizarVentaPreview();
  }

  function actualizarVentaPreview() {
    const f = $('#form-venta');
    const prod = state.inventario.find((x) => x.id === f.producto_id.value);
    const n = parseInt(f.frascos.value, 10) || 0;
    const precio = num(f.precio_unitario.value) || 0;
    $('#venta-total').textContent = fmtBs(n * precio);
    const actual = state.actual?.saldo ? Number(state.actual.saldo.mg_disponibles) : 0;
    $('#venta-saldo').textContent = prod ? fmtMg(actual + n * Number(prod.mg_por_frasco)) : '—';
  }

  async function guardarVenta(e) {
    e.preventDefault();
    const f = e.target;
    const datos = {
      paciente_id: state.actual.id,
      producto_id: f.producto_id.value,
      frascos: parseInt(f.frascos.value, 10),
      precio_unitario: num(f.precio_unitario.value),
    };
    if (!(datos.frascos > 0)) return toast('Cantidad no válida', 'error');
    if (!(datos.precio_unitario >= 0)) return toast('Precio no válido', 'error');
    ocupado(f, true);
    const { error } = await sb.from('ventas').insert(datos);
    ocupado(f, false);
    if (error) return toast(mensajeError(error), 'error');
    $('#dlg-venta').close();
    toast('Venta registrada');
    await Promise.all([cargarPacientes(), cargarInventario()]);
    await cargarRegistros();
    renderRegistros();
  }

  async function eliminarVenta(id) {
    const v = state.ventas.find((x) => x.id === id);
    if (!v || !confirm(`¿Eliminar la venta de ${v.frascos} frasco(s) a ${v.pacientes?.nombre} ${v.pacientes?.apellido}?\nLos frascos vuelven al stock.`)) return;
    const { error } = await sb.from('ventas').delete().eq('id', id);
    if (error) return toast(mensajeError(error), 'error');
    toast('Venta eliminada');
    await Promise.all([cargarInventario(), cargarPacientes()]);
  }

  // ================= Inventario =================
  async function cargarInventario() {
    const [ir, cr, vr] = await Promise.all([
      sb.from('inventario').select('*').order('nombre'),
      sb.from('compras').select('*, productos(nombre)').order('fecha', { ascending: false }).order('registrado_en', { ascending: false }).limit(200),
      sb.from('ventas').select('*, productos(nombre), pacientes(nombre, apellido)').order('fecha_venta', { ascending: false }).limit(200),
    ]);
    if (!confirmarConError(ir.error) || !confirmarConError(cr.error) || !confirmarConError(vr.error)) return;
    state.inventario = ir.data.map((p) => ({ ...p, stock: Number(p.stock) }));
    state.compras = cr.data;
    state.ventas = vr.data;
    renderInventario();
  }

  function renderInventario() {
    const inv = state.inventario;
    const suma = (fn) => inv.reduce((a, p) => a + (Number(fn(p)) || 0), 0);
    const stock = suma((p) => p.stock);
    const valorStock = suma((p) => p.stock * (p.costo_promedio || 0));
    const invertido = suma((p) => p.invertido);
    const ingresos = suma((p) => p.ingresos);
    const ganancia = ingresos - suma((p) => p.costo_vendido);

    $('#inv-resumen').innerHTML =
      stat('Frascos en stock', stock, { extra: `<small>Valor: ${fmtBs(valorStock)}</small>`, icono: 'bx-package' }) +
      stat('Total invertido', fmtBs(invertido), { extra: `<small>${suma((p) => p.frascos_comprados)} frascos comprados</small>`, icono: 'bx-wallet', color: 'info' }) +
      stat('Total vendido', fmtBs(ingresos), { extra: `<small>${suma((p) => p.frascos_vendidos)} frascos vendidos</small>`, icono: 'bx-purchase-tag-alt', color: 'warning' }) +
      stat('Ganancia', `<span class="${ganancia >= 0 ? 'txt-ok' : 'txt-bad'}">${fmtBs(ganancia)}</span>`, { extra: '<small>Sobre frascos vendidos</small>', icono: 'bx-trending-up', color: 'success' });
    if (!$('[data-tab="inicio"]').hidden) renderInicio();

    $('#sin-productos').hidden = inv.length > 0;
    $('#tabla-productos tbody').innerHTML = inv.map((p) => `
      <tr>
        <td data-label="Producto"><strong>${esc(p.nombre)}</strong></td>
        <td data-label="mg / frasco">${fmtMg(p.mg_por_frasco)}</td>
        <td data-label="Frascos / caja">${p.frascos_por_caja}</td>
        <td data-label="Stock">${chip(estadoStock(p.stock))}</td>
        <td data-label="Costo prom.">${p.costo_promedio === null ? '—' : fmtBs(p.costo_promedio)}</td>
        <td data-label="Precio venta">${fmtBs(p.precio_venta)}</td>
        <td data-label="Vendidos">${p.frascos_vendidos}</td>
        <td><button class="btn ghost small" data-edit-prod="${esc(p.id)}">Editar</button></td>
      </tr>`).join('');

    $('#sin-ventas').hidden = state.ventas.length > 0;
    $('#tabla-ventas tbody').innerHTML = state.ventas.map((v) => {
      const gan = Number(v.total) - v.frascos * Number(v.costo_unitario);
      return `<tr>
        <td data-label="Fecha">${fmtFechaHora(v.fecha_venta)}</td>
        <td data-label="Paciente">${esc(v.pacientes?.apellido)}, ${esc(v.pacientes?.nombre)}</td>
        <td data-label="Producto">${esc(v.productos?.nombre)}</td>
        <td data-label="Frascos">${v.frascos}</td>
        <td data-label="Precio u.">${fmtBs(v.precio_unitario)}</td>
        <td data-label="Total"><strong>${fmtBs(v.total)}</strong></td>
        <td data-label="Ganancia" class="${gan >= 0 ? 'txt-ok' : 'txt-bad'}">${fmtBs(gan)}</td>
        <td><button class="btn ghost small danger-txt" data-del-venta="${esc(v.id)}" title="Eliminar venta">✕</button></td>
      </tr>`;
    }).join('');

    $('#sin-compras').hidden = state.compras.length > 0;
    $('#tabla-compras tbody').innerHTML = state.compras.map((c) => `
      <tr>
        <td data-label="Fecha">${fmtFecha(c.fecha)}</td>
        <td data-label="Producto">${esc(c.productos?.nombre)}</td>
        <td data-label="Cajas">${c.cajas}${c.frascos_sueltos ? ` + ${c.frascos_sueltos} sueltos` : ''}</td>
        <td data-label="Frascos">${c.frascos}</td>
        <td data-label="Costo total"><strong>${fmtBs(c.costo_total)}</strong></td>
        <td data-label="Costo / frasco">${fmtBs(c.costo_unitario)}</td>
        <td data-label="Proveedor">${esc(c.proveedor) || '—'}</td>
        <td><button class="btn ghost small danger-txt" data-del-compra="${esc(c.id)}" title="Eliminar compra">✕</button></td>
      </tr>`).join('');
  }

  function abrirDlgProducto(p = null) {
    const f = $('#form-producto');
    f.reset();
    f.dataset.id = p?.id || '';
    $('#dlg-producto-titulo').textContent = p ? 'Editar producto' : 'Nuevo producto';
    if (p) {
      f.nombre.value = p.nombre;
      f.mg_por_frasco.value = Number(p.mg_por_frasco);
      f.frascos_por_caja.value = p.frascos_por_caja;
      f.precio_venta.value = Number(p.precio_venta);
    }
    $('#dlg-producto').showModal();
  }

  async function guardarProducto(e) {
    e.preventDefault();
    const f = e.target;
    const id = f.dataset.id;
    const datos = {
      nombre: f.nombre.value.trim().replace(/\s+/g, ' '),
      mg_por_frasco: num(f.mg_por_frasco.value),
      frascos_por_caja: parseInt(f.frascos_por_caja.value, 10),
      precio_venta: num(f.precio_venta.value),
    };
    if (!(datos.mg_por_frasco > 0)) return toast('Escribe los mg por frasco', 'error');
    if (!(datos.frascos_por_caja > 0)) return toast('Frascos por caja no válido', 'error');
    if (!(datos.precio_venta >= 0)) return toast('Precio de venta no válido', 'error');
    ocupado(f, true);
    const { error } = id
      ? await sb.from('productos').update(datos).eq('id', id)
      : await sb.from('productos').insert(datos);
    ocupado(f, false);
    if (error) return toast(mensajeError(error), 'error');
    $('#dlg-producto').close();
    toast(id ? 'Producto actualizado' : 'Producto creado');
    await cargarInventario();
  }

  function abrirDlgCompra() {
    if (!state.inventario.length) return toast('Primero crea un producto', 'warn');
    const f = $('#form-compra');
    f.reset();
    opcionesProductos(f.producto_id);
    f.fecha.value = hoyISO();
    f.fecha.max = hoyISO();
    actualizarCompraPreview();
    $('#dlg-compra').showModal();
  }

  function frascosCompra() {
    const f = $('#form-compra');
    const prod = state.inventario.find((x) => x.id === f.producto_id.value);
    const cajas = parseInt(f.cajas.value, 10) || 0;
    const sueltos = parseInt(f.frascos_sueltos.value, 10) || 0;
    return { prod, total: prod ? cajas * prod.frascos_por_caja + sueltos : 0 };
  }

  function actualizarCompraPreview() {
    const f = $('#form-compra');
    const { prod, total } = frascosCompra();
    const costo = num(f.costo_total.value);
    if (!prod || total <= 0) { $('#compra-calc').textContent = '—'; return; }
    $('#compra-calc').textContent = `${total} frascos · ${costo > 0 ? fmtBs(costo / total) : '—'}`;
  }

  async function guardarCompra(e) {
    e.preventDefault();
    const f = e.target;
    const { total } = frascosCompra();
    const datos = {
      producto_id: f.producto_id.value,
      cajas: parseInt(f.cajas.value, 10) || 0,
      frascos_sueltos: parseInt(f.frascos_sueltos.value, 10) || 0,
      costo_total: num(f.costo_total.value),
      fecha: f.fecha.value,
      proveedor: f.proveedor.value.trim() || null,
    };
    if (total <= 0) return toast('Indica cuántas cajas o frascos compraste', 'error');
    if (!(datos.costo_total >= 0)) return toast('Costo no válido', 'error');
    ocupado(f, true);
    const { error } = await sb.from('compras').insert(datos);
    ocupado(f, false);
    if (error) return toast(mensajeError(error), 'error');
    $('#dlg-compra').close();
    toast(`Compra registrada: ${total} frasco(s)`);
    await cargarInventario();
  }

  async function eliminarCompra(id) {
    const c = state.compras.find((x) => x.id === id);
    if (!c || !confirm(`¿Eliminar la compra de ${c.frascos} frasco(s) de ${c.productos?.nombre} del ${fmtFecha(c.fecha)}?`)) return;
    const { error } = await sb.from('compras').delete().eq('id', id);
    if (error) return toast(mensajeError(error), 'error');
    toast('Compra eliminada');
    await cargarInventario();
  }

  // ================= Administradores =================
  async function cargarAdmins() {
    if (!state.esDuenia) return;
    const { data, error } = await sb.from('app_admins').select('*').order('agregado_en');
    if (!confirmarConError(error)) return;
    state.admins = data;
    $('#tabla-admins tbody').innerHTML = `
      <tr>
        <td data-label="Correo"><strong>${esc(state.emailUsuario)}</strong></td>
        <td data-label="Rol">${chip({ txt: 'Dueña', cls: '' })}</td>
        <td data-label="Desde">—</td><td></td>
      </tr>` + data.map((a) => `
      <tr>
        <td data-label="Correo">${esc(a.email)}</td>
        <td data-label="Rol">${chip({ txt: 'Administrador', cls: 'ok' })}</td>
        <td data-label="Desde">${fmtFechaHora(a.agregado_en)}</td>
        <td><button class="btn ghost small danger-txt" data-del-admin="${esc(a.email)}">Quitar</button></td>
      </tr>`).join('');
  }

  async function invitarAdmin(e) {
    e.preventDefault();
    const f = e.target;
    const email = f.email.value.trim().toLowerCase();
    if (email === state.emailUsuario.toLowerCase()) return toast('Ese es tu propio correo', 'warn');
    ocupado(f, true);
    const { data, error } = await sb.functions.invoke('invitar-admin', { body: { email, redirectTo: urlBase() } });
    ocupado(f, false);
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch (_) { /* sin cuerpo */ }
      return toast(mensajeError({ message: msg }), 'error');
    }
    f.reset();
    toast(data?.yaExistia ? `${email} ya tenía cuenta: ahora es administrador` : `Invitación enviada a ${email}`);
    await cargarAdmins();
  }

  async function quitarAdmin(email) {
    if (!confirm(`¿Quitar el acceso de administrador a ${email}?`)) return;
    const { error } = await sb.from('app_admins').delete().eq('email', email);
    if (error) return toast(mensajeError(error), 'error');
    toast('Acceso quitado');
    await cargarAdmins();
  }

  // ================= Inicio (panel) =================
  async function cargarDosisRecientes() {
    const desde = sumarDias(hoyISO(), -190);
    const { data, error } = await sb.from('registros')
      .select('fecha_registro, dosis_mg').gte('fecha_registro', desde).order('fecha_registro');
    if (!confirmarConError(error)) return;
    state.dosisRecientes = data;
  }

  function opcionesGrafico({ apilado = false, leyenda = true } = {}) {
    const texto = cssVar('--muted') || '#74788d';
    const rejilla = cssVar('--border') || '#eff2f7';
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: leyenda, position: 'bottom', labels: { color: texto, boxWidth: 12, font: { family: 'Poppins' } } },
        tooltip: { titleFont: { family: 'Poppins' }, bodyFont: { family: 'Poppins' } },
      },
      scales: {
        x: { stacked: apilado, grid: { display: false }, ticks: { color: texto, font: { family: 'Poppins', size: 11 } } },
        y: { stacked: apilado, beginAtZero: !apilado ? false : true, grid: { color: rejilla }, ticks: { color: texto, precision: 0, font: { family: 'Poppins', size: 11 } } },
      },
    };
  }

  let periodoGrafico = 'semana';

  function renderInicio() {
    const hoy = hoyISO();
    let deHoy = 0, atrasadas = 0, comprar = 0;
    state.pacientes.forEach((p) => {
      if (p.ultimo) {
        const d = diasEntre(hoy, p.ultimo.proxima_dosis);
        if (d === 0) deHoy++; else if (d < 0) atrasadas++;
      }
      if (estadoFrasco(p).cls === 'bad') comprar++;
    });
    const stock = state.inventario.reduce((a, p) => a + p.stock, 0);
    const regs = state.dosisRecientes || [];
    const hace7 = sumarDias(hoy, -6);

    $('#kpi-pacientes').textContent = state.pacientes.length;
    $('#kpi-semana').textContent = regs.filter((r) => fechaLocal(r.fecha_registro) >= hace7).length;

    $('#dash-stats').innerHTML =
      stat('Dosis para hoy', deHoy, { icono: 'bx-calendar-event' }) +
      stat('Dosis atrasadas', atrasadas, { icono: 'bx-time-five', color: 'danger' }) +
      stat('Deben comprar', comprar, { icono: 'bx-cart', color: 'warning' }) +
      stat('Frascos en stock', stock, { icono: 'bx-package', color: 'success' });

    // Ganancia del mes
    const mes = hoy.slice(0, 7);
    const ventasMes = state.ventas.filter((v) => fechaLocal(v.fecha_venta).slice(0, 7) === mes);
    const ingresos = ventasMes.reduce((a, v) => a + Number(v.total), 0);
    const costo = ventasMes.reduce((a, v) => a + v.frascos * Number(v.costo_unitario), 0);
    const ganancia = ingresos - costo;
    const margen = ingresos > 0 ? Math.round((ganancia / ingresos) * 100) : 0;
    $('#mes-ganancia').textContent = fmtBs(ganancia);
    $('#mes-detalle').textContent = `${ventasMes.reduce((a, v) => a + v.frascos, 0)} frasco(s) vendidos · ${fmtBs(ingresos)} en ventas`;
    graficar('grafico-dona', {
      type: 'doughnut',
      data: {
        labels: ['Ganancia', 'Costo'],
        datasets: [{ data: ingresos > 0 ? [Math.max(ganancia, 0), costo] : [0, 1], backgroundColor: ['#556ee6', cssVar('--border') || '#eff2f7'], borderWidth: 0 }],
      },
      options: { responsive: false, cutout: '72%', plugins: { legend: { display: false }, tooltip: { enabled: ingresos > 0 } } },
      plugins: [{
        id: 'centro',
        afterDraw(c) {
          const { ctx, chartArea: a } = c;
          ctx.save();
          ctx.font = '600 16px Poppins, sans-serif';
          ctx.fillStyle = cssVar('--heading') || '#343a40';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(`${margen}%`, (a.left + a.right) / 2, (a.top + a.bottom) / 2 - 6);
          ctx.font = '400 10px Poppins, sans-serif';
          ctx.fillStyle = cssVar('--muted') || '#74788d';
          ctx.fillText('margen', (a.left + a.right) / 2, (a.top + a.bottom) / 2 + 12);
          ctx.restore();
        },
      }],
    });

    renderGraficoDosis();
  }

  // Barras apiladas: cantidad de dosis aplicadas por semana o mes, separadas por mg
  function renderGraficoDosis() {
    const hoy = hoyISO();
    const cubetas = [];
    if (periodoGrafico === 'semana') {
      const lunes = lunesDe(hoy);
      for (let i = 7; i >= 0; i--) {
        const ini = sumarDias(lunes, -7 * i);
        cubetas.push({ clave: ini, etiqueta: fmtFecha(ini).slice(0, 5) });
      }
    } else {
      const { y, m } = partes(hoy);
      for (let i = 5; i >= 0; i--) {
        const d = new Date(Date.UTC(y, m - 1 - i, 1));
        cubetas.push({
          clave: d.toISOString().slice(0, 7),
          etiqueta: d.toLocaleDateString('es-BO', { month: 'short', timeZone: 'UTC' }).replace('.', ''),
        });
      }
    }
    const claveDe = (iso) => (periodoGrafico === 'semana' ? lunesDe(iso) : iso.slice(0, 7));
    const conteo = new Map();       // dosis → (cubeta → cantidad)
    (state.dosisRecientes || []).forEach((r) => {
      const k = claveDe(fechaLocal(r.fecha_registro));
      const dosis = r.dosis_mg ? `${Number(r.dosis_mg)} mg` : 'Sin mg';
      if (!conteo.has(dosis)) conteo.set(dosis, new Map());
      const fila = conteo.get(dosis);
      fila.set(k, (fila.get(k) || 0) + 1);
    });
    const dosisOrdenadas = [...conteo.keys()].sort((a, b) => parseFloat(a) - parseFloat(b));
    graficar('grafico-dosis', {
      type: 'bar',
      data: {
        labels: cubetas.map((c) => c.etiqueta),
        datasets: dosisOrdenadas.map((dosis, i) => ({
          label: dosis,
          data: cubetas.map((c) => conteo.get(dosis).get(c.clave) || 0),
          backgroundColor: PALETA[i % PALETA.length],
          borderRadius: 2, barPercentage: .45,
        })),
      },
      options: opcionesGrafico({ apilado: true }),
    });
  }

  // ================= Notificaciones push =================
  const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const esInstalada = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let swRegistro = null;

  async function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try { swRegistro = await navigator.serviceWorker.register('sw.js'); } catch (_) { swRegistro = null; }
  }

  function claveAplicacion(base64) {
    const relleno = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + relleno).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function estadoNotificaciones() {
    const est = $('#notif-estado'), btn = $('#btn-notif'), prueba = $('#btn-notif-prueba');
    btn.hidden = true; prueba.hidden = true;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      est.textContent = esIOS && !esInstalada()
        ? 'En iPhone primero instala la app: en Safari toca Compartir (□↑) → "Agregar a pantalla de inicio" y ábrela desde ese ícono.'
        : 'Este navegador no permite notificaciones.';
      return;
    }
    if (!swRegistro || !cfg.VAPID_PUBLIC_KEY) { est.textContent = 'Las notificaciones no están disponibles en este momento.'; return; }
    const sub = await swRegistro.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      est.textContent = '✅ Activadas en este dispositivo. Cada mañana recibirás la lista de pacientes con dosis.';
      btn.innerHTML = '<i class="bx bx-bell-off"></i> Desactivar';
      btn.className = 'btn';
      btn.dataset.modo = 'off';
      btn.hidden = false;
      prueba.hidden = false;
    } else if (Notification.permission === 'denied') {
      est.textContent = 'Las notificaciones están bloqueadas. Actívalas en Ajustes → Notificaciones del dispositivo.';
    } else {
      est.textContent = 'Recibe cada mañana a qué pacientes les toca la tirzepatida, quiénes están atrasados y quiénes deben comprar frasco.';
      btn.innerHTML = '<i class="bx bx-bell"></i> Activar en este dispositivo';
      btn.className = 'btn primary';
      btn.dataset.modo = 'on';
      btn.hidden = false;
    }
  }

  async function alternarNotificaciones() {
    const btn = $('#btn-notif');
    if (btn.dataset.modo === 'on') {
      // En iPhone el permiso debe pedirse directamente al tocar el botón
      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') { toast('No se otorgó el permiso de notificaciones', 'warn'); return estadoNotificaciones(); }
      btn.disabled = true;
      try {
        const sub = await swRegistro.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: claveAplicacion(cfg.VAPID_PUBLIC_KEY),
        });
        const j = sub.toJSON();
        const { error } = await sb.from('push_suscripciones').upsert({
          endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
          dispositivo: esIOS ? 'iPhone/iPad' : navigator.userAgent.slice(0, 120),
        });
        if (error) throw error;
        toast('Notificaciones activadas');
      } catch (e) {
        toast(mensajeError(e), 'error');
      }
      btn.disabled = false;
    } else {
      const sub = await swRegistro.pushManager.getSubscription();
      if (sub) {
        await sb.from('push_suscripciones').delete().eq('endpoint', sub.endpoint);
        await sub.unsubscribe();
      }
      toast('Notificaciones desactivadas en este dispositivo');
    }
    estadoNotificaciones();
  }

  async function enviarPrueba() {
    const b = $('#btn-notif-prueba');
    b.disabled = true;
    const { data, error } = await sb.functions.invoke('aviso-diario', { body: { prueba: true } });
    b.disabled = false;
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch (_) { /* sin cuerpo */ }
      return toast(mensajeError({ message: msg }), 'error');
    }
    toast(data.enviados ? 'Notificación de prueba enviada' : 'No se pudo enviar: vuelve a activar las notificaciones', data.enviados ? 'ok' : 'warn');
  }

  // ================= Próximas dosis =================
  function renderDosis() {
    const lista = state.pacientes
      .filter((p) => p.ultimo)
      .sort((a, b) => a.ultimo.proxima_dosis.localeCompare(b.ultimo.proxima_dosis));

    const hoy = hoyISO();
    let vencidas = 0, deHoy = 0, semana = 0, comprar = 0;
    lista.forEach((p) => {
      const d = diasEntre(hoy, p.ultimo.proxima_dosis);
      if (d < 0) vencidas++; else if (d === 0) deHoy++; else if (d <= 7) semana++;
    });
    state.pacientes.forEach((p) => { if (estadoFrasco(p).cls === 'bad') comprar++; });
    $('#dosis-resumen').innerHTML = `
      <span class="chip bad">${vencidas} vencida(s)</span>
      <span class="chip warn">${deHoy} para hoy</span>
      <span class="chip ok">${semana} esta semana</span>
      <span class="chip bad">🧪 ${comprar} deben comprar frasco</span>`;

    $('#sin-dosis').hidden = lista.length > 0;
    $('#tabla-dosis tbody').innerHTML = lista.map((p) => {
      const u = p.ultimo;
      return `<tr data-id="${esc(p.id)}" tabindex="0">
        <td data-label="Próxima dosis"><strong>${fmtFecha(u.proxima_dosis)}</strong></td>
        <td data-label="Estado">${chip(estadoDosis(u.proxima_dosis))}</td>
        <td data-label="Paciente">${esc(p.apellido)}, ${esc(p.nombre)} <span class="muted small">CI ${esc(p.ci)}</span></td>
        <td data-label="Medicamento">${esc(u.medicamento)} · ${esc(u.dosis)}</td>
        <td data-label="Frasco">${chip(estadoFrasco(p))}</td>
      </tr>`;
    }).join('');
  }

  // ================= Exportar CSV (respaldo) =================
  async function exportarCSV() {
    const { data, error } = await sb.from('registros')
      .select('fecha_registro, peso_kg, altura_cm, imc, medicamento, dosis, proxima_dosis, pacientes(ci, nombre, apellido, fecha_nacimiento)')
      .order('fecha_registro');
    if (error) return toast(mensajeError(error), 'error');

    const filas = [['CI', 'Nombre', 'Apellido', 'Fecha nacimiento', 'Fecha registro', 'Peso (kg)',
      'Altura (cm)', 'IMC', 'Medicamento', 'Dosis', 'Próxima dosis']];
    data.forEach((r) => filas.push([
      r.pacientes.ci, r.pacientes.nombre, r.pacientes.apellido, fmtFecha(r.pacientes.fecha_nacimiento),
      fmtFechaHora(r.fecha_registro), r.peso_kg, r.altura_cm, r.imc, r.medicamento, r.dosis, fmtFecha(r.proxima_dosis),
    ]));
    // Evita que Excel interprete celdas como fórmulas
    const celda = (v) => {
      let s = String(v ?? '');
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = filas.map((f) => f.map(celda).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `registros_${hoyISO()}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  }

  // ================= Eventos =================
  function alClic(selector, atributo, accion) {
    $(selector).addEventListener('click', (e) => {
      const b = e.target.closest(`[${atributo}]`);
      if (b) accion(b.getAttribute(atributo));
    });
  }

  function enlazarEventos() {
    $('#form-setup').addEventListener('submit', crearAdmin);
    $('#form-login').addEventListener('submit', iniciarSesion);
    $('#form-password').addEventListener('submit', guardarContrasena);
    $('#link-olvide').addEventListener('click', olvideContrasena);
    $$('[data-goto]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); mostrarVista(a.dataset.goto); }));
    $$('[data-action="logout"]').forEach((b) => b.addEventListener('click', cerrarSesion));
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => irA(b.dataset.go)));

    $('#buscar').addEventListener('input', renderPacientes);
    $('#btn-nuevo-paciente').addEventListener('click', () => abrirDlgPaciente());
    ['#tabla-pacientes tbody', '#tabla-dosis tbody'].forEach((sel) => {
      const tb = $(sel);
      tb.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-id]');
        if (tr) abrirPaciente(tr.dataset.id);
      });
      tb.addEventListener('keydown', (e) => {
        const tr = e.target.closest('tr[data-id]');
        if (tr && e.key === 'Enter') abrirPaciente(tr.dataset.id);
      });
    });

    // Ficha
    $('#btn-volver').addEventListener('click', () => irA('pacientes'));
    $('#btn-editar-paciente').addEventListener('click', () => abrirDlgPaciente(state.actual));
    $('#btn-eliminar-paciente').addEventListener('click', eliminarPaciente);
    $('#btn-nuevo-registro').addEventListener('click', abrirDlgRegistro);
    $('#btn-vender').addEventListener('click', abrirDlgVenta);
    alClic('#tabla-registros tbody', 'data-del', eliminarRegistro);

    // Formularios de paciente y registro
    const fp = $('#form-paciente');
    fp.addEventListener('submit', guardarPaciente);
    fp.fecha_nacimiento.addEventListener('input', actualizarEdadPreview);
    fp.altura_cm.addEventListener('input', actualizarAlturaPreview);
    ['nombre', 'apellido'].forEach((campo) => {
      fp[campo].addEventListener('blur', () => { fp[campo].value = capitalizar(fp[campo].value); });
    });
    const fr = $('#form-registro');
    fr.addEventListener('submit', guardarRegistro);
    fr.peso_kg.addEventListener('input', actualizarIMCPreview);
    fr.fecha_registro.addEventListener('input', () => { actualizarProximaPreview(); actualizarFrascoPreview(); });
    fr.dosis_mg.addEventListener('input', actualizarFrascoPreview);
    fr.medicamento.addEventListener('input', actualizarFrascoPreview);

    // Inventario
    $('#btn-nuevo-producto').addEventListener('click', () => abrirDlgProducto());
    $('#btn-nueva-compra').addEventListener('click', abrirDlgCompra);
    $('#form-producto').addEventListener('submit', guardarProducto);
    const fc = $('#form-compra');
    fc.addEventListener('submit', guardarCompra);
    ['producto_id', 'cajas', 'frascos_sueltos', 'costo_total'].forEach((c) => fc[c].addEventListener('input', actualizarCompraPreview));
    const fv = $('#form-venta');
    fv.addEventListener('submit', guardarVenta);
    fv.producto_id.addEventListener('change', alCambiarProductoVenta);
    ['frascos', 'precio_unitario'].forEach((c) => fv[c].addEventListener('input', actualizarVentaPreview));
    alClic('#tabla-productos tbody', 'data-edit-prod', (id) => abrirDlgProducto(state.inventario.find((p) => p.id === id)));
    alClic('#tabla-ventas tbody', 'data-del-venta', eliminarVenta);
    alClic('#tabla-compras tbody', 'data-del-compra', eliminarCompra);

    // Administradores
    $('#form-invitar').addEventListener('submit', invitarAdmin);
    alClic('#tabla-admins tbody', 'data-del-admin', quitarAdmin);

    // Inicio y notificaciones
    $$('[data-go-btn]').forEach((b) => b.addEventListener('click', () => irA(b.dataset.goBtn)));
    $$('#seg-periodo button').forEach((b) => b.addEventListener('click', () => {
      periodoGrafico = b.dataset.periodo;
      $$('#seg-periodo button').forEach((x) => x.classList.toggle('active', x === b));
      renderGraficoDosis();
    }));
    $('#btn-notif').addEventListener('click', alternarNotificaciones);
    $('#btn-notif-prueba').addEventListener('click', enviarPrueba);

    $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
    $('#btn-exportar').addEventListener('click', exportarCSV);

    sb.auth.onAuthStateChange((evento) => {
      if (evento === 'PASSWORD_RECOVERY') necesitaPassword = true;
      if (evento === 'SIGNED_OUT') {
        detenerVigilancia();
        Object.assign(state, { esDuenia: false, pacientes: [], actual: null, registros: [], ventasPaciente: [],
          inventario: [], compras: [], ventas: [], admins: [], dosisRecientes: [] });
        $$('dialog[open]').forEach((d) => d.close());
        setTimeout(() => enrutar(null), 0);
      }
    });
  }

  // ================= Inicio =================
  async function iniciar() {
    if (!cfg.SUPABASE_URL || /TU-PROYECTO/.test(cfg.SUPABASE_URL)) {
      mostrarVista('config');
      return;
    }
    if (!window.supabase) {
      return mostrarError({ message: 'No se pudo descargar la librería de Supabase. Revisa tu conexión a internet y recarga la página.' });
    }
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    enlazarEventos();
    registrarServiceWorker();
    if (errorEnlace) {
      history.replaceState(null, '', urlBase());
      toast(/expired|invalid/i.test(errorEnlace) ? 'El enlace del correo venció o ya fue usado. Pide uno nuevo.' : errorEnlace, 'error');
    }
    const { data: { session } } = await sb.auth.getSession();
    await enrutar(session);
  }

  iniciar().catch(mostrarError);
})();
