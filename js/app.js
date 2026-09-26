import {
  watchAuth,
  login,
  logout,
  listarPlatos,
  guardarPlato,
  borrarPlato,
  marcarPlatoUsado,
  obtenerRestricciones,
  guardarRestricciones,
  obtenerMenu,
  guardarMenu,
  listarInventario,
  guardarItemInventario,
  borrarItemInventario,
  listarAlimentos,
  guardarAlimento,
  obtenerListaCompra,
  guardarListaCompra,
} from "./db.js";
import {
  generarMenu,
  DIAS,
  COMIDAS,
  CURSOS,
  CURSO_POR_CATEGORIA,
  ESTRUCTURA_POR_DEFECTO,
  cursoDePlato,
  comidaVacia,
} from "./generator.js";
import {
  DIAS_ESCOLAR,
  extraerPaginasPDF,
  parsearMenuEscolar,
  estructurarLineas,
  categorizarPlato,
  categorizarPostre,
} from "./escolar-pdf.js";

const DIA_LABEL = {
  lunes: "Lunes",
  martes: "Martes",
  miercoles: "Miércoles",
  jueves: "Jueves",
  viernes: "Viernes",
  sabado: "Sábado",
  domingo: "Domingo",
};

const CATEGORIA_LABEL = {
  legumbre: "Legumbre",
  pescado: "Pescado",
  carne: "Carne",
  pasta: "Pasta",
  arroz: "Arroz",
  verdura: "Verdura",
  huevo: "Huevo",
  ensalada: "Ensalada",
  otro: "Otro",
  fruta: "Fruta",
  lacteo: "Lácteo",
  postre: "Dulce",
};

const CATEGORIA_ICONO = {
  legumbre: "🫘",
  pescado: "🐟",
  carne: "🥩",
  pasta: "🍝",
  arroz: "🍚",
  verdura: "🥦",
  huevo: "🥚",
  ensalada: "🥗",
  otro: "🍽️",
  fruta: "🍎",
  lacteo: "🥛",
  postre: "🍮",
};

const CATEGORIAS_POSTRE = ["fruta", "lacteo", "postre"];

const CURSO_LABEL = { primero: "1º", segundo: "2º", postre: "Postre" };
const CURSO_NOMBRE = { primero: "Primero", segundo: "Segundo", postre: "Postre" };

function categoriaTexto(categoria) {
  return `${CATEGORIA_ICONO[categoria] || ""} ${CATEGORIA_LABEL[categoria] || categoria}`.trim();
}

function catBadge(categoria) {
  return `<span class="cat-badge" data-cat="${categoria}">${categoriaTexto(categoria)}</span>`;
}

let platosCache = [];
let restriccionesCache = null;
let menuActualDias = null; // { lunes: { comida: [platoId,...], cena: [...] }, ... }
let filtroCategoriaActiva = "";
let inventarioCache = [];
let alimentosCache = [];
let html5QrScanner = null;
let compraSemanaId = null;
let compraNecesidades = new Map();
let compraDoc = { marcados: {}, extras: [] };

const UBICACION_LABEL = { nevera: "🧊 Nevera", congelador: "🧊❄️ Congelador", despensa: "🥫 Despensa" };

// ---------- utilidades de fecha ----------

// Fecha local (no UTC): con toISOString() la medianoche en España caía en el
// día anterior y el "lunes" de la semana se guardaba como domingo.
function toISO(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function parseISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function sumarDias(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = domingo
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function diaKeyFromDate(date) {
  const idx = (date.getDay() + 6) % 7; // lunes=0 ... domingo=6
  return DIAS[idx];
}

function diasVacios() {
  const out = {};
  for (const dia of DIAS) out[dia] = { comida: comidaVacia(), cena: comidaVacia() };
  return out;
}

function idsDeComida(comida) {
  return CURSOS.map((c) => comida?.[c]).filter(Boolean);
}

// Formatos antiguos de una comida: un id suelto o una lista de ids. Cada
// plato se coloca en el hueco de su curso (1º, 2º o postre); si ya está
// ocupado, en el primero libre.
function normalizarComida(valor) {
  const out = comidaVacia();
  if (!valor) return out;
  if (!Array.isArray(valor) && typeof valor === "object") {
    for (const c of CURSOS) out[c] = valor[c] || null;
    return out;
  }
  for (const id of Array.isArray(valor) ? valor : [valor]) {
    const curso = cursoDePlato(platosCache.find((p) => p.id === id));
    const hueco = out[curso] == null ? curso : CURSOS.find((c) => out[c] == null);
    if (hueco) out[hueco] = id;
  }
  return out;
}

function normalizarDias(dias) {
  const out = diasVacios();
  for (const dia of DIAS) {
    for (const comida of COMIDAS) out[dia][comida] = normalizarComida(dias?.[dia]?.[comida]);
  }
  return out;
}

// Las semanas guardadas antes de corregir toISO() tienen como id el domingo
// anterior al lunes; si no hay nada con el id correcto, se busca ahí.
async function obtenerMenuNormalizado(semanaId) {
  const menu = (await obtenerMenu(semanaId)) || (await obtenerMenu(sumarDias(semanaId, -1)));
  if (!menu) return null;
  return { ...menu, dias: normalizarDias(menu.dias) };
}

// Migra restricciones guardadas con el esquema anterior (fuera/soloCena/
// soloComida por día, y legumbresPorSemana/pescadoPorSemana/carneRojaPorSemana
// como campos fijos) al esquema actual (ticks comida/cena por día + lista
// de reglas por categoría).
function migrarRestricciones(cfg) {
  if (!cfg) return restriccionesPorDefecto();
  const out = { ...cfg };

  const diasEspeciales = {};
  for (const dia of DIAS) {
    const flags = cfg.diasEspeciales?.[dia];
    if (!flags) {
      diasEspeciales[dia] = { comida: true, cena: true };
    } else if ("comida" in flags || "cena" in flags) {
      diasEspeciales[dia] = { comida: flags.comida !== false, cena: flags.cena !== false };
    } else {
      diasEspeciales[dia] = {
        comida: !flags.fuera && !flags.soloCena,
        cena: !flags.fuera && !flags.soloComida,
      };
    }
  }
  out.diasEspeciales = diasEspeciales;

  if (!cfg.reglasCategoria) {
    const reglas = [];
    if (cfg.legumbresPorSemana) reglas.push({ categoria: "legumbre", minPorSemana: cfg.legumbresPorSemana, maxPorSemana: "" });
    if (cfg.pescadoPorSemana) reglas.push({ categoria: "pescado", minPorSemana: cfg.pescadoPorSemana, maxPorSemana: "" });
    if (cfg.carneRojaPorSemana) reglas.push({ categoria: "carne", minPorSemana: 0, maxPorSemana: cfg.carneRojaPorSemana });
    out.reglasCategoria = reglas.length ? reglas : restriccionesPorDefecto().reglasCategoria;
  }

  out.semanasSinRepetir = cfg.semanasSinRepetir ?? 3;
  out.estructura = {
    comida: { ...ESTRUCTURA_POR_DEFECTO.comida, ...cfg.estructura?.comida },
    cena: { ...ESTRUCTURA_POR_DEFECTO.cena, ...cfg.estructura?.cena },
  };
  return out;
}

// ---------- catálogo de alimentos (evita duplicados tipo "garbanzos" / "Garbanzo") ----------

function normalizarNombreAlimento(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quitar acentos
    .trim()
    .replace(/\s+/g, " ");
}

function distanciaLevenshtein(a, b) {
  const filas = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) filas[i][0] = i;
  for (let j = 0; j <= b.length; j++) filas[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      filas[i][j] =
        a[i - 1] === b[j - 1]
          ? filas[i - 1][j - 1]
          : 1 + Math.min(filas[i - 1][j], filas[i][j - 1], filas[i - 1][j - 1]);
    }
  }
  return filas[a.length][b.length];
}

