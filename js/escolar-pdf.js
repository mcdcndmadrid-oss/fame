// Analizador del menú escolar en PDF (calendario mensual tipo tabla).
// Módulo puro: recibe los textos con su posición y devuelve las semanas con
// primer plato, segundo (+ guarnición) y postre por día.
//
// Cómo se reconstruye la tabla:
// - Columnas: la fila con los nombres de los días (aparece una sola vez).
// - Semanas: franjas verticales entre dos filas de "Kcal" consecutivas (cada
//   semana termina con su fila de valores nutricionales). No se usa el orden
//   del texto en el PDF porque no coincide con el orden visual de la tabla.
// - Alérgenos: algunos meses llevan detrás de cada plato sus códigos
//   ("Lentejas 1T", "Fruta y Pan 1-6T-10T-11") y una leyenda en el margen; los
//   códigos se quitan y un número suelto solo es el día si va al principio del
//   recuadro, no detrás de un plato.

export const DIAS_ESCOLAR = ["lunes", "martes", "miercoles", "jueves", "viernes"];

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const PALABRAS_CATEGORIA = {
  legumbre: ["lenteja", "garbanzo", "alubia", "judion", "fabada", "potaje", "cocido"],
  pescado: ["merluza", "salmon", "atun", "caballa", "palometa", "pescado", "bacalao", "lenguado", "trucha", "fogonero", "dorada", "gallo", "gallineta", "rape", "abadejo", "calamar", "sardina", "pescadilla"],
  carne: ["pollo", "ternera", "cerdo", "lomo", "pavo", "carne", "albondiga", "jamon", "muslito", "filete", "picadillo", "salchicha", "hamburguesa", "cinta"],
  huevo: ["huevo", "tortilla", "revuelto"],
  pasta: ["pasta", "macarron", "espagueti", "espaguet", "canelon", "lasagna", "lasana", "raviol", "fideo", "estrellitas", "tallarin"],
  arroz: ["arroz", "paella", "risotto", "rissotto"],
  ensalada: ["ensalada"],
  verdura: ["verdura", "judias verdes", "judia verde", "guisante", "coliflor", "brocoli", "espinaca", "calabacin", "repollo", "zanahoria", "acelga", "menestra", "puerro", "berenjena", "vegetal", "crema", "pure", "patata", "gazpacho", "salmorejo"],
};

// Orden de prioridad cuando un nombre encaja en varias categorías: la base del
// plato manda sobre el acompañamiento ("Paella… y Pollo" es arroz,
// "Macarrones con atún" es pasta, "Lentejas con arroz" es legumbre).
const PRIORIDAD = ["legumbre", "arroz", "pasta", "pescado", "carne", "huevo", "ensalada", "verdura"];

// Se comprueban antes que "legumbre" para no confundirlas con alubias.
const SIEMPRE_VERDURA = ["judias verdes", "judia verde"];

// Expresiones que contienen una palabra clave pero no son ese alimento
// ("pico de gallo" es una salsa, no el pescado gallo); se quitan antes de buscar.
const NO_SON_ALIMENTO = ["pico de gallo"];

// Si el nombre empieza por un plato de huevo, la base es el huevo aunque lleve
// algo más ("Huevos revueltos con taquitos de pavo", "Tortilla de atún").
const EMPIEZA_POR_HUEVO = ["huevo", "tortilla", "revuelto"];

const PALABRAS_POSTRE = {
  fruta: ["fruta", "manzana", "platano", "naranja", "pera", "melon", "sandia", "mandarina", "kiwi"],
  lacteo: ["yogur", "yogurt", "queso fresco", "cuajada", "leche", "natillas", "flan", "arroz con leche", "lacteo"],
};

