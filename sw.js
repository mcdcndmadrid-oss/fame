// Service worker de Fame. Estrategia "primero red": con conexión siempre se
// usa la última versión publicada (y se guarda una copia); sin conexión se
// sirve la última copia guardada. Los datos (Firestore) no pasan por aquí:
// tienen su propia caché offline configurada en db.js.

const CACHE = "fame-v18";

const APP = [
  "./",
  "index.html",
  "manifest.json",
  "favicon.svg",
  "css/style.css",
  "js/app.js",
  "js/db.js",
  "js/firebase-config.js",
  "js/generator.js",
  "js/escolar-pdf.js",
  "js/compra.js",
  "js/recetas.js",
  "js/recetas-config.js",
  "js/mercadona.js",
  "icons/fame-192.png",
  "icons/fame-512.png",
];

// Librerías externas que la app necesita para arrancar.
const EXTERNOS = [
  "https://www.gstatic.com/firebasejs/",
  "https://cdn.jsdelivr.net/npm/",
  "https://fonts.googleapis.com/",
  "https://fonts.gstatic.com/",
];

// Cada archivo se guarda por separado: si alguno falla, el service worker se
// instala igualmente (con addAll bastaba un 404 para que no se activara y
// Chrome no ofreciera instalar la app).
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(APP.map((ruta) => cache.add(new Request(ruta, { cache: "no-cache" }))))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((claves) => Promise.all(claves.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const propio = url.origin === self.location.origin;
  if (!propio && !EXTERNOS.some((prefijo) => req.url.startsWith(prefijo))) return;

  // "no-cache" obliga a revalidar con el servidor: así nunca se queda una
  // versión vieja de la app por la caché normal del navegador.
  const peticion = propio ? new Request(req.url, { cache: "no-cache" }) : req;

  event.respondWith(
    fetch(peticion)
      .then((res) => {
        if (res.ok) {
          const copia = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copia));
        }
        return res;
      })
      .catch(async () => {
        const guardada = await caches.match(req, { ignoreSearch: true });
        if (guardada) return guardada;
        if (req.mode === "navigate") return caches.match("./");
        return Response.error();
      })
  );
});