// Resuelve un texto escrito a mano contra el catálogo de "alimentos": si ya
// existe uno prácticamente igual lo reutiliza sin preguntar; si hay uno
// parecido (singular/plural, una letra distinta...) pide confirmación antes
// de crear un duplicado; si no hay nada parecido, crea uno nuevo.
async function resolverAlimento(textoOriginal) {
  const texto = (textoOriginal || "").trim();
  if (!texto) return null;
  const norm = normalizarNombreAlimento(texto);

  const exacto = alimentosCache.find((a) => normalizarNombreAlimento(a.nombre) === norm);
  if (exacto) return exacto;

  let mejor = null;
  let mejorDist = Infinity;
  for (const a of alimentosCache) {
    const d = distanciaLevenshtein(norm, normalizarNombreAlimento(a.nombre));
    if (d < mejorDist) {
      mejorDist = d;
      mejor = a;
    }
  }
  const umbral = norm.length <= 4 ? 1 : 2;
  if (mejor && mejorDist <= umbral) {
    const usarExistente = await confirmDialog(
      `"${texto}" no está tal cual en tu catálogo de alimentos, pero es muy parecido a "${mejor.nombre}" (ya existe). Confirmar = usar "${mejor.nombre}". Cancelar = crear "${texto}" como alimento nuevo.`
    );
    if (usarExistente) return mejor;
  }

  const id = await guardarAlimento({ nombre: texto });
  const nuevo = { id, nombre: texto };
  alimentosCache.push(nuevo);
  return nuevo;
}

function buildAlimentosConocidos() {
  const datalist = document.getElementById("alimentos-conocidos");
  if (!datalist) return;
  datalist.innerHTML = alimentosCache.map((a) => `<option value="${a.nombre}"></option>`).join("");
}

// Los platos guardados con la versión anterior de la app tenían los
// ingredientes como texto libre ("garbanzos 400 g") en vez de campos
// separados. Se parsean sobre la marcha para poder mostrarlos/editarlos.
function parsearIngredienteLibre(texto) {
  const m = texto.trim().match(/^(.*?)(?:\s+([\d.,]+)\s*([a-zA-Záéíóúñ]*))?$/);
  if (!m) return { nombre: texto.trim(), cantidad: null, unidad: "" };
  const [, nombre, cantidad, unidad] = m;
  return {
    nombre: (nombre || texto).trim(),
    cantidad: cantidad ? Number(cantidad.replace(",", ".")) : null,
    unidad: (unidad || "").trim(),
  };
}

function normalizarIngrediente(item) {
  if (typeof item === "string") return parsearIngredienteLibre(item);
  return { nombre: item.nombre || "", cantidad: item.cantidad ?? null, unidad: item.unidad || "" };
}

function formatearIngrediente(item) {
  const { nombre, cantidad, unidad } = normalizarIngrediente(item);
  const cantidadTexto = cantidad != null ? `${cantidad}${unidad ? " " + unidad : ""}` : unidad;
  return cantidadTexto ? `${nombre} — ${cantidadTexto}` : nombre;
}

// ---------- toasts y modal de confirmación ----------

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const btnYes = document.getElementById("confirm-modal-yes");
    const btnNo = document.getElementById("confirm-modal-no");
    document.getElementById("confirm-modal-message").textContent = message;
    modal.hidden = false;

    function cleanup(result) {
      modal.hidden = true;
      btnYes.removeEventListener("click", onYes);
      btnNo.removeEventListener("click", onNo);
      resolve(result);
    }
    function onYes() { cleanup(true); }
    function onNo() { cleanup(false); }
    btnYes.addEventListener("click", onYes);
    btnNo.addEventListener("click", onNo);
  });
}

// ---------- tabs ----------

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = true));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
      if (btn.dataset.tab === "hoy") renderHoy();
      if (btn.dataset.tab === "menu") renderMenuTab();
      if (btn.dataset.tab === "compra") recalcularCompra();
    });
  });
}

// ---------- auth ----------

function initAuth() {
  const btnLogin = document.getElementById("btn-login");
  const btnLogout = document.getElementById("btn-logout");
  const userInfo = document.getElementById("user-info");
  const signedOutMsg = document.getElementById("signed-out-msg");
  const nav = document.querySelector(".tabs");

  btnLogin.addEventListener("click", () => login().catch((e) => showToast("Error al entrar: " + e.message, "error")));
  btnLogout.addEventListener("click", () => logout());

  watchAuth(async (user) => {
    if (user) {
      btnLogin.hidden = true;
      btnLogout.hidden = false;
      userInfo.hidden = false;
      userInfo.textContent = user.displayName || user.email;
      signedOutMsg.hidden = true;
      nav.hidden = false;
      document.querySelectorAll(".tab-panel").forEach((p) => {
        p.hidden = p.id !== "tab-hoy";
      });

      await cargarDatos();
      renderHoy();
      renderPlatosList();
      renderConfigForm();
      renderInventarioList();
      buildAlimentosConocidos();
    } else {
      btnLogin.hidden = false;
      btnLogout.hidden = true;
      userInfo.hidden = true;
      signedOutMsg.hidden = false;
      nav.hidden = true;
      document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = true));
    }
  });
}

async function cargarDatos() {
  platosCache = await listarPlatos();
  restriccionesCache = migrarRestricciones(await obtenerRestricciones());
  inventarioCache = await listarInventario();
  alimentosCache = await listarAlimentos();
}

function restriccionesPorDefecto() {
  const diasEspeciales = {};
  for (const dia of DIAS) diasEspeciales[dia] = { comida: true, cena: true };
  return {
    reglasCategoria: [
      { categoria: "legumbre", minPorSemana: 2, maxPorSemana: "" },
      { categoria: "pescado", minPorSemana: 2, maxPorSemana: "" },
      { categoria: "carne", minPorSemana: 0, maxPorSemana: 2 },
    ],
    semanasSinRepetir: 3,
    diasEspeciales,
    estructura: structuredClone(ESTRUCTURA_POR_DEFECTO),
  };
}

// ---------- bloques del día: cole, comida y cena con el mismo formato ----------

const BLOQUE = {
  cole: { icono: "🏫", titulo: "Cole" },
  comida: { icono: "☀️", titulo: "Comida" },
  cena: { icono: "🌙", titulo: "Cena" },
};