export function normalizar(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

export function categorizarPlato(nombre) {
  let norm = normalizar(nombre);
  if (!norm) return "";
  for (const expr of NO_SON_ALIMENTO) norm = norm.replace(expr, " ");
  if (SIEMPRE_VERDURA.some((p) => norm.includes(p))) return "verdura";
  if (EMPIEZA_POR_HUEVO.some((p) => norm.startsWith(p))) return "huevo";
  for (const cat of PRIORIDAD) {
    if (PALABRAS_CATEGORIA[cat].some((p) => norm.includes(p))) return cat;
  }
  return "otro";
}

export function categorizarPostre(nombre) {
  const norm = normalizar(nombre);
  if (!norm) return "";
  if (PALABRAS_POSTRE.lacteo.some((p) => norm.includes(p))) return "lacteo";
  if (PALABRAS_POSTRE.fruta.some((p) => norm.includes(p))) return "fruta";
  return "postre";
}

function esPostre(linea) {
  const norm = normalizar(linea);
  return [...PALABRAS_POSTRE.fruta, ...PALABRAS_POSTRE.lacteo, "postre", " pan"].some((p) => norm.includes(p)) || norm.startsWith("pan");
}

// Una línea que es continuación de la anterior (nombre largo partido en dos
// líneas dentro de la celda), p. ej. "Judías Verdes con Sofrito de Tomate" +
// "Casero".
function esContinuacion(linea) {
  const palabras = linea.trim().split(/\s+/);
  const primera = palabras[0] || "";
  return palabras.length === 1 || /^[a-záéíóúñ]/.test(primera) || ["de", "del", "con", "al", "a", "en", "y"].includes(primera.toLowerCase());
}

// Si una celda tiene más de 4 líneas es porque algún nombre largo se partió
// en dos; se junta la línea que parece continuación con la anterior. Sin
// pistas, se asume que el partido es el primer plato (el caso más habitual).
function unirContinuaciones(lineas, maximo) {
  const r = [...lineas];
  while (r.length > maximo) {
    let i = r.findIndex((l, k) => k >= 1 && k < r.length - 1 && esContinuacion(l));
    if (i === -1 && esContinuacion(r[r.length - 1])) i = r.length - 1;
    if (i === -1) i = 1;
    r[i - 1] = `${r[i - 1]} ${r[i]}`;
    r.splice(i, 1);
  }
  return r;
}

// Formato del PDF del cole: 1ª línea primer plato, 2ª segundo, 3ª guarnición
// y 4ª (la última) postre.
export function estructurarLineas(lineasOriginales) {
  const lineas = unirContinuaciones(lineasOriginales.filter(Boolean), 4);
  let primero = "";
  let segundo = "";
  let guarnicion = "";
  let postre = "";
  if (lineas.length >= 4) {
    [primero, segundo, guarnicion, postre] = lineas;
  } else if (lineas.length === 3) {
    [primero, segundo] = lineas;
    if (esPostre(lineas[2])) postre = lineas[2];
    else guarnicion = lineas[2];
  } else {
    [primero = "", segundo = ""] = lineas;
  }
  return {
    primero: { nombre: primero, categoria: categorizarPlato(primero) },
    segundo: { nombre: segundo, categoria: categorizarPlato(segundo), guarnicion },
    postre: { nombre: postre, categoria: categorizarPostre(postre) },
  };
}

export async function extraerPaginasPDF(pdfjsLib, buffer) {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const paginas = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const pagina = await pdf.getPage(n);
    const contenido = await pagina.getTextContent();
    const items = contenido.items
      .filter((it) => it.str.trim())
      .map((it) => ({
        str: it.str.trim(),
        x: it.transform[4],
        y: it.transform[5],
        rotado: Math.abs(it.transform[1]) > 0.01 || Math.abs(it.transform[2]) > 0.01,
      }));
    paginas.push(items);
  }
  return paginas;
}

function detectarMesAnio(paginas) {
  const texto = normalizar(paginas.flat().map((i) => i.str).join(" "));
  const m = texto.match(new RegExp(`(${MESES.join("|")}|setiembre)\\s+(\\d{4})`));
  if (!m) return null;
  const mes = m[1] === "setiembre" ? 8 : MESES.indexOf(m[1]);
  return { mes, anio: Number(m[2]) };
}

