import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  deleteDoc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const db = getFirestore(app);

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
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function guardarPlato(plato) {
  if (plato.id) {
    const { id, ...data } = plato;
    await updateDoc(doc(db, "platos", id), data);
    return id;
  }
  const ref = await addDoc(platosCol, plato);
  return ref.id;
}

export async function borrarPlato(id) {
  await deleteDoc(doc(db, "platos", id));
}

export async function marcarPlatoUsado(id, fechaISO) {
  await updateDoc(doc(db, "platos", id), { ultimaVez: fechaISO });
}

// --- Configuración / restricciones ---

const CONFIG_DOC = doc(db, "config", "restricciones");

export async function obtenerRestricciones() {
  const snap = await getDoc(CONFIG_DOC);
  return snap.exists() ? snap.data() : null;
}

export async function guardarRestricciones(config) {
  await setDoc(CONFIG_DOC, config, { merge: true });
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
  await setDoc(doc(db, "menus", semanaId), menu);
}

// --- Inventario ---

const inventarioCol = collection(db, "inventario");

export async function listarInventario() {
  const snap = await getDocs(inventarioCol);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function guardarItemInventario(item) {
  if (item.id) {
    const { id, ...data } = item;
    await updateDoc(doc(db, "inventario", id), data);
    return id;
  }
  const ref = await addDoc(inventarioCol, item);
  return ref.id;
}

export async function borrarItemInventario(id) {
  await deleteDoc(doc(db, "inventario", id));
}

// --- Alimentos (catálogo canónico de nombres, para no duplicar el mismo
// ingrediente escrito de formas distintas entre recetas e inventario) ---

const alimentosCol = collection(db, "alimentos");

export async function listarAlimentos() {
  const snap = await getDocs(alimentosCol);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function guardarAlimento(alimento) {
  if (alimento.id) {
    const { id, ...data } = alimento;
    await updateDoc(doc(db, "alimentos", id), data);
    return id;
  }
  const ref = await addDoc(alimentosCol, alimento);
  return ref.id;
}

// --- Lista de la compra ---
// El id del documento es la fecha ISO (YYYY-MM-DD) del lunes de esa semana,
// igual que en "menus".

export async function obtenerListaCompra(semanaId) {
  const snap = await getDoc(doc(db, "listasCompra", semanaId));
  return snap.exists() ? snap.data() : null;
}

export async function guardarListaCompra(semanaId, data) {
  await setDoc(doc(db, "listasCompra", semanaId), data, { merge: true });
}
