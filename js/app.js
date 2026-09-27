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
import { SECCIONES, agruparCompra, formatearCantidades } from "./compra.js";
import { desdeSchemaOrg, desdeTexto } from "./recetas.js";
import { RECETAS_PROXY_URL } from "./recetas-config.js";

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
let compraUsos = [];
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
      recetaCompartida();
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

function icono(nombre) {
  return `<svg class="ic"><use href="#i-${nombre}"/></svg>`;
}

const BLOQUE = {
  cole: { icono: icono("cole"), titulo: "Cole" },
  comida: { icono: icono("hoy"), titulo: "Comida" },
  cena: { icono: icono("luna"), titulo: "Cena" },
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
  el.classList.remove("loading");
  el.innerHTML = `<p class="loading">Cargando…</p>`;
  const hoy = new Date();
  const lunes = toISO(mondayOf(hoy));
  const diaKey = diaKeyFromDate(hoy);
  const menu = await obtenerMenuNormalizado(lunes);

  const fechaLegible = hoy.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  const hora = hoy.getHours();
  const saludo = hora < 14 ? "Buenos días" : hora < 21 ? "Buenas tardes" : "Buenas noches";
  const cabecera = `
    <div class="hoy-hero">
      <p class="hoy-saludo">${saludo}</p>
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
    ? `<div class="empty-state"><span class="empty-icono">${icono("calendario")}</span><p>No hay menú de casa generado para hoy. Ve a "Menú" para generarlo.</p></div>`
    : `<h3 class="hoy-recetas-titulo">Recetas de hoy</h3>${recetas.join("")}`);
}

// Cada receta del día es una tarjeta plegable: a la vista solo el plato, y al
// tocarla se despliegan ingredientes y pasos.
function renderRecetaBloque(comida, plato, curso) {
  const etiqueta = `${BLOQUE[comida].titulo}${curso ? ` · ${CURSO_NOMBRE[curso]}` : ""}`;
  if (!plato) return `<div class="receta-card"><p class="comida-label" style="padding:1rem">${etiqueta}: plato no encontrado.</p></div>`;
  const ingredientes = (plato.ingredientes || []).map((i) => `<li>${escapeHTML(formatearIngrediente(i))}</li>`).join("");
  const pasos = (plato.pasos || []).map((p) => `<li>${escapeHTML(p)}</li>`).join("");
  return `
    <details class="receta-card">
      <summary>
        <div class="receta-resumen">
          <p class="comida-label">${etiqueta}</p>
          <h3>${CATEGORIA_ICONO[plato.categoria] || ""} ${escapeHTML(plato.nombre)}</h3>
        </div>
      </summary>
      <div class="receta-cuerpo">
        ${ingredientes ? `<h4>Ingredientes</h4><ul class="ingredientes-chips">${ingredientes}</ul>` : ""}
        ${pasos ? `<h4>Preparación</h4><ol class="receta-pasos">${pasos}</ol>` : ""}
        ${!ingredientes && !pasos ? `<p class="hint">Este plato aún no tiene receta.</p>` : ""}
        ${plato.fuente ? `<p><a href="${escapeHTML(plato.fuente)}" target="_blank" rel="noopener">Ver receta original ↗</a></p>` : ""}
      </div>
    </details>
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
      fuente: document.getElementById("plato-fuente").value,
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
  document.getElementById("plato-fuente").value = "";
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
    contenedor.innerHTML = `<div class="empty-state"><span class="empty-icono">${icono("buscar")}</span><p>No hay platos que coincidan.</p></div>`;
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
          <button data-action="favorito" class="${plato.favorito ? "fav-activo" : ""}" title="${plato.favorito ? "Quitar de favoritos" : "Marcar como favorito"}">${icono("estrella")}</button>
          <button data-action="editar" title="Editar">${icono("lapiz")}</button>
          <button data-action="borrar" title="Borrar">${icono("papelera")}</button>
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
  document.getElementById("plato-fuente").value = plato.fuente || "";
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
    <input type="number" class="regla-min" placeholder="Mín" title="Mínimo por semana" min="0" max="14" value="${regla.minPorSemana ?? ""}" />
    <input type="number" class="regla-max" placeholder="Máx" title="Máximo por semana" min="0" max="14" value="${regla.maxPorSemana ?? ""}" />
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

// El icono visible (a la izquierda del nombre) refleja siempre la categoría
// elegida en el <select> oculto tras él; tocar el icono abre ese desplegable.
function sincronizarIconoEscolar(select) {
  const emoji = select.closest(".icono-cat")?.querySelector(".icono-cat-emoji");
  if (emoji) emoji.textContent = CATEGORIA_ICONO[select.value] || "❔";
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
        <label class="icono-cat" title="Cambiar categoría">
          <span class="icono-cat-emoji">❔</span>
          <select class="escolar-cat" data-dia="${dia}" data-tipo="${tipo}" aria-label="Categoría">${opcionesCategoriaEscolar(tipo)}</select>
        </label>
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
        sincronizarIconoEscolar(cat);
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
    if (el.classList.contains("escolar-cat")) {
      el.dataset.manual = "1";
      sincronizarIconoEscolar(el);
    }
    // Al escribir el nombre se deduce el icono, salvo que se haya elegido a mano.
    if (el.classList.contains("escolar-nombre")) {
      const cat = campoEscolar(el.dataset.dia, el.dataset.tipo, "escolar-cat");
      if (cat && cat.dataset.manual !== "1") {
        cat.value = el.dataset.tipo === "postre" ? categorizarPostre(el.value) : categorizarPlato(el.value);
        sincronizarIconoEscolar(cat);
      }
    }
    await persistirMenuActual();
    renderMenuGrid();
  });
}

