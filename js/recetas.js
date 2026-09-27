// Convierte una receta de internet en un plato de Fame. Módulo puro (sin DOM
// ni Firebase). Dos entradas posibles:
// - desdeSchemaOrg(): la receta estructurada (schema.org "Recipe") que
//   devuelve el intermediario de Cloudflare;
// - desdeTexto(): el texto de una receta copiado y pegado de cualquier web.

import { categorizarPlato } from "./escolar-pdf.js";
import { CURSO_POR_CATEGORIA } from "./generator.js";

const UNIDADES_CONOCIDAS = [
  "g", "gr", "grs", "gramo", "gramos", "kg", "kilo", "kilos", "mg",
  "ml", "cl", "dl", "l", "litro", "litros",
  "cucharada", "cucharadas", "cda", "cdas", "cucharadita", "cucharaditas", "cdta", "cdtas",
  "taza", "tazas", "vaso", "vasos", "diente", "dientes", "pizca", "pizcas", "lata", "latas",
  "bote", "botes", "sobre", "sobres", "rodaja", "rodajas", "hoja", "hojas", "rama", "ramas", "ramita", "ramitas",
  "manojo", "manojos", "punado", "punados", "unidad", "unidades", "ud", "uds", "filete", "filetes",
  "loncha", "lonchas", "trozo", "trozos", "chorro", "chorrito", "copa", "copas", "paquete", "paquetes", "tarrina", "tarrinas",
];

const FRACCIONES = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };

const NUMEROS_ESCRITOS = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, media: 0.5, medio: 0.5 };