function escapeHTML(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function lineaPlatoHTML(curso, contenido, extra = "") {
  return `<div class="plato-linea"><span class="plato-curso">${CURSO_LABEL[curso]}</span><div class="plato-linea-cuerpo">${contenido}</div>${extra}</div>`;
}

function nombreConIcono(categoria, nombre) {
  const icono = CATEGORIA_ICONO[categoria];
  return `<span class="plato-linea-nombre">${icono ? `<span class="plato-icono">${icono}</span>` : ""}${escapeHTML(nombre)}</span>`;
}

function tituloBloque(tipo) {
  return `<p class="bloque-titulo">${BLOQUE[tipo].icono} ${BLOQUE[tipo].titulo}</p>`;
}

// Menú del cole de un día (solo lectura; se edita en "Menú escolar").
function bloqueColeHTML(datosDia) {
  const lineas = CURSOS.map((curso) => {
    const p = datosDia?.[curso];
    if (!p?.nombre && !p?.categoria) return "";
    const guarnicion = curso === "segundo" && p.guarnicion ? `<span class="plato-guarnicion">+ ${escapeHTML(p.guarnicion)}</span>` : "";
    return lineaPlatoHTML(curso, nombreConIcono(p.categoria, p.nombre || "—") + guarnicion);
  }).join("");
  return `<div class="menu-bloque bloque-cole">${tituloBloque("cole")}${lineas || '<p class="hint">Sin menú del cole</p>'}</div>`;
}

function opcionesPlatoParaCurso(curso) {
  const orden = (a, b) => a.nombre.localeCompare(b.nombre, "es");
  const opcion = (p) => `<option value="${p.id}">${CATEGORIA_ICONO[p.categoria] || ""} ${escapeHTML(p.nombre)}</option>`;
  const delCurso = platosCache.filter((p) => cursoDePlato(p) === curso).sort(orden);
  const otros = platosCache.filter((p) => cursoDePlato(p) !== curso).sort(orden);
  return `<option value="">+ Elegir…</option>${delCurso.map(opcion).join("")}${otros.length ? `<optgroup label="Otros platos">${otros.map(opcion).join("")}</optgroup>` : ""}`;
}

// Comida o cena de casa de un día. Se muestran los cursos que la estructura
// de esa comida incluye (Reglas) y, además, cualquiera que ya tenga plato.
function bloqueCasaHTML(dia, comida, datosComida, editable) {
  const flags = restriccionesCache?.diasEspeciales?.[dia] || { comida: true, cena: true };
  if (!flags[comida]) {
    return `<div class="menu-bloque bloque-${comida} bloque-fuera">${tituloBloque(comida)}<p class="hint">No se come en casa</p></div>`;
  }
  const estructura = restriccionesCache?.estructura?.[comida] || ESTRUCTURA_POR_DEFECTO[comida];
  const datosAttr = (curso) => `data-dia="${dia}" data-comida="${comida}" data-curso="${curso}"`;

  const lineas = CURSOS.filter((c) => estructura[c] || datosComida?.[c]).map((curso) => {
    const id = datosComida?.[curso];
    if (id) {
      const plato = platosCache.find((p) => p.id === id);
      const quitar = editable ? `<button type="button" class="btn-quitar-plato" ${datosAttr(curso)} title="Quitar">×</button>` : "";
      return lineaPlatoHTML(curso, nombreConIcono(plato?.categoria, plato ? plato.nombre : "(plato borrado)"), quitar);
    }
    if (!editable) return lineaPlatoHTML(curso, '<span class="hint">—</span>');
    return lineaPlatoHTML(curso, `<select class="select-add-plato" ${datosAttr(curso)}>${opcionesPlatoParaCurso(curso)}</select>`);
  }).join("");

  return `<div class="menu-bloque bloque-${comida}">${tituloBloque(comida)}${lineas || '<p class="hint">Sin platos</p>'}</div>`;
}

// ---------- pestaña "Hoy" ----------

async function renderHoy() {
  const el = document.getElementById("hoy-content");
  el.innerHTML = `<p class="loading">Cargando…</p>`;
  const hoy = new Date();
  const lunes = toISO(mondayOf(hoy));
  const diaKey = diaKeyFromDate(hoy);
  const menu = await obtenerMenuNormalizado(lunes);

  const fechaLegible = hoy.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  const cabecera = `
    <div class="hoy-hero">
      <p class="hoy-fecha">${DIA_LABEL[diaKey]}</p>
      <h2>${fechaLegible}</h2>
    </div>
  `;

  const escolarHoy = DIAS_ESCOLAR.includes(diaKey) ? normalizarEscolarDia(menu?.menuEscolar?.[diaKey]) : null;
  const hayCole = escolarHoy && CURSOS.some((c) => escolarHoy[c]?.nombre);
  const diaMenu = menu?.dias?.[diaKey];
  const bloques = `
    <div class="hoy-bloques">
      ${hayCole ? bloqueColeHTML(escolarHoy) : ""}
      ${bloqueCasaHTML(diaKey, "comida", diaMenu?.comida, false)}
      ${bloqueCasaHTML(diaKey, "cena", diaMenu?.cena, false)}
    </div>
  `;

  const flagsHoy = restriccionesCache?.diasEspeciales?.[diaKey] || { comida: true, cena: true };
  const recetas = COMIDAS.filter((c) => flagsHoy[c]).flatMap((comida) =>
    CURSOS.filter((curso) => diaMenu?.[comida]?.[curso]).map((curso) =>
      renderRecetaBloque(comida, platosCache.find((p) => p.id === diaMenu[comida][curso]), curso)
    )
  );

  const sinNada = recetas.length === 0;
  el.innerHTML = cabecera + bloques + (sinNada
    ? `<div class="empty-state"><span class="empty-emoji">🗓️</span><p>No hay menú de casa generado para hoy. Ve a "Menú" para generarlo.</p></div>`
    : `<h3 class="hoy-recetas-titulo">Recetas de hoy</h3>${recetas.join("")}`);
}

function renderRecetaBloque(comida, plato, curso) {
  const etiqueta = `${BLOQUE[comida].icono} ${BLOQUE[comida].titulo}${curso ? ` · ${CURSO_NOMBRE[curso]}` : ""}`;
  if (!plato) return `<article class="receta-card"><p class="comida-label">${etiqueta}</p><p>Plato no encontrado.</p></article>`;
  const ingredientes = (plato.ingredientes || []).map((i) => `<li>${formatearIngrediente(i)}</li>`).join("");
  const pasos = (plato.pasos || []).map((p) => `<li>${p}</li>`).join("");
  return `
    <article class="receta-card">
      <p class="comida-label">${etiqueta}</p>
      <h3>${plato.nombre}</h3>
      ${catBadge(plato.categoria)}
      ${ingredientes ? `<h4>Ingredientes</h4><ul class="ingredientes-chips">${ingredientes}</ul>` : ""}
      ${pasos ? `<h4>Pasos</h4><ol class="receta-pasos">${pasos}</ol>` : ""}
    </article>
  `;
}

// ---------- pestaña "Catálogo de platos": pasos (texto libre) ----------

function crearFilaDinamica(contenedorId, valor = "") {
  const contenedor = document.getElementById(contenedorId);
  const row = document.createElement("div");
  row.className = "dynamic-row";
  row.innerHTML = `<input type="text" value="${valor.replace(/"/g, "&quot;")}" /><button type="button" class="btn-remove-row" title="Quitar">×</button>`;
  row.querySelector(".btn-remove-row").addEventListener("click", () => row.remove());
  contenedor.appendChild(row);
}

function leerPasos() {
  return Array.from(document.querySelectorAll("#pasos-list input"))
    .map((i) => i.value.trim())
    .filter(Boolean);
}

function resetPasos(pasos = []) {
  document.getElementById("pasos-list").innerHTML = "";
  (pasos.length ? pasos : [""]).forEach((v) => crearFilaDinamica("pasos-list", v));
}

// ---------- pestaña "Catálogo de platos": ingredientes (nombre + cantidad + unidad) ----------

function crearFilaIngrediente(ing = {}) {
  const contenedor = document.getElementById("ingredientes-list");
  const row = document.createElement("div");
  row.className = "ingrediente-row";
  const nombre = (ing.nombre || "").replace(/"/g, "&quot;");
  row.innerHTML = `
    <input type="text" class="ing-nombre" placeholder="Ingrediente" list="alimentos-conocidos" value="${nombre}" />
    <input type="number" class="ing-cantidad" placeholder="Cant." min="0" step="0.1" value="${ing.cantidad ?? ""}" />
    <input type="text" class="ing-unidad" placeholder="Unidad" value="${ing.unidad || ""}" />
    <button type="button" class="btn-remove-row" title="Quitar">×</button>
  `;
  row.querySelector(".btn-remove-row").addEventListener("click", () => row.remove());
  contenedor.appendChild(row);
}

function resetIngredientes(ingredientes = []) {
  document.getElementById("ingredientes-list").innerHTML = "";
  const filas = ingredientes.length ? ingredientes.map(normalizarIngrediente) : [{}];
  filas.forEach(crearFilaIngrediente);
}

// Lee las filas de ingredientes y resuelve cada nombre contra el catálogo
// de alimentos (crea uno nuevo si no existe, o pide confirmación si hay uno
// muy parecido). Es async porque puede escribir en Firestore.
async function leerIngredientes() {
  const filas = Array.from(document.querySelectorAll("#ingredientes-list .ingrediente-row"));
  const resultado = [];
  for (const fila of filas) {
    const nombreTexto = fila.querySelector(".ing-nombre").value.trim();
    if (!nombreTexto) continue;
    const cantidadTexto = fila.querySelector(".ing-cantidad").value;
    const unidad = fila.querySelector(".ing-unidad").value.trim();
    const alimento = await resolverAlimento(nombreTexto);
    resultado.push({
      alimentoId: alimento.id,
      nombre: alimento.nombre,
      cantidad: cantidadTexto ? Number(cantidadTexto) : null,
      unidad,
    });
  }
  return resultado;
}

// ---------- pestaña "Catálogo de platos" ----------

function initFormPlato() {
  const form = document.getElementById("form-plato");
  const btnCancelar = document.getElementById("btn-cancelar-edicion");

  document.getElementById("btn-add-ingrediente").addEventListener("click", () => crearFilaIngrediente());
  document.getElementById("btn-add-paso").addEventListener("click", () => crearFilaDinamica("pasos-list"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("plato-id").value || null;
    const nombrePlato = document.getElementById("plato-nombre").value.trim();
    const ingredientes = await leerIngredientes();
    const plato = {
      id,
      nombre: nombrePlato,
      categoria: document.getElementById("plato-categoria").value,
      curso: document.getElementById("plato-curso").value,
      tiempoPrep: document.getElementById("plato-tiempo").value,
      favorito: document.getElementById("plato-favorito").checked,
      ingredientes,
      pasos: leerPasos(),
    };
    await guardarPlato(plato);
    resetFormPlato();
    platosCache = await listarPlatos();
    renderPlatosList();
    buildAlimentosConocidos();
    showToast(`"${plato.nombre}" guardado.`, "success");
  });

  btnCancelar.addEventListener("click", resetFormPlato);

  // Al elegir categoría se propone el curso habitual; se puede cambiar a mano.
  const curso = document.getElementById("plato-curso");
  curso.addEventListener("change", () => (curso.dataset.manual = "1"));
  document.getElementById("plato-categoria").addEventListener("change", (e) => {
    if (curso.dataset.manual !== "1" && CURSO_POR_CATEGORIA[e.target.value]) curso.value = CURSO_POR_CATEGORIA[e.target.value];
  });

  document.getElementById("filtro-platos").addEventListener("input", renderPlatosList);

  resetIngredientes();
  resetPasos();
}

function resetFormPlato() {
  document.getElementById("form-plato").reset();
  document.getElementById("plato-id").value = "";
  document.getElementById("plato-favorito").checked = false;
  document.getElementById("plato-curso").dataset.manual = "";
  document.getElementById("btn-cancelar-edicion").hidden = true;
  resetIngredientes();
  resetPasos();
}

function buildFiltroCategoriaChips() {
  const cont = document.getElementById("filtro-categoria-chips");
  cont.innerHTML = Object.keys(CATEGORIA_LABEL)
    .map((cat) => `<button type="button" class="chip-filtro" data-cat="${cat}">${categoriaTexto(cat)}</button>`)
    .join("");
  cont.querySelectorAll(".chip-filtro").forEach((btn) => {
    btn.addEventListener("click", () => {
      filtroCategoriaActiva = filtroCategoriaActiva === btn.dataset.cat ? "" : btn.dataset.cat;
      cont.querySelectorAll(".chip-filtro").forEach((b) => b.classList.toggle("active", b.dataset.cat === filtroCategoriaActiva));
      renderPlatosList();
    });
  });
}

function renderPlatosList() {
  const contenedor = document.getElementById("lista-platos");
  const texto = document.getElementById("filtro-platos").value.trim().toLowerCase();
  contenedor.innerHTML = "";

  const filtrados = platosCache.filter((p) => {
    const coincideTexto = !texto || p.nombre.toLowerCase().includes(texto);
    const coincideCategoria = !filtroCategoriaActiva || p.categoria === filtroCategoriaActiva;
    return coincideTexto && coincideCategoria;
  });

  if (filtrados.length === 0) {
    contenedor.innerHTML = `<div class="empty-state"><span class="empty-emoji">🔍</span><p>No hay platos que coincidan.</p></div>`;
    return;
  }

  for (const cat of Object.keys(CATEGORIA_LABEL)) {
    const items = filtrados
      .filter((p) => p.categoria === cat)
      .sort((a, b) => (b.favorito ? 1 : 0) - (a.favorito ? 1 : 0) || a.nombre.localeCompare(b.nombre, "es"));
    if (items.length === 0) continue;

    const seccion = document.createElement("section");
    seccion.className = "platos-seccion";
    seccion.innerHTML = `<h3 class="platos-seccion-titulo">${categoriaTexto(cat)} <span class="hint">(${items.length})</span></h3><ul class="platos-lista"></ul>`;
    const ul = seccion.querySelector("ul");

    for (const plato of items) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <strong>${plato.nombre}</strong>
          <div class="plato-meta hint">${CURSO_NOMBRE[cursoDePlato(plato)]} · ${plato.tiempoPrep || "normal"}</div>
        </div>
        <div class="plato-actions">
          <button data-action="favorito" class="btn-ghost btn-small" title="${plato.favorito ? "Quitar de favoritos" : "Marcar como favorito"}">${plato.favorito ? "⭐" : "☆"}</button>
          <button data-action="editar" class="btn-ghost btn-small">Editar</button>
          <button data-action="borrar" class="btn-ghost btn-small">Borrar</button>
        </div>
      `;
      li.querySelector('[data-action="favorito"]').addEventListener("click", async () => {
        await guardarPlato({ ...plato, favorito: !plato.favorito });
        platosCache = await listarPlatos();
        renderPlatosList();
      });
      li.querySelector('[data-action="editar"]').addEventListener("click", () => cargarPlatoEnForm(plato));
      li.querySelector('[data-action="borrar"]').addEventListener("click", async () => {
        const ok = await confirmDialog(`¿Borrar "${plato.nombre}"?`);
        if (!ok) return;
        await borrarPlato(plato.id);
        platosCache = await listarPlatos();
        renderPlatosList();
        showToast(`"${plato.nombre}" borrado.`, "success");
      });
      ul.appendChild(li);
    }
    contenedor.appendChild(seccion);
  }
}

function cargarPlatoEnForm(plato) {
  document.getElementById("plato-id").value = plato.id;
  document.getElementById("plato-nombre").value = plato.nombre || "";
  document.getElementById("plato-categoria").value = plato.categoria || "";
  document.getElementById("plato-curso").value = cursoDePlato(plato);
  document.getElementById("plato-curso").dataset.manual = plato.curso ? "1" : "";
  document.getElementById("plato-tiempo").value = plato.tiempoPrep || "normal";
  document.getElementById("plato-favorito").checked = !!plato.favorito;
  resetIngredientes(plato.ingredientes || []);
  resetPasos(plato.pasos || []);
  document.getElementById("btn-cancelar-edicion").hidden = false;
  document.querySelector('[data-tab="platos"]').click();
  document.getElementById("plato-nombre").scrollIntoView({ behavior: "smooth" });
}

// ---------- pestaña "Restricciones": tabla de días ----------

function buildDiasEspecialesTabla() {
  const tbody = document.querySelector("#dias-especiales-tabla tbody");
  tbody.innerHTML = "";
  for (const dia of DIAS) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${DIA_LABEL[dia]}</td>
      <td><input type="checkbox" data-dia="${dia}" data-comida="comida" /></td>
      <td><input type="checkbox" data-dia="${dia}" data-comida="cena" /></td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------- pestaña "Restricciones": reglas por categoría dinámicas ----------

function crearFilaRegla(regla = {}) {
  const contenedor = document.getElementById("reglas-list");
  const row = document.createElement("div");
  row.className = "regla-row";
  const opciones = Object.keys(CATEGORIA_LABEL)
    .map((val) => `<option value="${val}" ${regla.categoria === val ? "selected" : ""}>${categoriaTexto(val)}</option>`)
    .join("");
  row.innerHTML = `
    <select class="regla-categoria">${opciones}</select>
    <input type="number" class="regla-min" placeholder="Mín/sem" min="0" max="14" value="${regla.minPorSemana ?? ""}" />
    <input type="number" class="regla-max" placeholder="Máx/sem" min="0" max="14" value="${regla.maxPorSemana ?? ""}" />
    <button type="button" class="btn-remove-row" title="Quitar regla">×</button>
  `;
  row.querySelector(".btn-remove-row").addEventListener("click", () => row.remove());
  contenedor.appendChild(row);
}

function leerReglas() {
  return Array.from(document.querySelectorAll("#reglas-list .regla-row"))
    .map((row) => ({
      categoria: row.querySelector(".regla-categoria").value,
      minPorSemana: row.querySelector(".regla-min").value ? Number(row.querySelector(".regla-min").value) : 0,
      maxPorSemana: row.querySelector(".regla-max").value ? Number(row.querySelector(".regla-max").value) : "",
    }))
    .filter((r) => r.categoria);
}

function resetReglas(reglas) {
  document.getElementById("reglas-list").innerHTML = "";
  (reglas && reglas.length ? reglas : [{}]).forEach(crearFilaRegla);
}

function renderConfigForm() {
  const cfg = restriccionesCache || restriccionesPorDefecto();
  document.getElementById("cfg-semanas-sin-repetir").value = cfg.semanasSinRepetir;
  resetReglas(cfg.reglasCategoria);
  document.querySelectorAll("#dias-especiales-tabla input[type=checkbox]").forEach((input) => {
    const { dia, comida } = input.dataset;
    input.checked = cfg.diasEspeciales?.[dia]?.[comida] !== false;
  });
  document.querySelectorAll("#estructura-tabla input[type=checkbox]").forEach((input) => {
    const { comida, curso } = input.dataset;
    input.checked = (cfg.estructura?.[comida] || ESTRUCTURA_POR_DEFECTO[comida])[curso] !== false;
  });
}

function leerEstructura() {
  const estructura = { comida: {}, cena: {} };
  document.querySelectorAll("#estructura-tabla input[type=checkbox]").forEach((input) => {
    estructura[input.dataset.comida][input.dataset.curso] = input.checked;
  });
  return estructura;
}

function initFormConfig() {
  document.getElementById("btn-add-regla").addEventListener("click", () => crearFilaRegla({}));

  document.getElementById("form-config").addEventListener("submit", async (e) => {
    e.preventDefault();
    const diasEspeciales = {};
    for (const dia of DIAS) {
      diasEspeciales[dia] = {
        comida: document.querySelector(`#dias-especiales-tabla [data-dia="${dia}"][data-comida="comida"]`).checked,
        cena: document.querySelector(`#dias-especiales-tabla [data-dia="${dia}"][data-comida="cena"]`).checked,
      };
    }
    restriccionesCache = {
      reglasCategoria: leerReglas(),
      semanasSinRepetir: Number(document.getElementById("cfg-semanas-sin-repetir").value),
      diasEspeciales,
      estructura: leerEstructura(),
    };
    await guardarRestricciones(restriccionesCache);
    showToast("Restricciones guardadas.", "success");
  });
}