// ---------- pestaña "Menú semanal": calendario ----------

// ---------- navegador de semanas (compartido por Menú y Compra) ----------

function semanaSeleccionada() {
  return document.getElementById("week-start").value || toISO(mondayOf(new Date()));
}

function etiquetaSemana(lunes) {
  const ini = parseISO(lunes);
  const fin = parseISO(sumarDias(lunes, 6));
  const mes = (d) => d.toLocaleDateString("es-ES", { month: "long" });
  const texto = ini.getMonth() === fin.getMonth()
    ? `${ini.getDate()} – ${fin.getDate()} de ${mes(fin)}`
    : `${ini.getDate()} de ${mes(ini)} – ${fin.getDate()} de ${mes(fin)}`;
  return texto;
}

// Cualquier fecha se lleva al lunes de su semana; se actualizan los dos
// selectores y se recarga la pestaña que esté a la vista.
function cambiarSemana(fechaISO, recargar = true) {
  const lunes = toISO(mondayOf(parseISO(fechaISO)));
  for (const id of ["week-start", "compra-week-start"]) document.getElementById(id).value = lunes;
  document.querySelectorAll(".semana-etiqueta").forEach((el) => (el.textContent = etiquetaSemana(lunes)));
  // "Esta semana" solo hace falta cuando se está viendo otra semana.
  const esActual = lunes === toISO(mondayOf(new Date()));
  document.querySelectorAll('.semana-nav [data-mover="0"]').forEach((b) => (b.hidden = esActual));
  diaMenuActivo = null;
  if (!recargar) return;
  if (!document.getElementById("tab-menu").hidden) renderMenuTab();
  if (!document.getElementById("tab-compra").hidden) recalcularCompra();
}

function initNavegadorSemanas() {
  cambiarSemana(toISO(new Date()), false);
  document.querySelectorAll(".semana-nav").forEach((nav) => {
    nav.querySelector('input[type="date"]').addEventListener("change", (e) => cambiarSemana(e.target.value || toISO(new Date())));
    nav.querySelectorAll("[data-mover]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mover = Number(btn.dataset.mover);
        cambiarSemana(mover === 0 ? toISO(new Date()) : sumarDias(semanaSeleccionada(), 7 * mover));
      });
    });
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

// ---------- Menú en el móvil: un día cada vez ----------
// En pantallas estrechas la rejilla muestra solo el día elegido en la tira
// de días (L M X J V S D), y se cambia de día deslizando a los lados. En el
// ordenador se ve la semana entera (la tira y el filtro se ocultan por CSS).

let diaMenuActivo = null;

const INICIAL_DIA = { lunes: "L", martes: "M", miercoles: "X", jueves: "J", viernes: "V", sabado: "S", domingo: "D" };

