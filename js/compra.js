// Lógica de la lista de la compra. Módulo puro (sin Firebase ni DOM):
// - agrupa todas las apariciones de un mismo alimento en una sola entrada,
//   aunque esté escrito distinto (mayúsculas, acentos, plural, erratas);
// - suma cantidades convirtiendo unidades compatibles (g/kg, ml/l, ud…);
// - asigna cada alimento a una sección del súper.

export const SECCIONES = [
  { id: "fruta", nombre: "Fruta", icono: "🍎" },
  { id: "verdura", nombre: "Verdura y hortalizas", icono: "🥦" },
  { id: "carne", nombre: "Carne", icono: "🥩" },
  { id: "pescado", nombre: "Pescado y marisco", icono: "🐟" },
  { id: "huevos-lacteos", nombre: "Huevos y lácteos", icono: "🥚" },
  { id: "legumbres", nombre: "Legumbres", icono: "🫘" },
  { id: "pasta-arroz", nombre: "Pasta, arroz y cereales", icono: "🍝" },
  { id: "panaderia", nombre: "Panadería", icono: "🥖" },
  { id: "despensa", nombre: "Despensa (aceite, conservas, especias…)", icono: "🥫" },
  { id: "congelados", nombre: "Congelados", icono: "🧊" },
  { id: "bebidas", nombre: "Bebidas", icono: "🥤" },
  { id: "hogar", nombre: "Limpieza e higiene", icono: "🧼" },
  { id: "otros", nombre: "Otros", icono: "🛒" },
];

// Palabras clave por sección. Gana la palabra más larga que encaje (así
// "tomate frito" va a despensa y "tomate" a verdura); a igualdad, la que
// aparece antes en el nombre ("caldo de pollo" es despensa).
const PALABRAS_SECCION = {
  fruta: ["fruta", "manzana", "pera", "platano", "naranja", "mandarina", "limon", "lima", "fresa", "uva", "melon", "sandia", "kiwi", "melocoton", "pina", "mango", "aguacate", "cereza", "ciruela", "frambuesa", "arandano"],
  verdura: ["verdura", "tomate", "cebolla", "cebolleta", "ajo", "puerro", "zanahoria", "patata", "pimiento", "calabacin", "berenjena", "calabaza", "lechuga", "espinaca", "acelga", "brocoli", "coliflor", "repollo", "col", "judia verde", "judias verdes", "guisante", "alcachofa", "esparrago", "pepino", "champinon", "seta", "apio", "perejil", "cilantro", "albahaca", "hierbabuena", "rucula", "canonigo", "boniato", "nabo", "remolacha", "maiz dulce"],
  carne: ["carne", "pollo", "pechuga", "muslo", "contramuslo", "alita", "ternera", "cerdo", "lomo", "solomillo", "costilla", "chuleta", "cordero", "pavo", "conejo", "picada", "hamburguesa", "salchicha", "chorizo", "morcilla", "jamon", "bacon", "panceta", "beicon", "fiambre", "pechuga de pavo", "albondiga", "filete"],
  pescado: ["pescado", "merluza", "bacalao", "salmon", "dorada", "lubina", "sardina", "boqueron", "caballa", "palometa", "gallo", "rape", "lenguado", "trucha", "emperador", "pez espada", "calamar", "sepia", "pulpo", "gamba", "langostino", "mejillon", "almeja", "marisco"],
  "huevos-lacteos": ["huevo", "leche", "yogur", "queso", "nata", "mantequilla", "requeson", "cuajada", "natillas", "kefir"],
  legumbres: ["lenteja", "garbanzo", "alubia", "judia blanca", "judia pinta", "habas", "soja", "legumbre"],
  "pasta-arroz": ["pasta", "macarron", "espagueti", "tallarin", "fideo", "lasana", "canelon", "arroz", "cuscus", "quinoa", "avena", "harina", "pan rallado", "cereal", "maiz"],
  panaderia: ["pan", "baguette", "barra", "picatoste", "tostada", "masa de hojaldre", "masa de pizza", "tortilla de trigo", "empanadilla"],
  despensa: ["aceite", "vinagre", "sal", "azucar", "pimienta", "pimenton", "comino", "oregano", "laurel", "tomillo", "romero", "canela", "especia", "curry", "caldo", "pastilla de caldo", "tomate frito", "tomate triturado", "tomate natural triturado", "atun", "bonito en conserva", "conserva", "lata", "aceituna", "mayonesa", "ketchup", "mostaza", "salsa", "miel", "chocolate", "cacao", "galleta", "frutos secos", "almendra", "nuez", "levadura", "maicena", "vino blanco", "vino tinto"],
  congelados: ["congelado", "helado"],
  bebidas: ["agua", "zumo", "refresco", "cerveza", "vino", "cafe", "infusion"],
  hogar: ["papel", "detergente", "lavavajillas", "suavizante", "lejia", "gel de ducha", "champu", "pasta de dientes", "cepillo", "bolsa de basura", "servilleta", "estropajo", "fregasuelos", "jabon", "panal"],
};

