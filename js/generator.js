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

// ---------- variedad ----------

// Ingredientes de fondo que salen en casi todo y no cuentan como repetición.
const INGREDIENTES_BASICOS = new Set([
  "aceite", "sal", "pimienta", "ajo", "cebolla", "agua", "azucar", "harina", "perejil", "laurel",
  "vinagre", "pimenton", "comino", "oregano", "caldo", "mantequilla", "limon", "especia", "tomillo",
  "romero", "levadura", "nuez", "canela", "cilantro", "albahaca", "curry", "colorante", "azafran",
]);

function normalizarTexto(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function singular(palabra) {
  if (palabra.length > 4 && /[lnrdzjy]es$/.test(palabra)) return palabra.slice(0, -2);
  if (palabra.length > 3 && palabra.endsWith("s")) return palabra.slice(0, -1);
  return palabra;
}

// Ingredientes "con peso" de un plato (sin los básicos), para no poner pollo,
// patata o garbanzos en medio menú. Devuelve [clave, nombre para avisos].
function ingredientesClave(plato) {
  const claves = new Map();
  for (const ing of plato.ingredientes || []) {
    const nombre = typeof ing === "string" ? ing : ing?.nombre;
    // Recetas antiguas guardaban "lentejas 400 g": se quita la cantidad.
    const palabras = normalizarTexto(nombre).replace(/\b\d.*$/, "").split(" ").filter(Boolean).map(singular);
    if (!palabras.length || INGREDIENTES_BASICOS.has(palabras[0])) continue;
    const clave = (typeof ing === "object" && ing.alimentoId) || palabras.join(" ");
    if (!claves.has(clave)) claves.set(clave, (nombre || "").replace(/\s+\d.*$/, "").trim());
  }
  return [...claves];
}

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
const NOMBRE_CURSO_PLURAL = { primero: "primeros platos", segundo: "segundos platos", postre: "postres" };

/*
 * Motor común del generador: guarda el menú que se va formando, lleva la
 * cuenta de lo usado en la semana y sabe qué platos caben en cada hueco.
 *
 * Hay tres niveles de criterios:
 * - REGLAS: se cumplen siempre que sea posible. Si en un hueco no hay ningún
 *   plato que las cumpla todas, se van relajando de la menos a la más
 *   prioritaria (orden de REGLAS, de abajo arriba) y se avisa de cada una que
 *   haya habido que saltarse y dónde.
 * - PREFERENCIAS: entre los platos que cumplen las reglas, se prefieren los
 *   que las cumplen; si ninguno las cumple, se ignoran sin avisar.
 * - VARIEDAD: entre los que quedan, se eligen los que menos repiten
 *   categoría (en la semana, el mismo día y en días seguidos) e ingredientes.
 */
function crearMotor(platos, restricciones, menuEscolar, historial, diasIniciales) {
  const semanasSinRepetir = restricciones.semanasSinRepetir ?? 3;
  const criterios = { ...CRITERIOS_POR_DEFECTO, ...restricciones.criterios };
  const porId = new Map(platos.map((p) => [p.id, p]));
  const hace = (p) => historial[p.id] ?? Infinity;
  const dias = Object.fromEntries(
    DIAS.map((d) => [d, { comida: { ...comidaVacia(), ...diasIniciales?.[d]?.comida }, cena: { ...comidaVacia(), ...diasIniciales?.[d]?.cena } }])
  );
  const categoriaEn = (dia, comida, curso) => porId.get(dias[dia]?.[comida]?.[curso])?.categoria || null;

  const usosSemana = {};
  const contadorCategoria = {};
  const usosIngrediente = {};
  const nombreIngrediente = {};
  function contar(plato, signo) {
    usosSemana[plato.id] = (usosSemana[plato.id] || 0) + signo;
    contadorCategoria[plato.categoria] = (contadorCategoria[plato.categoria] || 0) + signo;
    for (const [k, nombre] of ingredientesClave(plato)) {
      usosIngrediente[k] = (usosIngrediente[k] || 0) + signo;
      nombreIngrediente[k] = nombreIngrediente[k] || nombre;
    }
  }
  for (const dia of DIAS) for (const comida of COMIDAS) for (const curso of CURSOS) {
    const p = porId.get(dias[dia][comida][curso]);
    if (p) contar(p, 1);
  }

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
    return categoriaCole(dia, curso) || categoriaEn(dia, "comida", curso);
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
            categoriaCole(slot.dia, slot.curso) || complementa(p.categoria, categoriaEn(slot.dia, "cena", slot.curso)),
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

  // Cuánto repite un plato lo que ya hay en el menú (más = peor). El cole
  // cuenta para el mismo día salvo en la comida, que se parece al cole adrede.
  function repeticion(p, slot) {
    let puntos = (slot.curso === "postre" ? 1 : 2) * (contadorCategoria[p.categoria] || 0);
    const i = DIAS.indexOf(slot.dia);
    for (const comida of COMIDAS) for (const curso of CURSOS) {
      if (comida === slot.comida && curso === slot.curso) continue;
      if (curso !== "postre" && categoriaEn(slot.dia, comida, curso) === p.categoria) puntos += 4;
    }
    if (slot.comida === "cena" && slot.curso !== "postre" && Object.values(menuEscolar?.[slot.dia] || {}).some((v) => v?.categoria === p.categoria)) puntos += 3;
    for (const vecino of [DIAS[i - 1], DIAS[i + 1]]) {
      if (vecino && slot.curso !== "postre" && categoriaEn(vecino, slot.comida, slot.curso) === p.categoria) puntos += 2;
    }
    for (const [k] of ingredientesClave(p)) puntos += 3 * (usosIngrediente[k] || 0);
    return puntos;
  }

  const forzadas = new Map(); // nombre de regla -> huecos donde se ha saltado
  const describir = (s) => `${s.dia} ${s.comida} (${NOMBRE_CURSO[s.curso]})`;

  return {
    dias,
    reglasMinimo,
    contadorCategoria,
    forzadas,
    describir,

    // Platos del curso del hueco que cumplen el máximo número de reglas
    // posible y, entre ellos, las preferencias que se puedan.
    candidatos(slot, filtro = () => true) {
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
    },

    // Entre los candidatos, los que menos repiten (con un margen pequeño para
    // que haya variedad entre generaciones); y de ellos, favoritos y los que
    // hace más que no salen, con algo de azar.
    elegir(slot, lista) {
      const conPuntos = lista.map((p) => ({ p, r: repeticion(p, slot) }));
      const minimo = Math.min(...conPuntos.map((x) => x.r));
      const variados = conPuntos.filter((x) => x.r <= minimo + 1).map((x) => x.p);
      const orden = ordenarPorAntiguedad(shuffle(variados), hace);
      return shuffle(orden.slice(0, Math.max(3, Math.ceil(orden.length / 2))))[0];
    },

    poner(slot, plato) {
      for (const regla of REGLAS) {
        if (regla.cumple(plato, slot)) continue;
        if (!forzadas.has(regla.nombre)) forzadas.set(regla.nombre, []);
        forzadas.get(regla.nombre).push(describir(slot));
      }
      dias[slot.dia][slot.comida][slot.curso] = plato.id;
      contar(plato, 1);
    },

    quitar(slot) {
      const p = porId.get(dias[slot.dia][slot.comida][slot.curso]);
      if (p) contar(p, -1);
      dias[slot.dia][slot.comida][slot.curso] = null;
      return p || null;
    },

    // Avisos cuando el catálogo no da para más variedad: una categoría que
    // llena más de la mitad de los primeros o segundos, o un ingrediente que
    // sale en muchos platos.
    avisosVariedad() {
      const avisos = [];
      for (const curso of ["primero", "segundo"]) {
        const cuenta = {};
        let total = 0;
        for (const dia of DIAS) for (const comida of COMIDAS) {
          const p = porId.get(dias[dia][comida][curso]);
          if (!p) continue;
          cuenta[p.categoria] = (cuenta[p.categoria] || 0) + 1;
          total++;
        }
        const [cat, n] = Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0] || [];
        if (total >= 4 && n > total / 2) {
          const otras = {};
          for (const p of platos) if (cursoDePlato(p) === curso && p.categoria !== cat) otras[p.categoria] = (otras[p.categoria] || 0) + 1;
          const detalle = Object.entries(otras).map(([c, k]) => `${c}: ${k}`).join(", ") || "ninguna";
          avisos.push(`Poca variedad: "${cat}" ocupa ${n} de ${total} ${NOMBRE_CURSO_PLURAL[curso]}. Hay pocas recetas de otras categorías para ese plato (${detalle}); añade más para que no se repita tanto.`);
        }
      }
      const repetidos = Object.entries(usosIngrediente)
        .filter(([, n]) => n >= 4)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${nombreIngrediente[k]} (${n})`)
        .slice(0, 4);
      if (repetidos.length) {
        avisos.push(`Ingredientes que se repiten mucho: ${repetidos.join(", ")}. No hay suficientes recetas sin ellos para cubrir la semana.`);
      }
      return avisos;
    },

    avisosForzadas() {
      return [...forzadas].map(([regla, huecos]) => `No se ha podido cumplir "${regla}" en ${huecos.length} hueco(s): ${huecos.join(", ")}.`);
    },
  };
}

/**
 * Genera el menú de toda la semana.
 * @param {Array} platos catálogo completo {id, nombre, categoria, curso, tiempoPrep, favorito, ingredientes}
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
 */
export function generarMenu(platos, restricciones, menuEscolar, semanaInicioISO, historial = {}) {
  const motor = crearMotor(platos, restricciones, menuEscolar, historial, null);
  const slots = construirSlots(restricciones.diasEspeciales, restricciones.estructura);
  const avisos = [];
  const categoriaDe = (id) => platos.find((p) => p.id === id)?.categoria;
  // Comparación por orden: gana el primer valor que sea mayor.
  const mejorNota = (a, b) => {
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k];
    return false;
  };

  // Las comidas antes que las cenas: así la cena ya sabe qué se ha comido.
  const libres = shuffle(slots).sort((a, b) => COMIDAS.indexOf(a.comida) - COMIDAS.indexOf(b.comida));

  // 1) Mínimos por categoría: en el hueco donde ese plato rompa menos reglas,
  //    cumpla más preferencias y, a igualdad, en días distintos.
  for (const regla of motor.reglasMinimo) {
    let puestos = 0;
    for (let i = 0; i < regla.minPorSemana; i++) {
      let mejor = null;
      shuffle(libres.map((slot, idx) => ({ slot, idx }))).forEach(({ slot, idx }) => {
        const r = motor.candidatos(slot, (p) => p.categoria === regla.categoria);
        if (!r.lista.length) return;
        const yaEseDia = COMIDAS.some((c) => CURSOS.some((k) => categoriaDe(motor.dias[slot.dia][c][k]) === regla.categoria));
        const nota = [r.reglasCumplidas, r.preferencias, yaEseDia ? 0 : 1];
        if (!mejor || mejorNota(nota, mejor.nota)) mejor = { idx, nota, ...r };
      });
      if (!mejor) break;
      const slot = libres[mejor.idx];
      motor.poner(slot, motor.elegir(slot, mejor.lista));
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
    const { lista } = motor.candidatos(slot);
    if (lista.length) motor.poner(slot, motor.elegir(slot, lista));
    else sinPlato.push(slot);
  }

  avisos.push(...motor.avisosForzadas(), ...motor.avisosVariedad());
  for (const curso of CURSOS) {
    const huecos = sinPlato.filter((s) => s.curso === curso);
    if (huecos.length) {
      avisos.push(`No hay ningún plato de tipo "${NOMBRE_CURSO[curso]}" en el catálogo; quedan vacíos: ${huecos.map(motor.describir).join(", ")}.`);
    }
  }

  return { dias: motor.dias, warnings: avisos };
}

/**
 * Cambia el plato de un solo hueco por otro que cumpla las mismas reglas,
 * teniendo en cuenta el resto del menú tal como está.
 * @param {Object} dias menú actual de la semana
 * @param {{dia, comida, curso}} slot hueco a cambiar
 * @returns {{ platoId: string|null, avisos: string[] }}
 */
export function regenerarPlato(platos, restricciones, menuEscolar, semanaInicioISO, historial, dias, slot) {
  const motor = crearMotor(platos, restricciones, menuEscolar, historial || {}, dias);
  const actual = motor.quitar(slot);
  const distinto = (p) => p.id !== actual?.id;

  // Si al quitarlo falta algún mínimo semanal (p. ej. era la segunda
  // legumbre), se busca primero otro de esa categoría.
  const faltan = motor.reglasMinimo
    .filter((r) => (motor.contadorCategoria[r.categoria] || 0) < r.minPorSemana)
    .map((r) => r.categoria);
  let r = faltan.length ? motor.candidatos(slot, (p) => distinto(p) && faltan.includes(p.categoria)) : { lista: [] };
  if (!r.lista.length) r = motor.candidatos(slot, distinto);
  if (!r.lista.length) return { platoId: null, avisos: [] };

  const plato = motor.elegir(slot, r.lista);
  motor.poner(slot, plato);
  return { platoId: plato.id, avisos: motor.avisosForzadas() };
}