function diaInicialMenu() {
  const semanaId = document.getElementById("week-start").value;
  const hoy = toISO(new Date());
  const indice = DIAS.findIndex((_, i) => sumarDias(semanaId, i) === hoy);
  return indice >= 0 ? DIAS[indice] : "lunes";
}

function renderTiraDias() {
  const tira = document.getElementById("menu-dias-tira");
  const grid = document.getElementById("menu-grid");
  const semanaId = document.getElementById("week-start").value;
  if (!diaMenuActivo) diaMenuActivo = diaInicialMenu();
  const hoy = toISO(new Date());
  tira.innerHTML = DIAS.map((dia, i) => {
    const fecha = sumarDias(semanaId, i);
    const clases = ["dia-chip", dia === diaMenuActivo ? "activo" : "", fecha === hoy ? "hoy" : ""].join(" ");
    return `<button type="button" class="${clases}" data-dia="${dia}">${INICIAL_DIA[dia]}<b>${parseISO(fecha).getDate()}</b></button>`;
  }).join("");
  grid.dataset.diaActivo = diaMenuActivo;
  tira.querySelectorAll(".dia-chip").forEach((btn) => btn.addEventListener("click", () => elegirDiaMenu(btn.dataset.dia)));
}

function elegirDiaMenu(dia) {
  diaMenuActivo = dia;
  renderTiraDias();
}