// ---------- pestaña "Menú semanal": menú escolar ----------

// Cada día del cole tiene tres líneas: primer plato, segundo (con su
// guarnición) y postre, cada una con el nombre exacto y su categoría.
const TIPOS_ESCOLAR = [
  { tipo: "primero", etiqueta: "1º", placeholder: "Primer plato" },
  { tipo: "segundo", etiqueta: "2º", placeholder: "Segundo plato" },
  { tipo: "postre", etiqueta: "Postre", placeholder: "Postre" },
];

function opcionesCategoriaEscolar(tipo) {
  const lista = Object.keys(CATEGORIA_LABEL).filter((c) => CATEGORIAS_POSTRE.includes(c) === (tipo === "postre"));
  return `<option value="">—</option>` + lista.map((c) => `<option value="${c}">${categoriaTexto(c)}</option>`).join("");
}

function campoEscolar(dia, tipo, clase) {
  return document.querySelector(`#menu-escolar-grid .${clase}[data-dia="${dia}"][data-tipo="${tipo}"]`);
}

function buildMenuEscolarGrid() {
  const cont = document.getElementById("menu-escolar-grid");
  cont.innerHTML = "";
  for (const dia of DIAS_ESCOLAR) {
    const fila = document.createElement("div");
    fila.className = "escolar-fila";
    const lineas = TIPOS_ESCOLAR.map(({ tipo, etiqueta, placeholder }) => `
      <div class="escolar-plato">
        <span class="escolar-tipo">${etiqueta}</span>
        <select class="escolar-cat" data-dia="${dia}" data-tipo="${tipo}" title="Categoría">${opcionesCategoriaEscolar(tipo)}</select>
        <input type="text" class="escolar-nombre" data-dia="${dia}" data-tipo="${tipo}" placeholder="${placeholder}" />
        ${tipo === "segundo" ? `<input type="text" class="escolar-guarnicion" data-dia="${dia}" data-tipo="segundo" placeholder="Guarnición" />` : ""}
      </div>
    `).join("");
    fila.innerHTML = `
      <div class="escolar-dia">${DIA_LABEL[dia]} <span class="hint escolar-fecha" data-dia="${dia}"></span></div>
      ${lineas}
    `;
    cont.appendChild(fila);
  }
}