export function normalizar(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Quita el plural a cada palabra: "-es" tras l/n/r/d/z/j/y (limones→limon,
// flores→flor) y "-s" en el resto (tomates→tomate, dientes→diente).
function singular(palabra) {
  if (palabra.length > 4 && /[lnrdzjy]es$/.test(palabra)) return palabra.slice(0, -2);
  if (palabra.length > 3 && palabra.endsWith("s")) return palabra.slice(0, -1);
  return palabra;
}

export function claveNombre(nombre) {
  return normalizar(nombre).split(" ").map(singular).join(" ");
}

export function seccionPorNombre(nombre) {
  const texto = ` ${claveNombre(nombre)} `;
  let mejor = null;
  for (const [seccion, palabras] of Object.entries(PALABRAS_SECCION)) {
    for (const palabra of palabras) {
      const clave = claveNombre(palabra);
      const pos = texto.indexOf(` ${clave} `);
      if (pos === -1) continue;
      if (!mejor || clave.length > mejor.largo || (clave.length === mejor.largo && pos < mejor.pos)) {
        mejor = { seccion, largo: clave.length, pos };
      }
    }
  }
  return mejor ? mejor.seccion : "otros";
}

function distancia(a, b) {
  const filas = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) filas[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      filas[i][j] = a[i - 1] === b[j - 1] ? filas[i - 1][j - 1] : 1 + Math.min(filas[i - 1][j], filas[i][j - 1], filas[i - 1][j - 1]);
    }
  }
  return filas[a.length][b.length];
}

// Devuelve una función que, dado un ingrediente { alimentoId, nombre },
// dice a qué alimento del catálogo corresponde (o una clave por nombre si no
// está en el catálogo), para que las variantes de un mismo alimento sumen juntas.
export function crearResolutor(alimentos) {
  const porId = new Map(alimentos.map((a) => [a.id, a]));
  const conClave = alimentos.map((a) => ({ alimento: a, clave: claveNombre(a.nombre) }));
  return ({ alimentoId, nombre }) => {
    if (alimentoId && porId.has(alimentoId)) return { clave: alimentoId, alimento: porId.get(alimentoId) };
    const clave = claveNombre(nombre);
    const exacto = conClave.find((c) => c.clave === clave);
    if (exacto) return { clave: exacto.alimento.id, alimento: exacto.alimento };
    const umbral = clave.length <= 5 ? 1 : 2;
    const parecido = conClave
      .map((c) => ({ ...c, d: distancia(clave, c.clave) }))
      .filter((c) => c.d <= umbral)
      .sort((a, b) => a.d - b.d)[0];
    if (parecido) return { clave: parecido.alimento.id, alimento: parecido.alimento };
    return { clave: `nombre:${clave}`, alimento: null };
  };
}

// ---------- unidades ----------

const UNIDADES = {
  g: ["g", 1], gr: ["g", 1], grs: ["g", 1], gramo: ["g", 1], gramos: ["g", 1],
  kg: ["g", 1000], kgs: ["g", 1000], kilo: ["g", 1000], kilos: ["g", 1000], kilogramo: ["g", 1000], kilogramos: ["g", 1000],
  mg: ["g", 0.001],
  ml: ["ml", 1], mililitro: ["ml", 1], mililitros: ["ml", 1],
  cl: ["ml", 10], dl: ["ml", 100],
  l: ["ml", 1000], lt: ["ml", 1000], litro: ["ml", 1000], litros: ["ml", 1000],
  "": ["ud", 1], u: ["ud", 1], ud: ["ud", 1], uds: ["ud", 1], unidad: ["ud", 1], unidades: ["ud", 1], pieza: ["ud", 1], piezas: ["ud", 1],
};

