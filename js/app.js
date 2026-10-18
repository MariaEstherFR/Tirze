(() => {
  'use strict';

  const ZONA_HORARIA = 'America/La_Paz';
  const MINUTOS_INACTIVIDAD = 30;            // cierre de sesión automático
  const cfg = window.APP_CONFIG || {};
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  let sb = null;
  const state = { pacientes: [], actual: null, registros: [] };

  // ================= Utilidades =================
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');

  // Hoy en formato YYYY-MM-DD según la zona horaria de Bolivia
  const hoyISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA }).format(new Date());

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
    const n = Number(String(valor).trim().replace(',', '.'));
    if (!isFinite(n) || n <= 0) return NaN;
    return n < 3 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
  }

  const chip = (o) => `<span class="chip ${o.cls}">${esc(o.txt)}</span>`;

  let toastTimer;
  function toast(msg, tipo = 'ok') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast ${tipo} visible`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('visible'), 3500);
  }

  function mensajeError(err) {
    if (!err) return 'Error desconocido';
    if (err.code === '23505') return 'Ya existe un paciente con ese CI.';
    if (err.code === '42501') return 'No tienes permiso para realizar esta acción.';
    if (err.code === '23514') return 'Algún dato está fuera de rango. Revisa el formulario.';
    const m = err.message || String(err);
    if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/Email not confirmed/i.test(m)) return 'Debes confirmar tu correo antes de ingresar.';
    if (/Signups not allowed/i.test(m)) return 'El registro de nuevos usuarios está deshabilitado.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Sin conexión con el servidor.';
    return m;
  }

  function ocupado(form, si) {
    $$('button, input', form).forEach((el) => { el.disabled = si; });
  }

  // ================= Vistas =================
  function mostrarVista(nombre) {
    $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== nombre; });
  }

  function irA(tab) {
    $$('[data-tab]').forEach((s) => { s.hidden = s.dataset.tab !== tab; });
    const activa = tab === 'detalle' ? 'pacientes' : tab;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.go === activa));
    if (tab === 'dosis') renderDosis();
    if (tab === 'pacientes') renderPacientes();
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

    let { data: esDuenio, error } = await sb.rpc('is_owner');
    if (error) return mostrarError(error);

    if (!esDuenio) {
      const r = await sb.rpc('owner_exists');
      if (r.error) return mostrarError(r.error);
      if (!r.data) {
        const c = await sb.rpc('claim_owner');
        if (c.error) return mostrarError(c.error);
        esDuenio = c.data;
        if (esDuenio) toast('Administrador creado correctamente');
      }
    }

    if (!esDuenio) return mostrarVista('denied');

    $('#user-email').textContent = session.user.email;
    mostrarVista('main');
    iniciarVigilanciaInactividad();
    await cargarPacientes();
    irA('pacientes');
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
    const { data, error } = await sb.auth.signUp({
      email, password, options: { emailRedirectTo: location.href.split('#')[0] },
    });
    ocupado(f, false);
    if (error) return toast(mensajeError(error), 'error');

    if (data.session) {
      await enrutar(data.session);
    } else {
      const aviso = $('#login-aviso');
      aviso.textContent = `Te enviamos un correo a ${email}. Ábrelo y confirma tu cuenta; luego inicia sesión aquí.`;
      aviso.hidden = false;
      $('#form-login').email.value = email;
      mostrarVista('login');
    }
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
    const { data, error } = await sb.from('pacientes')
      .select('*, registros(id, fecha_registro, peso_kg, imc, medicamento, dosis, proxima_dosis)')
      .order('apellido').order('nombre')
      .order('fecha_registro', { referencedTable: 'registros', ascending: false })
      .limit(1, { referencedTable: 'registros' });
    if (error) return toast(mensajeError(error), 'error');
    state.pacientes = data.map((p) => ({ ...p, ultimo: p.registros?.[0] || null }));
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
    renderFicha();
    renderRegistros();
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
    const { data, error } = await sb.from('registros')
      .select('*').eq('paciente_id', id).order('fecha_registro', { ascending: false });
    if (error) return toast(mensajeError(error), 'error');
    if (state.actual?.id !== id) return;    // el usuario cambió de paciente mientras cargaba
    state.registros = data;
    renderRegistros();
  }

  function renderRegistros() {
    const regs = state.registros;
    const u = regs[0];
    const primero = regs[regs.length - 1];

    if (u) {
      const dif = regs.length > 1 ? Number(u.peso_kg) - Number(primero.peso_kg) : null;
      const est = estadoDosis(u.proxima_dosis);
      $('#ficha-resumen').innerHTML = `
        <div class="stat"><span>Peso actual</span><strong>${fmtNum(u.peso_kg)} kg</strong>
          ${dif !== null ? `<small class="${dif <= 0 ? 'txt-ok' : 'txt-bad'}">${dif > 0 ? '+' : ''}${fmtNum(dif)} kg desde el inicio</small>` : ''}</div>
        <div class="stat"><span>IMC</span><strong>${fmtNum(u.imc, 2)}</strong>${chip(categoriaIMC(Number(u.imc)))}</div>
        <div class="stat"><span>Tratamiento</span><strong>${esc(u.dosis)}</strong><small>${esc(u.medicamento)}</small></div>
        <div class="stat"><span>Próxima dosis</span><strong>${fmtFecha(u.proxima_dosis)}</strong>${chip(est)}</div>`;
    } else {
      $('#ficha-resumen').innerHTML = '';
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

  function abrirDlgRegistro() {
    const p = state.actual;
    const f = $('#form-registro');
    f.reset();
    const u = state.registros[0];
    if (u) {
      f.medicamento.value = u.medicamento;
      f.dosis.value = u.dosis;
    }
    $('#reg-paciente').textContent = `${p.nombre} ${p.apellido} · CI ${p.ci} · ${calcularEdad(p.fecha_nacimiento)} años`;
    $('#reg-altura').textContent = `${fmtNum(p.altura_cm)} cm`;
    $('#reg-fecha').textContent = fmtFechaHora(new Date());
    $('#reg-proxima').textContent = fmtFecha(sumarDias(hoyISO(), 7));
    actualizarIMCPreview();
    $('#dlg-registro').showModal();
    f.peso_kg.focus();
  }

  function actualizarIMCPreview() {
    const peso = Number($('#form-registro').peso_kg.value);
    const out = $('#reg-imc');
    if (!peso || !state.actual) { out.textContent = '—'; return; }
    const v = calcularIMC(peso, Number(state.actual.altura_cm));
    out.innerHTML = `${fmtNum(v, 2)} ${chip(categoriaIMC(v))}`;
  }

  async function guardarRegistro(e) {
    e.preventDefault();
    const f = e.target;
    // La fecha, el IMC y la próxima dosis los calcula el servidor
    const datos = {
      paciente_id: state.actual.id,
      peso_kg: Number(f.peso_kg.value),
      medicamento: f.medicamento.value.trim(),
      dosis: f.dosis.value.trim(),
    };
    ocupado(f, true);
    const { error } = await sb.from('registros').insert(datos);
    ocupado(f, false);
    if (error) return toast(mensajeError(error), 'error');

    $('#dlg-registro').close();
    toast('Registro guardado');
    await Promise.all([cargarRegistros(), cargarPacientes()]);
  }

  async function eliminarRegistro(id) {
    const r = state.registros.find((x) => x.id === id);
    if (!r || !confirm(`¿Eliminar el registro del ${fmtFechaHora(r.fecha_registro)}?`)) return;
    const { error } = await sb.from('registros').delete().eq('id', id);
    if (error) return toast(mensajeError(error), 'error');
    toast('Registro eliminado');
    await Promise.all([cargarRegistros(), cargarPacientes()]);
  }

  // ================= Próximas dosis =================
  function renderDosis() {
    const lista = state.pacientes
      .filter((p) => p.ultimo)
      .sort((a, b) => a.ultimo.proxima_dosis.localeCompare(b.ultimo.proxima_dosis));

    const hoy = hoyISO();
    let vencidas = 0, deHoy = 0, semana = 0;
    lista.forEach((p) => {
      const d = diasEntre(hoy, p.ultimo.proxima_dosis);
      if (d < 0) vencidas++; else if (d === 0) deHoy++; else if (d <= 7) semana++;
    });
    $('#dosis-resumen').innerHTML = `
      <span class="chip bad">${vencidas} vencida(s)</span>
      <span class="chip warn">${deHoy} para hoy</span>
      <span class="chip ok">${semana} esta semana</span>`;

    $('#sin-dosis').hidden = lista.length > 0;
    $('#tabla-dosis tbody').innerHTML = lista.map((p) => {
      const u = p.ultimo;
      return `<tr data-id="${esc(p.id)}" tabindex="0">
        <td data-label="Próxima dosis"><strong>${fmtFecha(u.proxima_dosis)}</strong></td>
        <td data-label="Estado">${chip(estadoDosis(u.proxima_dosis))}</td>
        <td data-label="Paciente">${esc(p.apellido)}, ${esc(p.nombre)} <span class="muted small">CI ${esc(p.ci)}</span></td>
        <td data-label="Medicamento">${esc(u.medicamento)} · ${esc(u.dosis)}</td>
        <td data-label="Última dosis">${fmtFechaHora(u.fecha_registro)}</td>
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
  function enlazarEventos() {
    $('#form-setup').addEventListener('submit', crearAdmin);
    $('#form-login').addEventListener('submit', iniciarSesion);
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

    $('#btn-volver').addEventListener('click', () => irA('pacientes'));
    $('#btn-editar-paciente').addEventListener('click', () => abrirDlgPaciente(state.actual));
    $('#btn-eliminar-paciente').addEventListener('click', eliminarPaciente);
    $('#btn-nuevo-registro').addEventListener('click', abrirDlgRegistro);
    $('#tabla-registros tbody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-del]');
      if (b) eliminarRegistro(b.dataset.del);
    });

    $('#form-paciente').addEventListener('submit', guardarPaciente);
    $('#form-paciente').fecha_nacimiento.addEventListener('input', actualizarEdadPreview);
    $('#form-paciente').altura_cm.addEventListener('input', actualizarAlturaPreview);
    ['nombre', 'apellido'].forEach((campo) => {
      const input = $('#form-paciente')[campo];
      input.addEventListener('blur', () => { input.value = capitalizar(input.value); });
    });
    $('#form-registro').addEventListener('submit', guardarRegistro);
    $('#form-registro').peso_kg.addEventListener('input', actualizarIMCPreview);
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
    $('#btn-exportar').addEventListener('click', exportarCSV);

    sb.auth.onAuthStateChange((evento) => {
      if (evento === 'SIGNED_OUT') {
        detenerVigilancia();
        state.pacientes = []; state.actual = null; state.registros = [];
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
    const { data: { session } } = await sb.auth.getSession();
    await enrutar(session);
  }

  iniciar().catch(mostrarError);
})();