function initDeslizarDias() {
  const grid = document.getElementById("menu-grid");
  let inicioX = null;
  let inicioY = null;
  grid.addEventListener("touchstart", (e) => {
    inicioX = e.touches[0].clientX;
    inicioY = e.touches[0].clientY;
  }, { passive: true });
  grid.addEventListener("touchend", (e) => {
    if (inicioX === null) return;
    const dx = e.changedTouches[0].clientX - inicioX;
    const dy = e.changedTouches[0].clientY - inicioY;
    inicioX = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const i = DIAS.indexOf(diaMenuActivo);
    const siguiente = DIAS[Math.min(DIAS.length - 1, Math.max(0, i + (dx < 0 ? 1 : -1)))];
    if (siguiente !== diaMenuActivo) elegirDiaMenu(siguiente);
  }, { passive: true });
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
        <select class="select-intercambiar" data-dia="${dia}"><option value="">Cambiar día…</option>${opcionesIntercambio}</select>
      </div>
      ${cole}
      ${bloqueCasaHTML(dia, "comida", menuActualDias?.[dia]?.comida, true)}
      ${bloqueCasaHTML(dia, "cena", menuActualDias?.[dia]?.cena, true)}
    `;
  }).join("");

  grid.innerHTML = cabecera + filas;

  // Cada día ocupa 4 celdas (día, cole, comida, cena) tras las 4 de cabecera;
  // se marcan con su día para poder mostrar un solo día en el móvil.
  [...grid.children].slice(4).forEach((celda, i) => (celda.dataset.dia = DIAS[Math.floor(i / 4)]));
  renderTiraDias();

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
    contenedor.innerHTML = `<div class="empty-state"><span class="empty-icono">${icono("nevera")}</span><p>${inventarioCache.length === 0 ? "El inventario está vacío." : "No hay productos que coincidan."}</p></div>`;
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
          <button data-action="editar" title="Editar">${icono("lapiz")}</button>
          <button data-action="borrar" title="Borrar">${icono("papelera")}</button>
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

// Ingredientes de todos los platos del menú de esa semana (uno por cada vez
// que aparecen); agruparCompra() los junta por alimento y suma cantidades.
function usosDelMenu(diasMenu) {
  const usos = [];
  for (const dia of DIAS) {
    for (const comida of COMIDAS) {
      for (const platoId of idsDeComida(diasMenu?.[dia]?.[comida])) {
        const plato = platosCache.find((p) => p.id === platoId);
        if (!plato) continue;
        for (const ingRaw of plato.ingredientes || []) {
          const ing = normalizarIngrediente(ingRaw);
          if (!ing.nombre) continue;
          usos.push({
            alimentoId: typeof ingRaw === "object" ? ingRaw.alimentoId : null,
            nombre: ing.nombre,
            cantidad: ing.cantidad,
            unidad: ing.unidad,
            plato: plato.nombre,
          });
        }
      }
    }
  }
  return usos;
}

function initCompra() {
  document.getElementById("btn-recalcular-compra").addEventListener("click", recalcularCompra);

  document.getElementById("form-extra-compra").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombreTexto = document.getElementById("extra-nombre").value.trim();
    if (!nombreTexto) return;
    const alimento = await resolverAlimento(nombreTexto);
    const cantidadTexto = document.getElementById("extra-cantidad").value;
    compraDoc.extras.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      alimentoId: alimento?.id || null,
      nombre: alimento?.nombre || nombreTexto,
      cantidad: cantidadTexto ? Number(cantidadTexto) : null,
      unidad: document.getElementById("extra-unidad").value.trim(),
    });
    guardarListaCompra(compraSemanaId, compraDoc);
    document.getElementById("form-extra-compra").reset();
    renderListaCompra();
    buildAlimentosConocidos();
  });
}

async function recalcularCompra() {
  const semanaId = semanaSeleccionada();
  compraSemanaId = semanaId;
  const menu = await obtenerMenuNormalizado(semanaId);
  compraUsos = usosDelMenu(menu?.dias || diasVacios());
  const guardado = (await obtenerListaCompra(semanaId)) || (await obtenerListaCompra(sumarDias(semanaId, -1)));
  compraDoc = { marcados: {}, extras: [], ...guardado };
  renderListaCompra();
}

function notaEntrada(e) {
  const partes = [];
  const comprar = formatearCantidades(e.aComprar);
  const tengo = formatearCantidades(e.disponible);
  if (e.cubierto) partes.push(`ya tienes suficiente (${tengo})`);
  else {
    if (comprar) partes.push(`<strong>${comprar}</strong>`);
    if (e.sinCantidad) partes.push(comprar ? "+ cantidad sin indicar" : "cantidad sin indicar");
    if (tengo) partes.push(`(tienes ${tengo} en casa)`);
  }
  return partes.join(" ");
}

function renderListaCompra() {
  const cont = document.getElementById("lista-compra-contenido");
  if (!cont) return;
  const entradas = agruparCompra(compraUsos, compraDoc.extras, inventarioCache, alimentosCache);
  for (const e of entradas) if (!SECCIONES.some((s) => s.id === e.seccion)) e.seccion = "otros";

  if (entradas.length === 0) {
    cont.innerHTML = `<div class="empty-state"><span class="empty-icono">${icono("carrito")}</span><p>No hay nada que comprar: no hay menú esta semana o sus platos no tienen ingredientes.</p></div>`;
    return;
  }

  const hecho = (e) => e.cubierto || !!compraDoc.marcados[e.clave];
  const listos = entradas.filter(hecho).length;
  const porcentaje = Math.round((listos / entradas.length) * 100);
  const opcionesSeccion = SECCIONES.map((s) => `<option value="${s.id}">${s.icono} ${s.nombre}</option>`).join("");
  let html = `
    <p class="compra-resumen"><span><strong>${listos}</strong> de ${entradas.length} listos</span><span>${entradas.length - listos} por comprar</span></p>
    <div class="compra-progreso"><span style="width:${porcentaje}%"></span></div>`;

  for (const seccion of SECCIONES) {
    const items = entradas
      .filter((e) => e.seccion === seccion.id)
      .sort((a, b) => Number(hecho(a)) - Number(hecho(b)) || a.nombre.localeCompare(b.nombre, "es"));
    if (!items.length) continue;
    html += `<section class="compra-seccion"><h3 class="compra-seccion-titulo">${seccion.icono} ${seccion.nombre} <span class="hint">(${items.length})</span></h3><ul class="compra-lista">`;
    for (const e of items) {
      const marcado = !!compraDoc.marcados[e.clave];
      const extras = e.extras
        .map((x) => `<span class="compra-extra">a mano: ${escapeHTML([x.cantidad, x.unidad].filter((v) => v != null && v !== "").join(" ") || "sin cantidad")}<button type="button" class="btn-quitar-plato" data-extra="${x.id}" title="Quitar">×</button></span>`)
        .join("");
      html += `
        <li class="${marcado ? "comprado" : ""} ${e.cubierto ? "cubierto" : ""}" data-clave="${escapeHTML(e.clave)}">
          <input type="checkbox" ${marcado ? "checked" : ""} />
          <div class="compra-item-info">
            <div class="compra-item-nombre">${escapeHTML(e.nombre)}</div>
            <div class="compra-item-nota">${notaEntrada(e)}</div>
            ${e.platos.length ? `<div class="compra-item-platos">para: ${escapeHTML(e.platos.join(", "))}</div>` : ""}
            ${extras}
          </div>
          <select class="select-seccion" title="Mover a otra sección">${opcionesSeccion}</select>
        </li>`;
    }
    html += `</ul></section>`;
  }
  cont.innerHTML = html;

  cont.querySelectorAll("li[data-clave]").forEach((li) => {
    const entrada = entradas.find((e) => e.clave === li.dataset.clave);
    const select = li.querySelector(".select-seccion");
    select.value = entrada.seccion;
    select.addEventListener("change", () => cambiarSeccion(entrada, select.value));
    li.querySelector('input[type="checkbox"]').addEventListener("change", (ev) => {
      compraDoc.marcados[entrada.clave] = ev.target.checked;
      li.classList.toggle("comprado", ev.target.checked);
      guardarListaCompra(compraSemanaId, compraDoc);
      // Breve pausa para que se vea el check antes de que baje al final.
      setTimeout(renderListaCompra, 350);
    });
  });
  cont.querySelectorAll("[data-extra]").forEach((btn) => {
    btn.addEventListener("click", () => {
      compraDoc.extras = compraDoc.extras.filter((x) => x.id !== btn.dataset.extra);
      guardarListaCompra(compraSemanaId, compraDoc);
      renderListaCompra();
    });
  });
}

// La sección se guarda en el alimento, así la próxima vez ya sale bien.
async function cambiarSeccion(entrada, seccion) {
  let alimento = entrada.alimentoId && alimentosCache.find((a) => a.id === entrada.alimentoId);
  if (!alimento) alimento = await resolverAlimento(entrada.nombre);
  if (!alimento) return;
  alimento.seccion = seccion;
  guardarAlimento({ id: alimento.id, seccion });
  renderListaCompra();
}


// ---------- Importar el menú escolar: PDF (se guardan todas sus semanas) o foto (solo texto) ----------

function initEscolarOCR() {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }

  const btn = document.getElementById("btn-importar-foto");
  const input = document.getElementById("escolar-foto");
  btn.addEventListener("click", () => input.click());

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    const resultado = document.getElementById("escolar-ocr-resultado");
    try {
      if (file.type === "application/pdf") {
        resultado.hidden = true;
        await importarPDFEscolar(file);
      } else {
        if (!window.Tesseract) {
          showToast("No se pudo cargar el lector de texto.", "error");
          return;
        }
        resultado.hidden = false;
        resultado.textContent = "Leyendo imagen… puede tardar unos segundos.";
        const { data } = await Tesseract.recognize(file, "spa");
        resultado.textContent = data.text.trim() || "No se ha podido leer texto en la imagen.";
        showToast("Foto leída: copia los platos a su día abajo. El volcado automático solo funciona con PDF.", "info");
      }
    } catch (err) {
      resultado.hidden = false;
      resultado.textContent = "No se ha podido leer el archivo: " + (err?.message || err);
    }
    input.value = "";
  });
}

// Guarda el menú del cole de todas las semanas del PDF (cada una en su
// semana), conservando la comida y la cena de casa que ya hubiera.
async function importarPDFEscolar(file) {
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
  const conFecha = semanas.filter((s) => s.lunes);
  if (semanas.length === 0) {
    showToast("No he reconocido la tabla del menú en este PDF; tendrás que rellenarlo a mano.", "error");
    return;
  }
  if (conFecha.length === 0) {
    showToast("No encuentro el mes y el año en el PDF, así que no sé a qué semanas corresponde. Rellénalo a mano.", "error");
    return;
  }

  const existentes = await Promise.all(conFecha.map((s) => obtenerMenuNormalizado(s.lunes)));
  const yaHabiaCole = existentes.some((m) => DIAS_ESCOLAR.some((d) => normalizarEscolarDia(m?.menuEscolar?.[d]).primero.nombre));
  if (yaHabiaCole) {
    const ok = await confirmDialog("Algunas de estas semanas ya tenían menú del cole. Se sustituirá por el del PDF (la comida y la cena de casa no se tocan). ¿Continuar?");
    if (!ok) return;
  }

  conFecha.forEach((semana, i) => {
    const menuEscolar = {};
    for (const dia of DIAS_ESCOLAR) {
      const d = semana.dias[dia];
      menuEscolar[dia] = d ? { primero: d.primero, segundo: d.segundo, postre: d.postre } : escolarDiaVacio();
    }
    guardarMenu(semana.lunes, { dias: existentes[i]?.dias || diasVacios(), menuEscolar });
  });

  const actual = semanaSeleccionada();
  const destino = conFecha.some((s) => s.lunes === actual) ? actual : conFecha[0].lunes;
  menuActualDias = null;
  cambiarSemana(destino);
  document.getElementById("menu-escolar-box").open = true;

  const primera = conFecha[0].lunes;
  const ultima = conFecha[conFecha.length - 1].lunes;
  const fmt = (iso, n) => parseISO(sumarDias(iso, n)).toLocaleDateString("es-ES", { day: "numeric", month: "long" });
  const sinFecha = semanas.length - conFecha.length;
  showToast(
    `Guardado el menú del cole de ${conFecha.length} semanas (del ${fmt(primera, 0)} al ${fmt(ultima, 4)}). Muévete con ◀ ▶ para revisarlas.` +
      (sinFecha ? ` ${sinFecha} semana(s) sin fecha no se han podido guardar.` : ""),
    "success"
  );
}


// ---------- escáner de código de barras ----------

// ---------- reconocer alimentos con foto (Gemini a través del Worker) ----------

function initFotoAlimentos() {
  const input = document.getElementById("foto-alimento-input");
  document.getElementById("btn-foto-alimento").addEventListener("click", () => {
    if (!RECETAS_PROXY_URL) {
      showToast("Falta configurar el Worker de Cloudflare (js/recetas-config.js).", "error");
      return;
    }
    input.value = "";
    input.click();
  });
  input.addEventListener("change", () => {
    if (input.files?.[0]) reconocerFoto(input.files[0]);
  });
  document.getElementById("foto-cancelar").addEventListener("click", cerrarFotoModal);
  document.getElementById("foto-guardar").addEventListener("click", guardarAlimentosDeFoto);
}

function cerrarFotoModal() {
  document.getElementById("foto-modal").hidden = true;
  document.getElementById("foto-resultados").innerHTML = "";
}

// Reduce la foto a 1024 px de lado mayor en JPEG: basta para reconocer y
// viaja mucho más rápido que la original del móvil.
async function fotoEnBase64(archivo, lado = 1024) {
  const bitmap = await createImageBitmap(archivo);
  const escala = Math.min(1, lado / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * escala);
  canvas.height = Math.round(bitmap.height * escala);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
}

async function reconocerFoto(archivo) {
  const estado = document.getElementById("foto-estado");
  const resultados = document.getElementById("foto-resultados");
  const guardar = document.getElementById("foto-guardar");
  resultados.innerHTML = "";
  guardar.disabled = true;
  document.getElementById("foto-ubicacion-fila").hidden = true;
  estado.textContent = "Reconociendo alimentos…";
  document.getElementById("foto-modal").hidden = false;

  let alimentos;
  try {
    const imagen = await fotoEnBase64(archivo);
    const res = await fetch(new URL("reconocer", RECETAS_PROXY_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imagen, conocidos: alimentosCache.map((a) => a.nombre) }),
    });
    const datos = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(datos.error || `error ${res.status}`);
    alimentos = datos.alimentos || [];
  } catch (e) {
    estado.textContent = `No se ha podido reconocer la foto: ${e.message}`;
    return;
  }

  if (!alimentos.length) {
    estado.textContent = "No he encontrado alimentos en la foto. Prueba con más luz o más cerca.";
    return;
  }
  estado.textContent = "Revisa lo reconocido: corrige lo que haga falta y desmarca lo que no quieras añadir.";
  resultados.innerHTML = alimentos
    .map(
      (a) => `
      <div class="foto-fila">
        <input type="checkbox" checked aria-label="Añadir" />
        <input type="text" class="foto-nombre" list="alimentos-conocidos" value="${escapeHTML(a.nombre)}" />
        <input type="number" class="foto-cantidad" min="0" step="0.1" placeholder="Cant." value="${a.cantidad ?? ""}" />
        <input type="text" class="foto-unidad" placeholder="ud" value="${escapeHTML(a.unidad || "")}" />
      </div>`
    )
    .join("");
  document.getElementById("foto-ubicacion-fila").hidden = false;
  guardar.disabled = false;
}

async function guardarAlimentosDeFoto() {
  const filas = [...document.querySelectorAll("#foto-resultados .foto-fila")]
    .filter((f) => f.querySelector('input[type="checkbox"]').checked)
    .map((f) => ({
      nombre: f.querySelector(".foto-nombre").value.trim(),
      cantidad: f.querySelector(".foto-cantidad").value ? Number(f.querySelector(".foto-cantidad").value) : null,
      unidad: f.querySelector(".foto-unidad").value.trim(),
    }))
    .filter((f) => f.nombre);
  const ubicacion = document.getElementById("foto-ubicacion").value;
  cerrarFotoModal();
  if (!filas.length) return;

  const nombres = [];
  for (const fila of filas) {
    const alimento = await resolverAlimento(fila.nombre);
    if (!alimento) continue;
    // Si ya hay ese alimento en el mismo sitio y con la misma unidad, suma la cantidad.
    const existente = inventarioCache.find(
      (i) => i.alimentoId === alimento.id && i.ubicacion === ubicacion && (i.unidad || "") === fila.unidad
    );
    const item = existente
      ? {
          ...existente,
          cantidad: fila.cantidad == null ? existente.cantidad : (existente.cantidad || 0) + fila.cantidad,
          actualizado: toISO(new Date()),
        }
      : {
          id: null,
          alimentoId: alimento.id,
          nombre: alimento.nombre,
          cantidad: fila.cantidad,
          unidad: fila.unidad,
          ubicacion,
          detalle: "",
          codigoBarras: null,
          actualizado: toISO(new Date()),
        };
    await guardarItemInventario(item);
    nombres.push(alimento.nombre);
  }
  inventarioCache = await listarInventario();
  renderInventarioList();
  buildAlimentosConocidos();
  if (nombres.length) showToast(`Añadido al inventario: ${nombres.join(", ")}.`, "success");
}

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
  const F = window.Html5QrcodeSupportedFormats;
  html5QrScanner = new Html5Qrcode("barcode-reader", {
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128],
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    verbose: false,
  });
  try {
    await html5QrScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: (ancho, alto) => ({ width: Math.floor(ancho * 0.85), height: Math.floor(Math.min(alto, ancho) * 0.45) }) },
      onBarcodeDetected,
      () => {}
    );
  } catch (err) {
    const motivo = String(err?.message || err);
    const texto = /NotAllowed|Permission/i.test(motivo)
      ? "No hay permiso para usar la cámara. Actívalo en los ajustes del sitio (candado junto a la dirección) y vuelve a intentarlo."
      : "No se pudo abrir la cámara: " + motivo;
    showToast(texto, "error");
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

// ---------- importar recetas (web o texto pegado) ----------

function initImportarReceta() {
  document.getElementById("btn-importar-url").addEventListener("click", () => importarRecetaURL(document.getElementById("importar-url").value));
  document.getElementById("importar-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") importarRecetaURL(e.target.value);
  });
  document.getElementById("btn-importar-texto").addEventListener("click", () => {
    const plato = desdeTexto(document.getElementById("importar-texto").value);
    if (!plato || !plato.nombre) {
      showToast("No he encontrado una receta en ese texto.", "error");
      return;
    }
    rellenarFormularioConReceta(plato);
    document.getElementById("importar-texto").value = "";
  });
}

async function importarRecetaURL(texto) {
  const url = (String(texto).match(/https?:\/\/\S+/) || [])[0];
  if (!url) {
    showToast("Pega el enlace completo de la receta (empieza por https://).", "error");
    return;
  }
  if (!RECETAS_PROXY_URL) {
    showToast("Falta configurar el intermediario de recetas (README → «Importar recetas de webs»). Mientras, usa «Pegar texto».", "error");
    return;
  }
  const btn = document.getElementById("btn-importar-url");
  btn.disabled = true;
  btn.textContent = "Importando…";
  try {
    const res = await fetch(`${RECETAS_PROXY_URL}?url=${encodeURIComponent(url)}`);
    const datos = await res.json().catch(() => ({}));
    if (!res.ok || !datos.receta) throw new Error(datos.error || `error ${res.status}`);
    rellenarFormularioConReceta(desdeSchemaOrg(datos.receta, datos.url || url));
    document.getElementById("importar-url").value = "";
  } catch (err) {
    showToast("No se ha podido importar: " + (err?.message || err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Importar";
  }
}

// Rellena el formulario de plato nuevo con la receta importada; se revisa y
// se guarda como cualquier otro (los ingredientes pasan por el catálogo de
// alimentos al guardar).
function rellenarFormularioConReceta(plato) {
  resetFormPlato();
  document.getElementById("plato-nombre").value = plato.nombre;
  document.getElementById("plato-categoria").value = plato.categoria;
  document.getElementById("plato-curso").value = plato.curso;
  document.getElementById("plato-tiempo").value = plato.tiempoPrep;
  document.getElementById("plato-fuente").value = plato.fuente || "";
  resetIngredientes(plato.ingredientes);
  resetPasos(plato.pasos);
  document.getElementById("btn-cancelar-edicion").hidden = false;
  document.getElementById("importar-receta").open = false;
  document.getElementById("plato-nombre").scrollIntoView({ behavior: "smooth", block: "center" });
  showToast(`Receta cargada: ${plato.ingredientes.length} ingredientes y ${plato.pasos.length} pasos. Revísala y pulsa «Guardar plato».`, "success");
}

// Al compartir una página con Fame desde el móvil (Compartir → Fame), la app
// se abre con el enlace en la dirección; se importa en cuanto hay sesión.
function recetaCompartida() {
  const params = new URLSearchParams(location.search);
  const texto = [params.get("url"), params.get("text"), params.get("title")].filter(Boolean).join(" ");
  const url = (texto.match(/https?:\/\/\S+/) || [])[0];
  if (!url) return;
  history.replaceState(null, "", location.pathname);
  document.querySelector('[data-tab="platos"]').click();
  importarRecetaURL(url);
}

// ---------- PWA: service worker e instalación ----------

function initPWA() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service worker no registrado:", err));
  }

  // Chrome/Edge/Android avisan de que la app se puede instalar; en iPhone no
  // existe este evento y se instala con Compartir → Añadir a pantalla de inicio.
  const btn = document.getElementById("btn-instalar");
  let aviso = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    aviso = e;
    btn.hidden = false;
  });
  btn.addEventListener("click", async () => {
    if (!aviso) return;
    aviso.prompt();
    await aviso.userChoice;
    aviso = null;
    btn.hidden = true;
  });
  window.addEventListener("appinstalled", () => (btn.hidden = true));
}

// ---------- arranque ----------

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  buildDiasEspecialesTabla();
  buildMenuEscolarGrid();
  initMenuEscolarPersistence();
  buildFiltroCategoriaChips();
  initNavegadorSemanas();
  initDeslizarDias();
  initFormPlato();
  initFormConfig();
  initGenerarMenu();
  initImprimir();
  initFormInventario();
  initBarcodeScanner();
  initFotoAlimentos();
  initCompra();
  initEscolarOCR();
  initPWA();
  initImportarReceta();
  window.addEventListener("fame:error-guardado", (e) => {
    console.error(e.detail);
    showToast("No se ha podido guardar un cambio en el servidor: " + (e.detail?.message || e.detail), "error");
  });
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

// ---------- Tema claro / oscuro ----------
function temaActual() {
  const forzado = document.documentElement.dataset.theme;
  if (forzado) return forzado;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function pintarBotonTema() {
  const oscuro = temaActual() === "dark";
  document.documentElement.classList.toggle("tema-oscuro", oscuro);
  const btn = document.getElementById("btn-tema");
  if (btn) btn.title = oscuro ? "Cambiar a modo claro" : "Cambiar a modo oscuro";
}

function initTema() {
  pintarBotonTema();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", pintarBotonTema);
  document.getElementById("btn-tema")?.addEventListener("click", () => {
    const nuevo = temaActual() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nuevo;
    try { localStorage.setItem("fame-tema", nuevo); } catch (e) {}
    pintarBotonTema();
  });
}

initTema();
