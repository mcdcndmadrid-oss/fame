import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Caché local de los datos: sin conexión se ven los últimos datos cargados y
// los cambios se guardan y se sincronizan al recuperar la conexión.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// Las escrituras se aplican al instante en la caché local y Firestore las
// sincroniza en cuanto hay conexión. No se espera a la confirmación del
// servidor (sin cobertura la app se quedaría bloqueada); si el servidor la
// rechaza, se avisa con el evento "fame:error-guardado".
function escribir(promesa) {
  promesa.catch((err) => window.dispatchEvent(new CustomEvent("fame:error-guardado", { detail: err })));
}

function guardarEnColeccion(nombre, objeto) {
  const { id, ...data } = objeto;
  if (id) {
    escribir(updateDoc(doc(db, nombre, id), data));
    return id;
  }
  const ref = doc(collection(db, nombre)); // id generado en local, sin esperar al servidor
  escribir(setDoc(ref, data));
  return ref.id;
}

export function watchAuth(onChange) {
  return onAuthStateChanged(auth, onChange);
}

export function login() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export function logout() {
  return signOut(auth);
}

// --- Platos ---

const platosCol = collection(db, "platos");

export async function listarPlatos() {
  const snap = await getDocs(platosCol);
  return snap.docs.map((d) => ({ ...d.data(), id: d.id })); // el id real del documento siempre gana
}

export async function guardarPlato(objeto) {
  return guardarEnColeccion("platos", objeto);
}

export async function borrarPlato(id) {
  escribir(deleteDoc(doc(db, "platos", id)));
}

export async function marcarPlatoUsado(id, fechaISO) {
  escribir(updateDoc(doc(db, "platos", id), { ultimaVez: fechaISO }));
}

// --- Configuración / restricciones ---

const CONFIG_DOC = doc(db, "config", "restricciones");

export async function obtenerRestricciones() {
  const snap = await getDoc(CONFIG_DOC);
  return snap.exists() ? snap.data() : null;
}

export async function guardarRestricciones(config) {
  escribir(setDoc(CONFIG_DOC, config, { merge: true }));
}

// --- Menús semanales ---
// El id del documento es la fecha ISO (YYYY-MM-DD) del lunes de esa semana.

export async function obtenerMenu(semanaId) {
  const snap = await getDoc(doc(db, "menus", semanaId));
  return snap.exists() ? snap.data() : null;
}

// Sin merge: el documento siempre se escribe completo ({ dias, menuEscolar })
// y así no quedan restos de campos de formatos anteriores dentro de los mapas.
export async function guardarMenu(semanaId, menu) {
  escribir(setDoc(doc(db, "menus", semanaId), menu));
}

// --- Inventario ---

const inventarioCol = collection(db, "inventario");

export async function listarInventario() {
  const snap = await getDocs(inventarioCol);
  return snap.docs.map((d) => ({ ...d.data(), id: d.id })); // el id real del documento siempre gana
}

export async function guardarItemInventario(objeto) {
  return guardarEnColeccion("inventario", objeto);
}

export async function borrarItemInventario(id) {
  escribir(deleteDoc(doc(db, "inventario", id)));
}

// --- Alimentos (catálogo canónico de nombres, para no duplicar el mismo
// ingrediente escrito de formas distintas entre recetas e inventario) ---

const alimentosCol = collection(db, "alimentos");

export async function listarAlimentos() {
  const snap = await getDocs(alimentosCol);
  return snap.docs.map((d) => ({ ...d.data(), id: d.id })); // el id real del documento siempre gana
}

export async function guardarAlimento(objeto) {
  return guardarEnColeccion("alimentos", objeto);
}

// --- Lista de la compra ---
// El id del documento es la fecha ISO (YYYY-MM-DD) del lunes de esa semana,
// igual que en "menus".

export async function obtenerListaCompra(semanaId) {
  const snap = await getDoc(doc(db, "listasCompra", semanaId));
  return snap.exists() ? snap.data() : null;
}

export async function guardarListaCompra(semanaId, data) {
  escribir(setDoc(doc(db, "listasCompra", semanaId), data, { merge: true }));
}
