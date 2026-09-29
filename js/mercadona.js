// Catálogo de la tienda online de Mercadona (a través del Worker de
// Cloudflare): se descarga una vez por semana y se guarda en el móvil. Aquí
// solo hay funciones puras y la caché local; la interfaz está en app.js.

import { claveNombre, formatearCantidades } from "./compra.js";

const CLAVE_CACHE = "fame-mercadona-v1";
const VIGENCIA_MS = 7 * 24 * 3600 * 1000;
const CATEGORIAS_POR_LLAMADA = 8; // poco trabajo por llamada: el plan gratuito de Workers da 10 ms de CPU

// Qué categorías de Mercadona encajan con cada sección de la lista de la compra.
const CATEGORIAS_POR_SECCION = {
  fruta: ["Fruta y verdura"],
  verdura: ["Fruta y verdura"],
  carne: ["Carne"],
  pescado: ["Marisco y pescado"],
  "huevos-lacteos": ["Huevos, leche y mantequilla", "Postres y yogures", "Charcutería y quesos"],
  legumbres: ["Arroz, legumbres y pasta", "Conservas, caldos y cremas"],
  "pasta-arroz": ["Arroz, legumbres y pasta", "Cereales y galletas"],
  panaderia: ["Panadería y pastelería"],
  despensa: ["Aceite, especias y salsas", "Conservas, caldos y cremas", "Azúcar, caramelos y chocolate", "Cacao, café e infusiones"],
  congelados: ["Congelados"],
  bebidas: ["Agua y refrescos", "Zumos", "Bodega"],
  hogar: ["Limpieza y hogar", "Cuidado facial y corporal", "Cuidado del cabello"],
};
// Palabras de productos elaborados: si no se buscan, se prefieren los frescos
// ("merluza" -> lomos de merluza antes que merluza rebozada).
const ELABORADOS = ["elaborad", "rebozad", "empanad", "romana", "varita", "palito", "figurita", "ahumad", "marinad", "crema", "pure", "smoothie", "salsa", "sopa", "papilla", "precocinad", "frit", "zumo", "caldo", "gazpacho", "tortilla", "croqueta", "pizza", "snack", "chip"];
// Palabras que no cuentan como "de más": cortes y enlaces ("Filete de salmón"
// es tan salmón como "Salmón").
const NEUTRAS = new Set(["filete", "lomo", "porcion", "rodaja", "escalopin", "medallon", "centro", "trozo", "pieza", "de", "del", "la", "el", "lo", "con", "sin", "y", "al", "a", "en", "piel"]);
// Categorías que casi nunca son lo que se busca para cocinar.
const CATEGORIAS_AJENAS = ["Bebé", "Mascotas", "Maquillaje", "Cuidado facial y corporal", "Cuidado del cabello", "Fitoterapia y parafarmacia"];

export const urlProducto = (p) => `https://tienda.mercadona.es/product/${p.id}/${p.sl || ""}`;
export const urlFoto = (p, lado = 120) =>
  p.img ? `https://prod-mercadona.imgix.net/images/${p.img}?fit=crop&h=${lado}&w=${lado}` : "";
export const euros = (n) => (n == null ? "" : n.toLocaleString("es-ES", { style: "currency", currency: "EUR" }));

function tamano(p) {
  if (p.s == null) return "";
  const n = (x) => Math.round(x * 1000) / 1000;
  if (p.u === "kg") return p.s < 1 ? `${n(p.s * 1000)} g` : `${n(p.s).toLocaleString("es-ES")} kg`;
  if (p.u === "l") return p.s < 1 ? `${n(p.s * 1000)} ml` : `${n(p.s).toLocaleString("es-ES")} l`;
  if (p.u === "ud") return `${n(p.s)} ud`;
  return `${n(p.s)} ${p.u}`;
}

// "Paquete 1 kg", "Pieza ~160 g"
export function formatoProducto(p) {
  return [p.pk, (p.ap ? "~" : "") + tamano(p)].filter(Boolean).join(" ");
}

// "1,85 €/kg"
export function precioReferencia(p) {
  return p.r ? `${euros(p.r)}/${(p.rf || "").toLowerCase()}` : "";
}

// ---------- descarga y caché ----------

function leerCache() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_CACHE) || "null");
  } catch (e) {
    return null;
  }
}

function prepararIndice(productos) {
  for (const p of productos) p.k = claveNombre(p.n).split(" ");
  return productos;
}

async function pedirJSON(url) {
  const res = await fetch(url);
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(datos.error || `error ${res.status}`);
  return datos;
}

// Almacén de Mercadona que reparte en ese código postal (los precios dependen de él).
export async function almacenDeCodigoPostal(proxyUrl, cp) {
  const { wh } = await pedirJSON(new URL(`mercadona/almacen?cp=${encodeURIComponent(cp)}`, proxyUrl));
  return wh;
}

/**
 * Devuelve { productos, fecha } del almacén indicado, desde la caché del
 * móvil si tiene menos de una semana o descargándolo si no (o si se fuerza).
 */