function escolarDiaVacio() {
  return {
    primero: { nombre: "", categoria: "" },
    segundo: { nombre: "", categoria: "", guarnicion: "" },
    postre: { nombre: "", categoria: "" },
  };
}

// Formatos antiguos de menuEscolar[dia]: un string con la categoría, o
// { categoria, texto } con los platos en texto libre.
function normalizarEscolarDia(valor) {
  const vacio = escolarDiaVacio();
  if (!valor) return vacio;
  if (typeof valor === "string") {
    vacio.primero.categoria = valor;
    return vacio;
  }
  if (valor.primero || valor.segundo || valor.postre) {
    return {
      primero: { ...vacio.primero, ...valor.primero },
      segundo: { ...vacio.segundo, ...valor.segundo },
      postre: { ...vacio.postre, ...valor.postre },
    };
  }
  if (valor.texto) return estructurarLineas(valor.texto.split("\n").map((s) => s.trim()).filter(Boolean));
  vacio.primero.categoria = valor.categoria || "";
  return vacio;
}

function leerMenuEscolar() {
  const out = {};
  for (const dia of DIAS_ESCOLAR) {
    const dato = escolarDiaVacio();
    for (const { tipo } of TIPOS_ESCOLAR) {
      dato[tipo].nombre = campoEscolar(dia, tipo, "escolar-nombre")?.value.trim() || "";
      dato[tipo].categoria = campoEscolar(dia, tipo, "escolar-cat")?.value || "";
    }
    dato.segundo.guarnicion = campoEscolar(dia, "segundo", "escolar-guarnicion")?.value.trim() || "";
    out[dia] = dato;
  }
  return out;
}

function aplicarMenuEscolarAlFormulario(menuEscolar) {
  const semanaId = document.getElementById("week-start").value;
  DIAS_ESCOLAR.forEach((dia, i) => {
    const dato = normalizarEscolarDia(menuEscolar?.[dia]);
    for (const { tipo } of TIPOS_ESCOLAR) {
      const nombre = campoEscolar(dia, tipo, "escolar-nombre");
      const cat = campoEscolar(dia, tipo, "escolar-cat");
      if (nombre) nombre.value = dato[tipo].nombre;
      if (cat) {
        cat.value = dato[tipo].categoria;
        cat.dataset.manual = "";
      }
    }
    const guarnicion = campoEscolar(dia, "segundo", "escolar-guarnicion");
    if (guarnicion) guarnicion.value = dato.segundo.guarnicion;

    const fecha = document.querySelector(`#menu-escolar-grid .escolar-fecha[data-dia="${dia}"]`);
    if (fecha && semanaId) {
      fecha.textContent = parseISO(sumarDias(semanaId, i)).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
    }
  });
}

function initMenuEscolarPersistence() {
  document.getElementById("menu-escolar-grid").addEventListener("change", async (e) => {
    const el = e.target;
    if (el.classList.contains("escolar-cat")) el.dataset.manual = "1";
    // Al escribir el nombre se deduce el icono, salvo que se haya elegido a mano.
    if (el.classList.contains("escolar-nombre")) {
      const cat = campoEscolar(el.dataset.dia, el.dataset.tipo, "escolar-cat");
      if (cat && cat.dataset.manual !== "1") {
        cat.value = el.dataset.tipo === "postre" ? categorizarPostre(el.value) : categorizarPlato(el.value);
      }
    }
    await persistirMenuActual();
    renderMenuGrid();
  });
}

// ---------- pestaña "Menú semanal": calendario ----------

// Cualquier día que se elija en el calendario se lleva al lunes de su semana.
function ajustarALunes(input) {
  if (!input.value) input.value = toISO(mondayOf(new Date()));
  const lunes = toISO(mondayOf(parseISO(input.value)));
  if (lunes !== input.value) input.value = lunes;
}

function initWeekStartDefault() {
  const input = document.getElementById("week-start");
  input.value = toISO(mondayOf(new Date()));
  input.addEventListener("change", () => {
    ajustarALunes(input);
    renderMenuTab();
  });
}

async function renderMenuTab() {
  const semanaId = document.getElementById("week-start").value || toISO(mondayOf(new Date()));
  const menu = await obtenerMenuNormalizado(semanaId);
  menuActualDias = menu?.dias || diasVacios();
  aplicarMenuEscolarAlFormulario(menu?.menuEscolar);
  renderMenuGrid();
  if (menu?.dias) renderResumenCuotas(menuActualDias);
  else document.getElementById("menu-resumen").hidden = true;
  ocultarAvisos();
}

