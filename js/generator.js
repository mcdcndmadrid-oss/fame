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

// Criterios que se pueden activar o desactivar en Reglas (activos por defecto).
export const CRITERIOS_POR_DEFECTO = {
  comidaComoCole: true, // la comida de casa se parece (en categorías) a la del cole ese día
  cenaComplementaria: true, // la cena complementa lo comido a mediodía
  cenasRapidas: true, // en la cena, mejor platos rápidos
};

// Qué categorías complementan en la cena lo comido a mediodía, plato a plato:
// tras legumbre o hidratos, verdura; tras verdura, hidratos o legumbre; en el
// segundo se alterna carne, pescado y huevo; y en el postre, fruta o lácteo.
// Una categoría sin entrada (p. ej. "otro") no limita la cena.
export const COMPLEMENTO_CENA = {
  legumbre: ["verdura", "ensalada"],
  pasta: ["verdura", "ensalada"],
  arroz: ["verdura", "ensalada"],
  verdura: ["pasta", "arroz", "legumbre", "ensalada"],
  ensalada: ["verdura", "pasta", "arroz", "legumbre"],
  carne: ["pescado", "huevo"],
  pescado: ["huevo", "carne"],
  huevo: ["pescado", "carne"],
  fruta: ["fruta", "lacteo"],
  lacteo: ["fruta"],
  postre: ["fruta", "lacteo"],
};