// Códigos de alérgenos al final de un texto: "1T", "4-12", "1-6T-10T-11"…
const ALERGENOS_AL_FINAL = /(?:\s+\d{1,2}T?(?:-\d{1,2}T?)*)+$/;
const SOLO_ALERGENOS = /^\d{1,2}T?(?:-\d{1,2}T?)*$/;

function quitarAlergenos(texto) {
  const limpio = texto.trim();
  if (SOLO_ALERGENOS.test(limpio)) return "";
  return limpio.replace(ALERGENOS_AL_FINAL, "").trim();
}

function columnaMasCercana(columnas, x, maxDist = 120) {
  let mejor = null;
  let mejorDist = Infinity;
  for (const [clave, cx] of Object.entries(columnas)) {
    const d = Math.abs(cx - x);
    if (d < mejorDist) {
      mejorDist = d;
      mejor = clave;
    }
  }
  return mejorDist <= maxDist ? mejor : null;
}

function agruparEnLineas(items) {
  const ordenados = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lineas = [];
  for (const it of ordenados) {
    const ultima = lineas[lineas.length - 1];
    if (ultima && Math.abs(ultima.y - it.y) <= 2) ultima.partes.push(it);
    else lineas.push({ y: it.y, partes: [it] });
  }
  return lineas.map((l) => ({
    y: l.y,
    texto: l.partes.sort((a, b) => a.x - b.x).map((p) => p.str).join(" ").replace(/\s+/g, " ").trim(),
  }));
}

// Un recuadro mide ~4 líneas con el número del día centrado en vertical;
// más lejos de esto una línea ya no es de ese día (p. ej. notas al pie).
const DISTANCIA_MAX_AL_NUMERO = 40;

// Recuadros de una columna. Cada columna se trata por separado porque en el
// PDF los recuadros de días distintos no están alineados en filas. Cada línea
// de platos va al número de día más cercano en vertical, sin cruzar una fila
// de Kcal (que cierra cada recuadro).
function celdasDeColumna(items) {
  const ysKcal = items.filter((i) => /^kcal/i.test(i.str)).map((i) => i.y);
  const enFilaKcal = (i) => ysKcal.some((y) => Math.abs(y - i.y) <= 2);
  const sinKcal = items.filter((i) => !enFilaKcal(i));

  // Borde izquierdo de los recuadros: donde se repiten los números de día (todos
  // a la misma distancia del margen). Lo que queda más a la izquierda son
  // restos que sobresalen de la columna anterior (p. ej. un código de alérgeno
  // al final de un plato largo) y se descarta.
  const sueltos = sinKcal.filter((i) => /^\d{1,2}$/.test(i.str));
  const borde = sueltos.reduce(
    (mejor, n) => {
      const juntos = sueltos.filter((o) => Math.abs(o.x - n.x) <= 6).length;
      return juntos > mejor.juntos || (juntos === mejor.juntos && n.x < mejor.x) ? { x: n.x, juntos } : mejor;
    },
    { x: -Infinity, juntos: 0 }
  );
  const utiles = sinKcal.filter((i) => i.x >= borde.x - 6);

  // Número del día: en ese borde y sin un texto delante en su misma línea (un
  // código de alérgeno que cayera ahí iría detrás del nombre del plato).
  const detrasDeTexto = (n) => utiles.some((o) => o !== n && Math.abs(o.y - n.y) <= 2 && o.x < n.x && /\D/.test(o.str));
  const numeros = sueltos.filter((n) => Math.abs(n.x - borde.x) <= 6 && !detrasDeTexto(n));
  const textos = utiles.filter((i) => !numeros.includes(i));
  const celdas = numeros.map((n) => ({ dia: Number(n.str), y: n.y, lineas: [] }));

  for (const linea of agruparEnLineas(textos)) {
    let mejor = null;
    let mejorDist = Infinity;
    for (const celda of celdas) {
      const d = Math.abs(celda.y - linea.y);
      const cruzaKcal = ysKcal.some((y) => (y - celda.y) * (y - linea.y) < 0);
      if (!cruzaKcal && d < mejorDist) {
        mejor = celda;
        mejorDist = d;
      }
    }
    if (mejor && mejorDist <= DISTANCIA_MAX_AL_NUMERO) mejor.lineas.push(linea);
  }

  return celdas.map((c) => ({
    dia: c.dia,
    y: c.y,
    lineas: c.lineas
      .sort((a, b) => b.y - a.y)
      .map((l) => quitarAlergenos(l.texto))
      .filter(Boolean),
  }));
}

