// Algoritmo del generador de menú. Módulo puro (sin Firebase) para poder
// probarlo/ajustarlo de forma aislada.
//
// Cada día tiene comida y cena, y cada una de ellas un primero, un segundo y
// un postre (ids de plato o null), igual que el menú del cole.

export const DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"];
export const COMIDAS = ["comida", "cena"];
export const CURSOS = ["primero", "segundo", "postre"];

// Si un plato no tiene curso asignado a mano, se deduce de su categoría.
export const CURSO_POR_CATEGORIA = {
  legumbre: "primero",
  pasta: "primero",
  arroz: "primero",
  verdura: "primero",
  ensalada: "primero",
  pescado: "segundo",
  carne: "segundo",
  huevo: "segundo",
  otro: "segundo",
  fruta: "postre",
  lacteo: "postre",
  postre: "postre",
};

export function cursoDePlato(plato) {
  return plato?.curso || CURSO_POR_CATEGORIA[plato?.categoria] || "segundo";
}

export const ESTRUCTURA_POR_DEFECTO = {
  comida: { primero: true, segundo: true, postre: true },
  cena: { primero: true, segundo: true, postre: true },
};

export function comidaVacia() {
  return { primero: null, segundo: null, postre: null };
}

// Huecos a rellenar: por cada día con esa comida en casa, un hueco por cada
// curso que la estructura de esa comida incluya.
function construirSlots(diasEspeciales, estructura) {
  const slots = [];
  for (const dia of DIAS) {
    const flags = diasEspeciales?.[dia] || { comida: true, cena: true };
    for (const comida of COMIDAS) {
      if (!flags[comida]) continue;
      for (const curso of CURSOS) {
        if (estructura?.[comida]?.[curso] ?? ESTRUCTURA_POR_DEFECTO[comida][curso]) slots.push({ dia, comida, curso });
      }
    }
  }
  return slots;
}

function semanasDesde(fechaISO, semanaInicioISO) {
  if (!fechaISO) return Infinity;
  const dias = (new Date(semanaInicioISO) - new Date(fechaISO)) / 86400000;
  return dias / 7;
}

function elegible(plato, semanaInicioISO, semanasSinRepetir) {
  return semanasDesde(plato.ultimaVez, semanaInicioISO) >= semanasSinRepetir;
}