export function normalizarUnidad(unidad) {
  const u = normalizar(unidad).replace(/\s/g, "");
  if (u in UNIDADES) return { base: UNIDADES[u][0], factor: UNIDADES[u][1] };
  return { base: singular(u), factor: 1 };
}

function redondear(n) {
  return Math.round(n * 100) / 100;
}

function formatoNumero(n) {
  return redondear(n).toLocaleString("es-ES", { maximumFractionDigits: 2 });
}

// Las unidades se guardan en singular para poder sumarlas ("lomo"); al
// mostrarlas se ponen en plural si hace falta ("4 lomos").
function plural(unidad, valor) {
  if (unidad === "ud" || redondear(valor) === 1 || !unidad) return unidad;
  return /[aeiou]$/.test(unidad) ? `${unidad}s` : `${unidad}es`;
}

// { g: 1500, ud: 2 } -> "1,5 kg + 2 ud"
export function formatearCantidades(cantidades) {
  const partes = [];
  for (const [base, valor] of Object.entries(cantidades)) {
    if (valor <= 0) continue;
    if (base === "g") partes.push(valor >= 1000 ? `${formatoNumero(valor / 1000)} kg` : `${formatoNumero(valor)} g`);
    else if (base === "ml") partes.push(valor >= 1000 ? `${formatoNumero(valor / 1000)} l` : `${formatoNumero(valor)} ml`);
    else partes.push(`${formatoNumero(valor)} ${plural(base, valor)}`);
  }
  return partes.join(" + ");
}

function sumar(cantidades, cantidad, unidad) {
  const { base, factor } = normalizarUnidad(unidad);
  cantidades[base] = (cantidades[base] || 0) + cantidad * factor;
}

/**
 * Agrupa las necesidades de la semana, resta el inventario y devuelve una
 * entrada por alimento.
 * @param {Array} usos [{ alimentoId, nombre, cantidad, unidad, plato }] ingredientes de los platos del menú
 * @param {Array} extras [{ id, alimentoId, nombre, cantidad, unidad }] añadidos a mano
 * @param {Array} inventario [{ alimentoId, nombre, cantidad, unidad }]
 * @param {Array} alimentos catálogo de alimentos ({ id, nombre, seccion })
 */
export function agruparCompra(usos, extras, inventario, alimentos) {
  const resolver = crearResolutor(alimentos);
  const entradas = new Map();

  function entrada(item) {
    const { clave, alimento } = resolver(item);
    if (!entradas.has(clave)) {
      entradas.set(clave, {
        clave,
        alimentoId: alimento?.id || null,
        nombre: alimento?.nombre || item.nombre,
        seccion: alimento?.seccion || seccionPorNombre(alimento?.nombre || item.nombre),
        necesita: {},
        sinCantidad: false,
        platos: new Set(),
        extras: [],
      });
    }
    return entradas.get(clave);
  }

  for (const uso of usos) {
    const e = entrada(uso);
    if (uso.cantidad != null && uso.cantidad !== "") sumar(e.necesita, Number(uso.cantidad), uso.unidad);
    else e.sinCantidad = true;
    if (uso.plato) e.platos.add(uso.plato);
  }
  for (const extra of extras) {
    const e = entrada(extra);
    if (extra.cantidad != null && extra.cantidad !== "") sumar(e.necesita, Number(extra.cantidad), extra.unidad);
    else e.sinCantidad = true;
    e.extras.push(extra);
  }

  const disponible = new Map();
  for (const item of inventario) {
    if (item.cantidad == null || item.cantidad === "") continue;
    const { clave } = resolver(item);
    if (!disponible.has(clave)) disponible.set(clave, {});
    sumar(disponible.get(clave), Number(item.cantidad), item.unidad);
  }

  return [...entradas.values()].map((e) => {
    const tengo = disponible.get(e.clave) || {};
    const aComprar = {};
    for (const [base, valor] of Object.entries(e.necesita)) aComprar[base] = Math.max(0, valor - (tengo[base] || 0));
    const tieneCantidad = Object.keys(e.necesita).length > 0;
    return {
      ...e,
      platos: [...e.platos],
      disponible: tengo,
      aComprar,
      cubierto: tieneCantidad && !e.sinCantidad && Object.values(aComprar).every((v) => v <= 0),
    };
  });
}