// Ordena primero por favorito (los favoritos entran antes en la lista de
// candidatos, lo que sesga su probabilidad de ser elegidos) y dentro de
// cada grupo por antigüedad de uso (los que hace más semanas que no salen).
function ordenarPorAntiguedad(platos, hace) {
  return [...platos].sort((a, b) => {
    const favA = a.favorito ? 0 : 1;
    const favB = b.favorito ? 0 : 1;
    if (favA !== favB) return favA - favB;
    const ha = hace(a);
    const hb = hace(b);
    return ha === hb ? 0 : hb > ha ? 1 : -1;
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
 * @param {Array} platos catálogo completo {id, nombre, categoria, curso, tiempoPrep, favorito}
 * @param {Object} restricciones {
 *   reglasCategoria: [{ categoria, minPorSemana, maxPorSemana }],
 *   semanasSinRepetir,
 *   diasEspeciales: { lunes: { comida: bool, cena: bool }, ... },
 *   estructura: { comida: { primero, segundo, postre }, cena: { ... } },
 *   criterios: { comidaComoCole, cenaComplementaria, cenasRapidas },
 * }
 * @param {Object} menuEscolar { lunes: { primero: {nombre, categoria}, segundo, postre }, ... }
 * @param {string} semanaInicioISO fecha (YYYY-MM-DD) del lunes de la semana a generar
 * @param {Object} historial { platoId: semanas que hace que se usó (1 = la semana anterior) },
 *   sacado de los menús guardados de semanas anteriores (nunca de la que se genera)
 * @returns {{ dias: Object, warnings: string[] }}
 *
 * Hay dos tipos de criterios:
 * - REGLAS: se cumplen siempre que sea posible. Si en un hueco no hay ningún
 *   plato que las cumpla todas, se van relajando de la menos a la más
 *   prioritaria (orden de REGLAS, de abajo arriba) y se avisa de cada una que
 *   haya habido que saltarse y dónde.
 * - PREFERENCIAS: entre los platos que cumplen las reglas, se prefieren los
 *   que las cumplen; si ninguno las cumple, se ignoran sin avisar.
 */
export function generarMenu(platos, restricciones, menuEscolar, semanaInicioISO, historial = {}) {
  const semanasSinRepetir = restricciones.semanasSinRepetir ?? 3;
  const criterios = { ...CRITERIOS_POR_DEFECTO, ...restricciones.criterios };
  const slots = construirSlots(restricciones.diasEspeciales, restricciones.estructura);
  const dias = Object.fromEntries(DIAS.map((d) => [d, { comida: comidaVacia(), cena: comidaVacia() }]));
  const categoriaDe = Object.fromEntries(platos.map((p) => [p.id, p.categoria]));
  const hace = (p) => historial[p.id] ?? Infinity;

  const usosSemana = {};
  const contadorCategoria = {};
  const reglasCategoria = restricciones.reglasCategoria || [];
  const reglasMinimo = reglasCategoria.filter((r) => r.categoria && r.minPorSemana > 0);
  const maxMap = Object.fromEntries(
    reglasCategoria
      .filter((r) => r.categoria && r.maxPorSemana !== undefined && r.maxPorSemana !== null && r.maxPorSemana !== "")
      .map((r) => [r.categoria, Number(r.maxPorSemana)])
  );

  // Categoría del plato que sirve el cole ese día en ese curso (o null).
  function categoriaCole(dia, curso) {
    const valor = menuEscolar?.[dia];
    return (valor && typeof valor === "object" && valor[curso]?.categoria) || null;
  }
  // Lo comido a mediodía ese día en ese curso: el cole si hay menú escolar;
  // si no, la comida de casa (si ya está puesta).
  function mediodia(dia, curso) {
    return categoriaCole(dia, curso) || categoriaDe[dias[dia].comida[curso]] || null;
  }
  const complementa = (deMediodia, deCena) =>
    !deMediodia || !deCena || !COMPLEMENTO_CENA[deMediodia] || COMPLEMENTO_CENA[deMediodia].includes(deCena);

  // De más a menos prioritaria.
  const REGLAS = [
    {
      nombre: "máximo semanal de la categoría",
      cumple: (p) => maxMap[p.categoria] === undefined || (contadorCategoria[p.categoria] || 0) < maxMap[p.categoria],
    },
    { nombre: "no repetir plato en la misma semana", cumple: (p) => !usosSemana[p.id] },
    {
      nombre: `no repetir plato de las últimas ${semanasSinRepetir} semanas`,
      cumple: (p) => hace(p) > semanasSinRepetir,
    },
  ];
  if (criterios.cenaComplementaria) {
    REGLAS.push({
      nombre: "la cena complementa lo comido a mediodía",
      cumple: (p, slot) =>
        slot.comida === "cena"
          ? complementa(mediodia(slot.dia, slot.curso), p.categoria)
          : // Sin cole, la comida de casa es la referencia de la cena: si la cena
            // ya está puesta, la comida tiene que casar con ella.
            categoriaCole(slot.dia, slot.curso) || complementa(p.categoria, categoriaDe[dias[slot.dia].cena[slot.curso]]),
    });
  }

  // En orden: cada una afina la lista que deja la anterior.
  const PREFERENCIAS = [];
  if (criterios.comidaComoCole) {
    PREFERENCIAS.push((p, slot) => {
      const cole = slot.comida === "comida" && categoriaCole(slot.dia, slot.curso);
      return !cole || p.categoria === cole;
    });
  }
  if (criterios.cenasRapidas) {
    PREFERENCIAS.push((p, slot) => slot.comida !== "cena" || p.tiempoPrep !== "largo");
    PREFERENCIAS.push((p, slot) => slot.comida !== "cena" || p.tiempoPrep === "rapido");
  }

  const forzadas = new Map(); // nombre de regla -> huecos donde se ha saltado
  const avisos = [];
  const describir = (s) => `${s.dia} ${s.comida} (${NOMBRE_CURSO[s.curso]})`;

  // Platos del curso del hueco que cumplen el máximo número de reglas posible
  // y, entre ellos, las preferencias que se puedan.
  function mejoresCandidatos(slot, filtro = () => true) {
    const base = platos.filter((p) => cursoDePlato(p) === slot.curso && filtro(p));
    for (let activas = REGLAS.length; activas >= 0; activas--) {
      let lista = base.filter((p) => REGLAS.slice(0, activas).every((r) => r.cumple(p, slot)));
      if (!lista.length) continue;
      let preferencias = 0;
      for (const pref of PREFERENCIAS) {
        const afinada = lista.filter((p) => pref(p, slot));
        if (afinada.length) {
          lista = afinada;
          preferencias++;
        }
      }
      return { lista, reglasCumplidas: activas, preferencias };
    }
    return { lista: [], reglasCumplidas: -1, preferencias: 0 };
  }

  function ordenar(lista) {
    return ordenarPorAntiguedad(shuffle(lista), hace).sort((a, b) => (usosSemana[a.id] || 0) - (usosSemana[b.id] || 0));
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

  // Las comidas antes que las cenas: así la cena ya sabe qué se ha comido.
  let libres = shuffle(slots).sort((a, b) => COMIDAS.indexOf(a.comida) - COMIDAS.indexOf(b.comida));

  // 1) Mínimos por categoría: en el hueco donde ese plato rompa menos reglas
  //    y cumpla más preferencias.
  for (const regla of reglasMinimo) {
    let puestos = 0;
    for (let i = 0; i < regla.minPorSemana; i++) {
      let mejor = null;
      libres.forEach((slot, idx) => {
        const r = mejoresCandidatos(slot, (p) => p.categoria === regla.categoria);
        if (!r.lista.length) return;
        if (
          !mejor ||
          r.reglasCumplidas > mejor.reglasCumplidas ||
          (r.reglasCumplidas === mejor.reglasCumplidas && r.preferencias > mejor.preferencias)
        ) {
          mejor = { idx, ...r };
        }
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