// Rejilla semanal: una fila por día con tres bloques (cole, comida y cena)
// en el mismo formato de líneas 1º / 2º / postre. Al ser una rejilla de
// filas y columnas reales, los bloques de un mismo día quedan alineados.
function renderMenuGrid() {
  const grid = document.getElementById("menu-grid");
  const escolar = leerMenuEscolar();
  const semanaId = document.getElementById("week-start").value;

  const cabecera = `
    <div class="menu-cabecera"></div>
    <div class="menu-cabecera cab-cole">${BLOQUE.cole.icono} ${BLOQUE.cole.titulo}</div>
    <div class="menu-cabecera cab-comida">${BLOQUE.comida.icono} ${BLOQUE.comida.titulo}</div>
    <div class="menu-cabecera cab-cena">${BLOQUE.cena.icono} ${BLOQUE.cena.titulo}</div>
  `;

  const filas = DIAS.map((dia, i) => {
    const fecha = semanaId ? parseISO(sumarDias(semanaId, i)).toLocaleDateString("es-ES", { day: "numeric", month: "short" }) : "";
    const opcionesIntercambio = DIAS.filter((d) => d !== dia).map((d) => `<option value="${d}">${DIA_LABEL[d]}</option>`).join("");
    const cole = DIAS_ESCOLAR.includes(dia)
      ? bloqueColeHTML(escolar[dia])
      : `<div class="menu-bloque bloque-cole bloque-fuera">${tituloBloque("cole")}<p class="hint">No hay cole</p></div>`;
    return `
      <div class="menu-dia">
        <span class="menu-dia-nombre">${DIA_LABEL[dia]}</span>
        <span class="hint">${fecha}</span>
        <select class="select-intercambiar" data-dia="${dia}"><option value="">🔀 Cambiar día</option>${opcionesIntercambio}</select>
      </div>
      ${cole}
      ${bloqueCasaHTML(dia, "comida", menuActualDias?.[dia]?.comida, true)}
      ${bloqueCasaHTML(dia, "cena", menuActualDias?.[dia]?.cena, true)}
    `;
  }).join("");

  grid.innerHTML = cabecera + filas;

  grid.querySelectorAll(".btn-quitar-plato").forEach((btn) => {
    btn.addEventListener("click", () => ponerPlato(btn.dataset.dia, btn.dataset.comida, btn.dataset.curso, null));
  });
  grid.querySelectorAll(".select-add-plato").forEach((sel) => {
    sel.addEventListener("change", () => {
      if (sel.value) ponerPlato(sel.dataset.dia, sel.dataset.comida, sel.dataset.curso, sel.value);
    });
  });
  grid.querySelectorAll(".select-intercambiar").forEach((sel) => {
    sel.addEventListener("change", async () => {
      if (!sel.value) return;
      const dia = sel.dataset.dia;
      const otro = sel.value;
      const ok = await confirmDialog(`¿Intercambiar la comida y la cena de ${DIA_LABEL[dia]} con las de ${DIA_LABEL[otro]}?`);
      if (ok) {
        const tmp = menuActualDias[dia];
        menuActualDias[dia] = menuActualDias[otro];
        menuActualDias[otro] = tmp;
        await persistirMenuActual();
        renderResumenCuotas(menuActualDias);
      }
      renderMenuGrid();
    });
  });
}

async function persistirMenuActual() {
  const semanaId = document.getElementById("week-start").value;
  if (!menuActualDias) menuActualDias = (await obtenerMenuNormalizado(semanaId))?.dias || diasVacios();
  await guardarMenu(semanaId, { dias: menuActualDias, menuEscolar: leerMenuEscolar() });
}

async function ponerPlato(dia, comida, curso, platoId) {
  menuActualDias[dia][comida][curso] = platoId;
  await persistirMenuActual();
  renderMenuGrid();
  renderResumenCuotas(menuActualDias);
}

function renderResumenCuotas(dias) {
  const conteo = {};
  for (const dia of DIAS) {
    for (const comida of COMIDAS) {
      for (const id of idsDeComida(dias[dia]?.[comida])) {
        const plato = platosCache.find((p) => p.id === id);
        if (plato) conteo[plato.categoria] = (conteo[plato.categoria] || 0) + 1;
      }
    }
  }
  const resumen = document.getElementById("menu-resumen");
  const entradas = Object.entries(conteo);
  if (entradas.length === 0) {
    resumen.hidden = true;
    return;
  }
  resumen.hidden = false;
  resumen.innerHTML = entradas.map(([cat, n]) => `<span class="quota-pill">${categoriaTexto(cat)}: ${n}</span>`).join("");
}

function mostrarAvisos(warnings) {
  const banner = document.getElementById("menu-avisos");
  if (!warnings.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `<strong>Avisos del generador:</strong><ul>${warnings.map((w) => `<li>${w}</li>`).join("")}</ul>`;
}

function ocultarAvisos() {
  document.getElementById("menu-avisos").hidden = true;
}

function initGenerarMenu() {
  document.getElementById("btn-generar").addEventListener("click", async () => {
    if (!restriccionesCache) restriccionesCache = restriccionesPorDefecto();
    const semanaId = document.getElementById("week-start").value || toISO(mondayOf(new Date()));

    const existente = await obtenerMenuNormalizado(semanaId);
    const yaHabiaAlgo = existente?.dias && Object.values(existente.dias).some((d) => idsDeComida(d.comida).length || idsDeComida(d.cena).length);
    if (yaHabiaAlgo) {
      const ok = await confirmDialog("Ya hay un menú generado para esta semana. ¿Quieres sobrescribirlo?");
      if (!ok) return;
    }

    const menuEscolar = leerMenuEscolar();
    const { dias, warnings } = generarMenu(platosCache, restriccionesCache, menuEscolar, semanaId);
    menuActualDias = dias;
    await guardarMenu(semanaId, { dias, menuEscolar });

    for (const [idx, dia] of DIAS.entries()) {
      const fechaISO = sumarDias(semanaId, idx);
      for (const comida of COMIDAS) {
        for (const platoId of idsDeComida(dias[dia][comida])) {
          await marcarPlatoUsado(platoId, fechaISO);
        }
      }
    }
    platosCache = await listarPlatos();
    renderMenuGrid();
    renderResumenCuotas(dias);
    mostrarAvisos(warnings);
    showToast("Menú generado.", "success");
  });
}

function initImprimir() {
  document.getElementById("btn-imprimir").addEventListener("click", () => window.print());
}

// ---------- pestaña "Inventario" ----------

function initFormInventario() {
  const form = document.getElementById("form-inventario");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombreTexto = document.getElementById("inv-nombre").value.trim();
    const alimento = await resolverAlimento(nombreTexto);
    if (!alimento) return;
    const item = {
      id: document.getElementById("inv-id").value || null,
      alimentoId: alimento.id,
      nombre: alimento.nombre,
      cantidad: document.getElementById("inv-cantidad").value ? Number(document.getElementById("inv-cantidad").value) : null,
      unidad: document.getElementById("inv-unidad").value.trim(),
      ubicacion: document.getElementById("inv-ubicacion").value,
      detalle: document.getElementById("inv-detalle").value.trim(),
      codigoBarras: document.getElementById("inv-codigo").value || null,
      actualizado: toISO(new Date()),
    };
    await guardarItemInventario(item);
    resetFormInventario();
    inventarioCache = await listarInventario();
    renderInventarioList();
    buildAlimentosConocidos();
    showToast(`"${item.nombre}" guardado en el inventario.`, "success");
  });

  document.getElementById("btn-cancelar-inventario").addEventListener("click", resetFormInventario);
  document.getElementById("filtro-inventario").addEventListener("input", renderInventarioList);
}

function resetFormInventario() {
  document.getElementById("form-inventario").reset();
  document.getElementById("inv-id").value = "";
  document.getElementById("inv-codigo").value = "";
  document.getElementById("btn-cancelar-inventario").hidden = true;
}

function cargarItemEnForm(item) {
  document.getElementById("inv-id").value = item.id;
  document.getElementById("inv-nombre").value = item.nombre || "";
  document.getElementById("inv-cantidad").value = item.cantidad ?? "";
  document.getElementById("inv-unidad").value = item.unidad || "";
  document.getElementById("inv-ubicacion").value = item.ubicacion || "nevera";
  document.getElementById("inv-detalle").value = item.detalle || "";
  document.getElementById("inv-codigo").value = item.codigoBarras || "";
  document.getElementById("btn-cancelar-inventario").hidden = false;
  document.querySelector('[data-tab="inventario"]').click();
  document.getElementById("inv-nombre").scrollIntoView({ behavior: "smooth" });
}