function aISO(fecha) {
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  const dd = String(fecha.getDate()).padStart(2, "0");
  return `${fecha.getFullYear()}-${mm}-${dd}`;
}

// Con mes y año conocidos, cada recuadro tiene fecha exacta y se agrupa por
// el lunes de su semana. Dentro de una columna los días van creciendo de
// arriba a abajo: si el número baja, se ha pasado al mes siguiente.
function agruparPorFecha(celdas, { mes, anio }) {
  const semanas = new Map();
  for (const clave of DIAS_ESCOLAR) {
    const deColumna = celdas.filter((c) => c.clave === clave).sort((a, b) => a.pagina - b.pagina || b.y - a.y);
    let m = mes;
    let a = anio;
    let anterior = 0;
    for (const c of deColumna) {
      if (c.dia < anterior) {
        m += 1;
        if (m > 11) {
          m = 0;
          a += 1;
        }
      }
      anterior = c.dia;
      const lunes = new Date(a, m, c.dia - DIAS_ESCOLAR.indexOf(clave));
      const id = aISO(lunes);
      if (!semanas.has(id)) semanas.set(id, { lunes: id, dias: {} });
      semanas.get(id).dias[clave] = { diaDelMes: c.dia, ...estructurarLineas(c.lineas) };
    }
  }
  return [...semanas.values()].sort((x, y) => x.lunes.localeCompare(y.lunes));
}

// Sin mes y año, las semanas se agrupan por altura en la página.
function agruparPorAltura(celdas) {
  const ordenadas = [...celdas].sort((a, b) => a.pagina - b.pagina || b.y - a.y);
  const grupos = [];
  for (const c of ordenadas) {
    const g = grupos[grupos.length - 1];
    const dato = { diaDelMes: c.dia, ...estructurarLineas(c.lineas) };
    if (g && g.pagina === c.pagina && Math.abs(g.y - c.y) <= DISTANCIA_MAX_AL_NUMERO && !g.dias[c.clave]) {
      g.dias[c.clave] = dato;
    } else {
      grupos.push({ pagina: c.pagina, y: c.y, dias: { [c.clave]: dato } });
    }
  }
  return grupos.map((g) => ({ lunes: null, dias: g.dias }));
}

export function parsearMenuEscolar(paginas) {
  const mesAnio = detectarMesAnio(paginas);
  let columnas = null;
  const celdas = [];

  paginas.forEach((items, pagina) => {
    const visibles = items.filter((i) => !i.rotado);

    const cabecera = {};
    let yCabecera = Infinity;
    for (const it of visibles) {
      const clave = DIAS_ESCOLAR.find((d) => normalizar(it.str) === d);
      if (clave) {
        cabecera[clave] = it.x;
        yCabecera = it.y;
      }
    }
    if (Object.keys(cabecera).length >= 3) columnas = cabecera;
    else yCabecera = Infinity;
    if (!columnas) return;

    const cuerpo = visibles.filter((i) => i.y < yCabecera - 1);
    // Un texto pertenece a una columna si está a menos de media columna de su
    // cabecera; lo que queda más lejos (leyendas en el margen) no es de ninguna.
    const xs = Object.values(columnas).sort((a, b) => a - b);
    const anchoColumna = xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) : 150;
    for (const clave of Object.keys(columnas)) {
      const enColumna = cuerpo.filter((i) => columnaMasCercana(columnas, i.x, anchoColumna * 0.6) === clave);
      for (const celda of celdasDeColumna(enColumna)) celdas.push({ clave, pagina, ...celda });
    }
  });

  const semanas = mesAnio ? agruparPorFecha(celdas, mesAnio) : agruparPorAltura(celdas);
  return { mesAnio, semanas };
}