export async function cargarCatalogo(proxyUrl, wh, { forzar = false } = {}) {
  const cache = leerCache();
  if (!forzar && cache?.wh === wh && Date.now() - cache.fecha < VIGENCIA_MS && cache.productos?.length) {
    return { productos: prepararIndice(cache.productos), fecha: cache.fecha };
  }

  const { ids } = await pedirJSON(new URL(`mercadona/categorias?wh=${wh}`, proxyUrl));
  const pedirLote = (lote) => pedirJSON(new URL(`mercadona/productos?wh=${wh}&ids=${lote.join(",")}`, proxyUrl));
  const lotes = [];
  for (let i = 0; i < ids.length; i += CATEGORIAS_POR_LLAMADA) lotes.push(ids.slice(i, i + CATEGORIAS_POR_LLAMADA));

  const porId = new Map();
  let pendientes = [];
  for (let i = 0; i < lotes.length; i += 3) {
    const respuestas = await Promise.all(lotes.slice(i, i + 3).map(pedirLote));
    for (const r of respuestas) {
      for (const p of r.productos) porId.set(p.id, p);
      pendientes.push(...(r.fallidas || []));
    }
  }
  // Las categorías que no llegaron se piden otra vez, una sola.
  if (pendientes.length) {
    const r = await pedirLote(pendientes).catch(() => ({ productos: [] }));
    for (const p of r.productos) porId.set(p.id, p);
  }

  const productos = [...porId.values()];
  if (!productos.length) throw new Error("Mercadona no ha devuelto productos");
  const fecha = Date.now();
  try {
    localStorage.setItem(CLAVE_CACHE, JSON.stringify({ wh, fecha, productos }));
  } catch (e) {
    // Sin espacio en el móvil: se usa igualmente, solo que no queda guardado.
  }
  return { productos: prepararIndice(productos), fecha };
}

// ---------- búsqueda ----------

/**
 * Productos que encajan con un alimento, de mejor a peor: todas las palabras
 * buscadas tienen que aparecer en el nombre; puntúan que el nombre empiece
 * por lo buscado, que esté en la categoría de su sección del súper y que el
 * nombre sea corto (menos palabras de más); restan los productos elaborados
 * que no se han pedido. Con aComprar, suman los que permiten calcular exacto
 * cuántos envases hacen falta.
 */
export function buscarProductos(productos, texto, seccion, max = 8, aComprar = null) {
  const q = claveNombre(texto).split(" ").filter(Boolean);
  if (!q.length) return [];
  const preferidas = CATEGORIAS_POR_SECCION[seccion] || [];
  const encaja = (t, w) => w === t || (t.length >= 3 && w.startsWith(t));
  const resultados = [];
  const pedido = (w) => q.some((t) => w.startsWith(t));
  for (const p of productos) {
    if (!q.every((t) => p.k.some((w) => encaja(t, w)))) continue;
    const nucleo = p.k.filter((w) => !NEUTRAS.has(w) || pedido(w));
    let puntos = 0;
    if (nucleo.length && encaja(q[0], nucleo[0])) puntos += 25;
    if (q.every((t) => p.k.includes(t))) puntos += 10;
    if (preferidas.includes(p.c)) puntos += 30;
    if (CATEGORIAS_AJENAS.includes(p.c) && !preferidas.includes(p.c)) puntos -= 40;
    puntos -= 2 * Math.max(0, nucleo.length - q.length);
    if (p.k.some((w) => ELABORADOS.some((e) => w.startsWith(e)) && !pedido(w))) puntos -= 30;
    if (p.k.some((w) => /congelad/.test(w) && !pedido(w))) puntos -= 6;
    if (aComprar && envasesNecesarios(aComprar, p).exacto) puntos += 8;
    resultados.push({ p, puntos });
  }
  resultados.sort((a, b) => b.puntos - a.puntos || (a.p.r ?? Infinity) - (b.p.r ?? Infinity));
  return resultados.slice(0, max).map((r) => r.p);
}

// ---------- cantidades ----------

/**
 * Cuántos envases hay que comprar para cubrir lo que falta de una entrada de
 * la lista. { envases, exacto }: exacto = false cuando no se ha podido
 * calcular (unidades incompatibles o sin cantidad) y se propone 1.
 */
export function envasesNecesarios(aComprar, p) {
  const falta = (base) => aComprar?.[base] || 0;
  let base = null;
  let porEnvase = 0;
  if (p.u === "kg") [base, porEnvase] = ["g", p.s * 1000];
  else if (p.u === "l") [base, porEnvase] = ["ml", p.s * 1000];
  else if (p.u === "ud") [base, porEnvase] = ["ud", p.s];

  // Fruta y verdura que se vende por piezas: "4 ud" son 4 piezas; y un pack
  // de 6 yogures cubre 6 unidades.
  if (p.pk === "Pieza" && falta("ud") > 0) return { envases: Math.ceil(falta("ud")), exacto: true };
  if (p.tu > 1 && base !== "ud" && falta("ud") > 0) return { envases: Math.ceil(falta("ud") / p.tu), exacto: true };
  if (base && porEnvase > 0 && falta(base) > 0) {
    return { envases: Math.max(1, Math.ceil(falta(base) / porEnvase - 0.02)), exacto: true };
  }
  return { envases: 1, exacto: false };
}

export function textoFalta(aComprar) {
  return formatearCantidades(aComprar || {});
}