function renderInventarioList() {
  const contenedor = document.getElementById("lista-inventario");
  if (!contenedor) return;
  const texto = document.getElementById("filtro-inventario").value.trim().toLowerCase();
  contenedor.innerHTML = "";

  const filtrados = inventarioCache.filter((i) => !texto || i.nombre.toLowerCase().includes(texto));

  if (filtrados.length === 0) {
    contenedor.innerHTML = `<div class="empty-state"><span class="empty-emoji">🧺</span><p>${inventarioCache.length === 0 ? "El inventario está vacío." : "No hay productos que coincidan."}</p></div>`;
    return;
  }

  for (const ubic of Object.keys(UBICACION_LABEL)) {
    const items = filtrados.filter((i) => i.ubicacion === ubic).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    if (items.length === 0) continue;

    const seccion = document.createElement("section");
    seccion.className = "platos-seccion";
    seccion.innerHTML = `<h3 class="platos-seccion-titulo">${UBICACION_LABEL[ubic]} <span class="hint">(${items.length})</span></h3><ul class="platos-lista"></ul>`;
    const ul = seccion.querySelector("ul");

    for (const item of items) {
      const detalle = [item.cantidad != null ? `${item.cantidad} ${item.unidad || ""}`.trim() : "", item.detalle || ""]
        .filter(Boolean)
        .join(" · ");
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <strong>${item.nombre}</strong>
          ${detalle ? `<div class="plato-meta hint">${detalle}</div>` : ""}
        </div>
        <div class="plato-actions">
          <button data-action="editar" class="btn-ghost btn-small">Editar</button>
          <button data-action="borrar" class="btn-ghost btn-small">Borrar</button>
        </div>
      `;
      li.querySelector('[data-action="editar"]').addEventListener("click", () => cargarItemEnForm(item));
      li.querySelector('[data-action="borrar"]').addEventListener("click", async () => {
        const ok = await confirmDialog(`¿Borrar "${item.nombre}" del inventario?`);
        if (!ok) return;
        await borrarItemInventario(item.id);
        inventarioCache = await listarInventario();
        renderInventarioList();
        showToast(`"${item.nombre}" borrado.`, "success");
      });
      ul.appendChild(li);
    }
    contenedor.appendChild(seccion);
  }
}

// ---------- pestaña "Compra" ----------

function claveNecesidad(alimentoId, nombre, unidad) {
  const base = alimentoId || normalizarNombreAlimento(nombre);
  return `${base}|${(unidad || "").toLowerCase().trim()}`;
}

// Suma los ingredientes de todos los platos del menú de esa semana,
// agrupando por alimento+unidad (no se puede sumar "400 g" con "2 uds" del
// mismo alimento con garantías, así que se quedan como líneas separadas).
function calcularNecesidades(diasMenu) {
  const mapa = new Map();
  for (const dia of DIAS) {
    for (const comida of COMIDAS) {
      const ids = idsDeComida(diasMenu?.[dia]?.[comida]);
      for (const platoId of ids) {
        const plato = platosCache.find((p) => p.id === platoId);
        if (!plato) continue;
        for (const ingRaw of plato.ingredientes || []) {
          const ing = normalizarIngrediente(ingRaw);
          if (!ing.nombre) continue;
          const alimentoId = typeof ingRaw === "object" ? ingRaw.alimentoId : null;
          const clave = claveNecesidad(alimentoId, ing.nombre, ing.unidad);
          if (!mapa.has(clave)) {
            mapa.set(clave, { alimentoId, nombre: ing.nombre, unidad: ing.unidad, cantidad: 0, sinCantidad: false });
          }
          const entrada = mapa.get(clave);
          if (ing.cantidad != null) entrada.cantidad += ing.cantidad;
          else entrada.sinCantidad = true;
        }
      }
    }
  }
  return mapa;
}

function disponibleEnInventario(alimentoId, nombre, unidad) {
  const unidadNorm = (unidad || "").toLowerCase().trim();
  return inventarioCache
    .filter((i) => {
      const coincideAlimento = alimentoId
        ? i.alimentoId === alimentoId
        : normalizarNombreAlimento(i.nombre) === normalizarNombreAlimento(nombre);
      const coincideUnidad = (i.unidad || "").toLowerCase().trim() === unidadNorm;
      return coincideAlimento && coincideUnidad;
    })
    .reduce((sum, i) => sum + (i.cantidad || 0), 0);
}

function initCompra() {
  const input = document.getElementById("compra-week-start");
  input.value = toISO(mondayOf(new Date()));
  input.addEventListener("change", () => {
    ajustarALunes(input);
    recalcularCompra();
  });
  document.getElementById("btn-recalcular-compra").addEventListener("click", recalcularCompra);

  document.getElementById("form-extra-compra").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombreTexto = document.getElementById("extra-nombre").value.trim();
    if (!nombreTexto) return;
    const alimento = await resolverAlimento(nombreTexto);
    const cantidadTexto = document.getElementById("extra-cantidad").value;
    const unidad = document.getElementById("extra-unidad").value.trim();
    compraDoc.extras.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      alimentoId: alimento?.id || null,
      nombre: alimento?.nombre || nombreTexto,
      cantidad: cantidadTexto ? Number(cantidadTexto) : null,
      unidad,
      comprado: false,
    });
    await guardarListaCompra(compraSemanaId, compraDoc);
    document.getElementById("form-extra-compra").reset();
    renderListaCompra();
    buildAlimentosConocidos();
  });
}

async function recalcularCompra() {
  const semanaId = document.getElementById("compra-week-start").value || toISO(mondayOf(new Date()));
  compraSemanaId = semanaId;
  const menu = await obtenerMenuNormalizado(semanaId);
  compraNecesidades = calcularNecesidades(menu?.dias || diasVacios());
  const guardado = (await obtenerListaCompra(semanaId)) || (await obtenerListaCompra(sumarDias(semanaId, -1)));
  compraDoc = guardado || { marcados: {}, extras: [] };
  if (!compraDoc.extras) compraDoc.extras = [];
  if (!compraDoc.marcados) compraDoc.marcados = {};
  renderListaCompra();
}

function renderListaCompra() {
  const cont = document.getElementById("lista-compra-contenido");
  if (!cont) return;
  cont.innerHTML = "";

  const itemsAuto = [...compraNecesidades.entries()]
    .map(([clave, n]) => {
      const disponible = disponibleEnInventario(n.alimentoId, n.nombre, n.unidad);
      const aComprar = n.sinCantidad ? null : Math.max(0, n.cantidad - disponible);
      return { clave, ...n, disponible, aComprar };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

  const seccionAuto = document.createElement("section");
  seccionAuto.className = "compra-seccion";
  if (itemsAuto.length === 0) {
    seccionAuto.innerHTML = `<h3 class="compra-seccion-titulo">Del menú</h3><p class="hint">No hay menú generado esta semana, o los platos no tienen ingredientes cargados.</p>`;
  } else {
    seccionAuto.innerHTML = `<h3 class="compra-seccion-titulo">Del menú (${itemsAuto.length})</h3><ul class="compra-lista"></ul>`;
    const ul = seccionAuto.querySelector("ul");
    for (const item of itemsAuto) {
      const marcado = !!compraDoc.marcados[item.clave];
      let nota;
      if (item.sinCantidad) nota = "cantidad no especificada en la receta";
      else if (item.aComprar <= 0) nota = `ya tienes suficiente (${item.disponible} ${item.unidad || ""})`.trim();
      else nota = `${item.aComprar} ${item.unidad || ""}`.trim() + (item.disponible > 0 ? ` (ya tienes ${item.disponible})` : "");
      const li = document.createElement("li");
      li.className = marcado ? "comprado" : "";
      li.innerHTML = `
        <input type="checkbox" ${marcado ? "checked" : ""} />
        <div class="compra-item-info">
          <div class="compra-item-nombre">${item.nombre}</div>
          <div class="compra-item-nota">${nota}</div>
        </div>
      `;
      li.querySelector("input").addEventListener("change", (e) => toggleMarcadoAuto(item.clave, e.target.checked, li));
      ul.appendChild(li);
    }
  }
  cont.appendChild(seccionAuto);

  const seccionExtra = document.createElement("section");
  seccionExtra.className = "compra-seccion";
  seccionExtra.innerHTML = `<h3 class="compra-seccion-titulo">Añadidos a mano (${compraDoc.extras.length})</h3><ul class="compra-lista"></ul>`;
  const ulExtra = seccionExtra.querySelector("ul");
  if (compraDoc.extras.length === 0) {
    ulExtra.innerHTML = `<li class="hint" style="box-shadow:none;background:none;border:none;">Nada añadido a mano todavía.</li>`;
  }
  for (const extra of compraDoc.extras) {
    const li = document.createElement("li");
    li.className = extra.comprado ? "comprado" : "";
    li.innerHTML = `
      <input type="checkbox" ${extra.comprado ? "checked" : ""} />
      <div class="compra-item-info">
        <div class="compra-item-nombre">${extra.nombre}</div>
        <div class="compra-item-nota">${[extra.cantidad, extra.unidad].filter(Boolean).join(" ")}</div>
      </div>
      <button type="button" class="btn-remove-row" title="Quitar">×</button>
    `;
    li.querySelector('input[type="checkbox"]').addEventListener("change", (e) => toggleExtraComprado(extra.id, e.target.checked, li));
    li.querySelector(".btn-remove-row").addEventListener("click", () => quitarExtra(extra.id));
    ulExtra.appendChild(li);
  }
  cont.appendChild(seccionExtra);
}

async function toggleMarcadoAuto(clave, marcado, li) {
  compraDoc.marcados[clave] = marcado;
  li.classList.toggle("comprado", marcado);
  await guardarListaCompra(compraSemanaId, compraDoc);
}

async function toggleExtraComprado(id, comprado, li) {
  const extra = compraDoc.extras.find((e) => e.id === id);
  if (extra) extra.comprado = comprado;
  li.classList.toggle("comprado", comprado);
  await guardarListaCompra(compraSemanaId, compraDoc);
}

async function quitarExtra(id) {
  compraDoc.extras = compraDoc.extras.filter((e) => e.id !== id);
  await guardarListaCompra(compraSemanaId, compraDoc);
  renderListaCompra();
}

// ---------- Importar el menú escolar: PDF (se vuelca por semanas) o foto (solo texto) ----------

let semanasPDF = [];

function initEscolarOCR() {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }

  const btn = document.getElementById("btn-importar-foto");
  const input = document.getElementById("escolar-foto");
  btn.addEventListener("click", () => input.click());
  document.getElementById("btn-volcar-semana").addEventListener("click", () => {
    volcarSemanaPDF(Number(document.getElementById("escolar-pdf-select").value));
  });

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    const resultado = document.getElementById("escolar-ocr-resultado");
    try {
      if (file.type === "application/pdf") {
        resultado.hidden = true;
        await leerPDFEscolar(file);
      } else {
        if (!window.Tesseract) {
          showToast("No se pudo cargar el lector de texto.", "error");
          return;
        }
        document.getElementById("escolar-pdf-semanas").hidden = true;
        resultado.hidden = false;
        resultado.textContent = "Leyendo imagen… puede tardar unos segundos.";
        const { data } = await Tesseract.recognize(file, "spa");
        resultado.textContent = data.text.trim() || "No se ha podido leer texto en la imagen.";
        showToast("Foto leída: copia los platos a su día abajo. El volcado automático solo funciona con PDF.", "info");
      }
    } catch (err) {
      resultado.hidden = false;
      resultado.textContent = "No se ha podido leer el archivo: " + err.message;
    }
    input.value = "";
  });
}

async function leerPDFEscolar(file) {
  if (!window.pdfjsLib) {
    showToast("No se pudo cargar el lector de PDF.", "error");
    return;
  }
  const paginas = await extraerPaginasPDF(pdfjsLib, await file.arrayBuffer());
  if (paginas.flat().length === 0) {
    showToast("El PDF no tiene texto (parece un escaneo). Prueba a subirlo como foto.", "error");
    return;
  }
  const { semanas } = parsearMenuEscolar(paginas);
  semanasPDF = semanas;
  if (semanas.length === 0) {
    showToast("No he reconocido la tabla del menú en este PDF; tendrás que rellenarlo a mano.", "error");
    return;
  }

  const select = document.getElementById("escolar-pdf-select");
  const semanaActual = document.getElementById("week-start").value;
  select.innerHTML = semanas.map((s, i) => `<option value="${i}">${etiquetaSemanaPDF(s)}</option>`).join("");
  const coincide = semanas.findIndex((s) => s.lunes === semanaActual);
  select.value = String(coincide >= 0 ? coincide : 0);
  document.getElementById("escolar-pdf-semanas").hidden = false;
  showToast(`He encontrado ${semanas.length} semanas en el PDF. Elige cuál volcar.`, "success");
}

function etiquetaSemanaPDF(semana) {
  if (semana.lunes) {
    const ini = parseISO(semana.lunes);
    const fin = parseISO(sumarDias(semana.lunes, 4));
    const mes = (d) => d.toLocaleDateString("es-ES", { month: "long" });
    return ini.getMonth() === fin.getMonth()
      ? `Semana del ${ini.getDate()} al ${fin.getDate()} de ${mes(fin)}`
      : `Semana del ${ini.getDate()} de ${mes(ini)} al ${fin.getDate()} de ${mes(fin)}`;
  }
  const dias = DIAS_ESCOLAR.map((d) => semana.dias[d]?.diaDelMes).filter(Boolean);
  return `Semana de los días ${dias[0]} a ${dias[dias.length - 1]}`;
}

// Vuelca la semana elegida del PDF en el menú escolar de esa misma semana
// (si el PDF trae mes y año, se cambia el selector de semana a esas fechas).
async function volcarSemanaPDF(indice) {
  const semana = semanasPDF[indice];
  if (!semana) return;

  const inputSemana = document.getElementById("week-start");
  if (semana.lunes && semana.lunes !== inputSemana.value) {
    inputSemana.value = semana.lunes;
    await renderMenuTab();
  }

  const nuevo = {};
  let conPlatos = 0;
  for (const dia of DIAS_ESCOLAR) {
    const d = semana.dias[dia];
    nuevo[dia] = d ? { primero: d.primero, segundo: d.segundo, postre: d.postre } : escolarDiaVacio();
    if (d && (d.primero.nombre || d.segundo.nombre)) conPlatos++;
  }
  aplicarMenuEscolarAlFormulario(nuevo);
  await persistirMenuActual();
  renderMenuGrid();
  document.getElementById("menu-escolar-box").open = true;
  showToast(`Volcados ${conPlatos} días del cole. Revisa nombres e iconos y corrige lo que haga falta.`, "success");
}

// ---------- escáner de código de barras ----------

function initBarcodeScanner() {
  document.getElementById("btn-escanear").addEventListener("click", abrirEscaner);
  document.getElementById("barcode-cancelar").addEventListener("click", cerrarEscaner);
}

async function abrirEscaner() {
  if (!window.Html5Qrcode) {
    showToast("No se pudo cargar el lector de códigos de barras.", "error");
    return;
  }
  document.getElementById("barcode-modal").hidden = false;
  html5QrScanner = new Html5Qrcode("barcode-reader");
  try {
    await html5QrScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 220 },
      onBarcodeDetected,
      () => {}
    );
  } catch (err) {
    showToast("No se pudo acceder a la cámara: " + err.message, "error");
    await cerrarEscaner();
  }
}

async function onBarcodeDetected(decodedText) {
  await cerrarEscaner();
  document.getElementById("inv-codigo").value = decodedText;
  showToast("Código detectado: " + decodedText, "success");
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${decodedText}.json`);
    const data = await res.json();
    if (data.status === 1 && data.product?.product_name) {
      document.getElementById("inv-nombre").value = data.product.product_name;
    } else {
      showToast("Producto no encontrado en Open Food Facts, escribe el nombre a mano.", "info");
    }
  } catch (e) {
    // Sin conexión con el servicio externo: seguimos, el código ya quedó guardado.
  }
}

async function cerrarEscaner() {
  document.getElementById("barcode-modal").hidden = true;
  if (html5QrScanner) {
    try {
      await html5QrScanner.stop();
      html5QrScanner.clear();
    } catch (e) {
      // el escáner ya estaba parado
    }
    html5QrScanner = null;
  }
}

// ---------- arranque ----------

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  buildDiasEspecialesTabla();
  buildMenuEscolarGrid();
  initMenuEscolarPersistence();
  buildFiltroCategoriaChips();
  initWeekStartDefault();
  initFormPlato();
  initFormConfig();
  initGenerarMenu();
  initImprimir();
  initFormInventario();
  initBarcodeScanner();
  initCompra();
  initEscolarOCR();
  initAuth();
});

// Utilidad de un solo uso: pega en la consola del navegador (con sesión
// iniciada) `importarSeed()` para cargar el catálogo de ejemplo de
// data/platos-seed.json. Ver README.
window.importarSeed = async function importarSeed() {
  const res = await fetch("data/platos-seed.json");
  const platos = await res.json();
  for (const plato of platos) await guardarPlato(plato);
  platosCache = await listarPlatos();
  renderPlatosList();
  console.log(`Importados ${platos.length} platos.`);
};