function sinAcentos(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function limpiarTexto(texto) {
  return String(texto ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*|__/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function leerNumero(texto) {
  const t = texto.trim();
  if (t in FRACCIONES) return FRACCIONES[t];
  const mixto = t.match(/^(\d+)\s*([½¼¾⅓⅔])$/);
  if (mixto) return Number(mixto[1]) + FRACCIONES[mixto[2]];
  const fraccion = t.match(/^(\d+)\/(\d+)$/);
  if (fraccion) return Number(fraccion[1]) / Number(fraccion[2]);
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// "400g Arroz arborio", "2 dientes de ajo", "1/2 cebolla", "una pizca de sal",
// "Aceite de oliva", "Harina 200 g" -> { nombre, cantidad, unidad }
export function parsearIngredienteTexto(lineaOriginal) {
  let linea = limpiarTexto(lineaOriginal).replace(/^[-•*·–—]\s*/, "");
  if (!linea) return null;

  // Cantidad al principio (número, fracción o número escrito).
  const inicio = linea.match(/^(\d+\/\d+|\d+(?:[.,]\d+)?\s*[½¼¾⅓⅔]?|[½¼¾⅓⅔])\s*/);
  let cantidad = null;
  let resto = linea;
  if (inicio) {
    cantidad = leerNumero(inicio[1]);
    resto = linea.slice(inicio[0].length);
  } else {
    const palabra = sinAcentos(linea.split(" ")[0]);
    if (palabra in NUMEROS_ESCRITOS) {
      cantidad = NUMEROS_ESCRITOS[palabra];
      resto = linea.slice(linea.indexOf(" ") + 1);
    }
  }

  if (cantidad != null) {
    const [primera = "", ...otras] = resto.split(" ");
    const posibleUnidad = sinAcentos(primera).replace(/\.$/, "").replace(/ñ/g, "n");
    let unidad = "";
    if (UNIDADES_CONOCIDAS.includes(posibleUnidad)) {
      unidad = primera.replace(/\.$/, "");
      resto = otras.join(" ");
    }
    const nombre = resto.replace(/^(de|del)\s+/i, "").trim();
    if (nombre) return { nombre: mayusculaInicial(nombre), cantidad, unidad };
  }

  // Cantidad al final: "Harina 200 g".
  const final = linea.match(/^(.*?)\s+(\d+(?:[.,]\d+)?)\s*([a-zA-Záéíóúñ]*)$/);
  if (final && final[1]) return { nombre: mayusculaInicial(final[1]), cantidad: leerNumero(final[2]), unidad: final[3] || "" };

  return { nombre: mayusculaInicial(linea), cantidad: null, unidad: "" };
}

function mayusculaInicial(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Un bloque largo de instrucciones se parte en frases para que cada paso
// sea legible por separado.
function partirEnPasos(texto) {
  const parrafos = String(texto)
    .split(/\n+/)
    .map(limpiarTexto)
    .filter(Boolean);
  if (parrafos.length > 1) return parrafos;
  const unico = parrafos[0] || "";
  if (unico.length < 250) return unico ? [unico] : [];
  return unico.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/).map((s) => s.trim()).filter(Boolean);
}

function pasosDeInstrucciones(instr) {
  if (!instr) return [];
  if (typeof instr === "string") return partirEnPasos(instr);
  if (Array.isArray(instr)) return instr.flatMap(pasosDeInstrucciones);
  if (instr.itemListElement) return pasosDeInstrucciones(instr.itemListElement);
  if (instr.text) return partirEnPasos(instr.text);
  if (instr.name) return partirEnPasos(instr.name);
  return [];
}

// "PT36M", "P0DT1H15M" -> minutos
function minutosDeDuracion(iso) {
  const m = String(iso || "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  const total = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return total || null;
}

function tiempoPrep(minutos) {
  if (!minutos) return "normal";
  if (minutos <= 20) return "rapido";
  if (minutos <= 60) return "normal";
  return "largo";
}

function completarPlato({ nombre, ingredientes, pasos, minutos, fuente }) {
  const categoria = categorizarPlato(nombre) || "otro";
  return {
    nombre,
    categoria,
    curso: CURSO_POR_CATEGORIA[categoria] || "segundo",
    tiempoPrep: tiempoPrep(minutos),
    ingredientes: ingredientes.filter(Boolean),
    pasos,
    fuente: fuente || "",
  };
}

// Nombres de webs tipo "Risotto de setas, la receta que puedes hacer…":
// se queda la parte antes de la primera coma o dos puntos si es razonable.
function nombreCorto(nombre) {
  const limpio = limpiarTexto(nombre);
  const corte = limpio.split(/[,:|]/)[0].trim();
  return corte.length >= 4 ? corte : limpio;
}

export function desdeSchemaOrg(receta, url) {
  const minutos = minutosDeDuracion(receta.totalTime) || (minutosDeDuracion(receta.prepTime) || 0) + (minutosDeDuracion(receta.cookTime) || 0);
  return completarPlato({
    nombre: nombreCorto(receta.name || ""),
    ingredientes: [].concat(receta.recipeIngredient || receta.ingredients || []).map(parsearIngredienteTexto),
    pasos: pasosDeInstrucciones(receta.recipeInstructions),
    minutos,
    fuente: url,
  });
}

// Texto pegado: se buscan los encabezados "Ingredientes" y "Preparación"
// (o similares). Si no los hay, las líneas cortas del principio se toman
// como ingredientes y el resto como pasos.
export function desdeTexto(texto) {
  const lineas = String(texto).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lineas.length === 0) return null;
  const esEncabezado = (l, palabras) => palabras.some((p) => new RegExp(`^${p}\\b`, "i").test(sinAcentos(l)) && l.length < 40);
  const ING = ["ingredientes"];
  const PASOS = ["preparacion", "elaboracion", "pasos", "instrucciones", "modo de preparacion", "como hacer"];

  const iIng = lineas.findIndex((l) => esEncabezado(l, ING));
  const iPasos = lineas.findIndex((l, i) => i > iIng && esEncabezado(l, PASOS));

  let nombre;
  let lineasIng;
  let lineasPasos;
  if (iIng >= 0) {
    nombre = iIng > 0 ? lineas[0] : "";
    lineasIng = lineas.slice(iIng + 1, iPasos >= 0 ? iPasos : undefined);
    lineasPasos = iPasos >= 0 ? lineas.slice(iPasos + 1) : [];
  } else {
    nombre = lineas[0];
    const cuerpo = lineas.slice(1);
    const primerPasoLargo = cuerpo.findIndex((l) => l.length > 80);
    lineasIng = primerPasoLargo >= 0 ? cuerpo.slice(0, primerPasoLargo) : cuerpo;
    lineasPasos = primerPasoLargo >= 0 ? cuerpo.slice(primerPasoLargo) : [];
  }

  return completarPlato({
    nombre: nombreCorto(nombre),
    ingredientes: lineasIng.map(parsearIngredienteTexto),
    pasos: lineasPasos.map((l) => limpiarTexto(l).replace(/^\d+[.)-]\s*/, "")).filter(Boolean),
    minutos: null,
  });
}