// Ordena primero por favorito (los favoritos entran antes en la lista de
// candidatos, lo que sesga su probabilidad de ser elegidos) y dentro de
// cada grupo por antigüedad de uso.
function ordenarPorAntiguedad(platos) {
  return [...platos].sort((a, b) => {
    const favA = a.favorito ? 0 : 1;
    const favB = b.favorito ? 0 : 1;
    if (favA !== favB) return favA - favB;
    const fa = a.ultimaVez ? new Date(a.ultimaVez).getTime() : -Infinity;
    const fb = b.ultimaVez ? new Date(b.ultimaVez).getTime() : -Infinity;
    return fa - fb;
  });
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const NOMBRE_CURSO = { primero: "primer plato", segundo: "segundo plato", postre: "postre" };

/**
 * @param {Array} platos catálogo completo {id, nombre, categoria, curso, ultimaVez}
 * @param {Object} restricciones {
 *   reglasCategoria: [{ categoria, minPorSemana, maxPorSemana }],
 *   semanasSinRepetir,
 *   diasEspeciales: { lunes: { comida: bool, cena: bool }, ... },
 *   estructura: { comida: { primero, segundo, postre }, cena: { ... } },
 * }
 * @param {Object} menuEscolar { lunes: { primero, segundo, postre }, ... } lo que sirve el cole cada día
 * @param {string} semanaInicioISO fecha (YYYY-MM-DD) del lunes de la semana a generar
 * @returns {{ dias: Object, warnings: string[] }}
 *
 * Las reglas se cumplen siempre que sea posible. Si en un hueco no hay ningún
 * plato que las cumpla todas, se van relajando de la menos a la más
 * prioritaria (orden de REGLAS, de abajo arriba) y se avisa de cada una que
 * haya habido que saltarse y dónde.
 */
export function generarMenu(platos, restricciones, menuEscolar, semanaInicioISO) {
  const semanasSinRepetir = restricciones.semanasSinRepetir ?? 3;
  const slots = construirSlots(restricciones.diasEspeciales, restricciones.estructura);
  const dias = Object.fromEntries(DIAS.map((d) => [d, { comida: comidaVacia(), cena: comidaVacia() }]));

  const usosSemana = {};
  const contadorCategoria = {};
  const reglasCategoria = restricciones.reglasCategoria || [];
  const reglasMinimo = reglasCategoria.filter((r) => r.categoria && r.minPorSemana > 0);
  const maxMap = Object.fromEntries(
    reglasCategoria
      .filter((r) => r.categoria && r.maxPorSemana !== undefined && r.maxPorSemana !== null && r.maxPorSemana !== "")
      .map((r) => [r.categoria, Number(r.maxPorSemana)])
  );

  // Categorías que el cole sirve ese día. menuEscolar[dia] puede venir como
  // string (esquema antiguo), { categoria, texto } o { primero, segundo, postre }.
  function categoriasEscolar(dia) {
    const valor = menuEscolar?.[dia];
    if (!valor) return new Set();
    if (typeof valor === "string") return new Set([valor]);
    return new Set([valor.categoria, valor.primero?.categoria, valor.segundo?.categoria].filter((c) => c && c !== "otro"));
  }

  // De más a menos prioritaria.
  const REGLAS = [
    {
      nombre: "máximo semanal de la categoría",
      cumple: (p) => maxMap[p.categoria] === undefined || (contadorCategoria[p.categoria] || 0) < maxMap[p.categoria],
    },
    { nombre: "no repetir plato en la misma semana", cumple: (p) => !usosSemana[p.id] },
    {
      nombre: `no repetir plato de las últimas ${semanasSinRepetir} semanas`,
      cumple: (p) => elegible(p, semanaInicioISO, semanasSinRepetir),
    },
    { nombre: "no coincidir con lo que come en el cole ese día", cumple: (p, slot) => !categoriasEscolar(slot.dia).has(p.categoria) },
  ];

  const forzadas = new Map(); // nombre de regla -> huecos donde se ha saltado
  const avisos = [];
  const describir = (s) => `${s.dia} ${s.comida} (${NOMBRE_CURSO[s.curso]})`;

  // Platos del curso del hueco que cumplen el máximo número de reglas posible.
  function mejoresCandidatos(slot, filtro = () => true) {
    const base = platos.filter((p) => cursoDePlato(p) === slot.curso && filtro(p));
    for (let activas = REGLAS.length; activas >= 0; activas--) {
      const lista = base.filter((p) => REGLAS.slice(0, activas).every((r) => r.cumple(p, slot)));
      if (lista.length) return { lista, reglasCumplidas: activas };
    }
    return { lista: [], reglasCumplidas: -1 };
  }

  function ordenar(lista) {
    return ordenarPorAntiguedad(shuffle(lista)).sort((a, b) => (usosSemana[a.id] || 0) - (usosSemana[b.id] || 0));
  }

  function asignar(slot, lista) {
    const categoria = shuffle([...new Set(lista.map((p) => p.categoria))])[0];
    const deCategoria = ordenar(lista.filter((p) => p.categoria === categoria));
    const plato = shuffle(deCategoria.slice(0, Math.max(3, Math.ceil(deCategoria.length / 2))))[0];

    for (const regla of REGLAS) {
      if (regla.cumple(plato, slot)) continue;
      if (!forzadas.has(regla.nombre)) forzadas.set(regla.nombre, []);
      forzadas.get(regla.nombre).push(describir(slot));
    }
    dias[slot.dia][slot.comida][slot.curso] = plato.id;
    usosSemana[plato.id] = (usosSemana[plato.id] || 0) + 1;
    contadorCategoria[plato.categoria] = (contadorCategoria[plato.categoria] || 0) + 1;
  }

  let libres = shuffle(slots);

  // 1) Mínimos por categoría: en el hueco donde ese plato rompa menos reglas.
  for (const regla of reglasMinimo) {
    let puestos = 0;
    for (let i = 0; i < regla.minPorSemana; i++) {
      let mejor = null;
      libres.forEach((slot, idx) => {
        const r = mejoresCandidatos(slot, (p) => p.categoria === regla.categoria);
        if (r.lista.length && (!mejor || r.reglasCumplidas > mejor.reglasCumplidas)) mejor = { idx, ...r };
      });
      if (!mejor) break;
      asignar(libres[mejor.idx], mejor.lista);
      libres.splice(mejor.idx, 1);
      puestos++;
    }
    if (puestos < regla.minPorSemana) {
      avisos.push(`Mínimo de "${regla.categoria}" (${regla.minPorSemana}/semana): solo se han podido poner ${puestos}; no hay platos o huecos suficientes.`);
    }
  }

  // 2) Resto de huecos.
  const sinPlato = [];
  for (const slot of libres) {
    const { lista } = mejoresCandidatos(slot);
    if (lista.length) asignar(slot, lista);
    else sinPlato.push(slot);
  }

  for (const [regla, huecos] of forzadas) {
    avisos.push(`No se ha podido cumplir "${regla}" en ${huecos.length} hueco(s): ${huecos.join(", ")}.`);
  }
  for (const curso of CURSOS) {
    const huecos = sinPlato.filter((s) => s.curso === curso);
    if (huecos.length) {
      avisos.push(`No hay ningún plato de tipo "${NOMBRE_CURSO[curso]}" en el catálogo; quedan vacíos: ${huecos.map(describir).join(", ")}.`);
    }
  }

  return { dias, warnings: avisos };
}
