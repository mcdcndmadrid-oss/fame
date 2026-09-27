# Menú Familiar

App estática (GitHub Pages) + Firebase (Firestore + Auth) para generar el menú semanal, gestionar el catálogo de platos y consultar las recetas del día. Sin servidor propio: todo el "backend" es Firebase en su capa gratuita.

## Estado (Fase 1 del roadmap)

- [x] Catálogo de platos (alta/edición/borrado)
- [x] Configuración de restricciones (legumbres/semana, días fuera, días solo cena, etc.)
- [x] Generador de menú semanal respetando restricciones + menú escolar
- [x] Vista de "hoy" con la receta del plato correspondiente
- [ ] Inventario nevera/despensa (Fase 3)
- [ ] Lista de la compra automática (Fase 2)
- [ ] Integración supermercado online (Fase 5)

## 1. Crear el proyecto de Firebase (una vez, tú)

1. Ve a https://console.firebase.google.com/ → "Añadir proyecto" (gratis, no pide tarjeta para el plan Spark).
2. Dentro del proyecto: **Compilación → Firestore Database → Crear base de datos** (modo producción, la región más cercana, ej. `eur3`).
3. **Compilación → Authentication → Comenzar** → habilita el proveedor **Google** (así cada miembro de la familia entra con su cuenta de Google, sin gestionar contraseñas).
4. En **Reglas de Firestore**, pega algo así para que solo los que han iniciado sesión puedan leer/escribir (ajústalo si quieres restringirlo a emails concretos de la familia):

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```

5. **Configuración del proyecto (rueda dentada) → General → Tus apps → Web (`</>`)** → registra una app. Te da un objeto `firebaseConfig`.
6. Copia esos valores en [`js/firebase-config.js`](js/firebase-config.js) (ya tiene el hueco preparado).

## 2. Probar en local

No hace falta build ni npm. Basta con servir la carpeta como estático, por ejemplo:

```bash
npx serve .
```

o la extensión "Live Server" de VS Code. (Abrir `index.html` con doble clic también funciona para probar la UI, pero Firebase Auth con popup a veces se queja del `file://`; mejor servirlo por `http://localhost`).

## 3. Publicar en GitHub Pages

Igual que tus otras apps: crea el repo, sube este contenido, y activa Pages apuntando a la rama `main` (carpeta raíz). `firebase-config.js` con las claves web de Firebase **no es secreto** (las claves web de Firebase están pensadas para ir en el cliente); la seguridad real la dan las reglas de Firestore del paso 4.

## 4. Cargar platos de ejemplo (opcional)

Con la app abierta y ya con sesión iniciada, abre la consola del navegador (F12) y ejecuta:

```js
importarSeed()
```

Esto carga en Firestore los platos de [`data/platos-seed.json`](data/platos-seed.json) para no partir del catálogo vacío. Es un helper de un solo uso, pensado solo para el arranque inicial.

## 5. Importar recetas de webs (intermediario en Cloudflare)

El navegador no deja que una web en github.io descargue páginas de otras webs, así que la importación por enlace pasa por un pequeño intermediario gratuito en Cloudflare Workers. Solo devuelve los datos de la receta y solo atiende a esta app. Sin él sigue funcionando «Pegar texto».

1. Crea una cuenta gratuita en https://dash.cloudflare.com/sign-up.
2. **Workers & Pages → Create → Create Worker**, ponle un nombre (p. ej. `fame-recetas`) y pulsa **Deploy**.
3. **Edit code**: borra el contenido, pega el de [`cloudflare/recetas-worker.js`](cloudflare/recetas-worker.js) y pulsa **Deploy**.
4. Copia la dirección del Worker (`https://fame-recetas.TU-SUBDOMINIO.workers.dev`) en [`js/recetas-config.js`](js/recetas-config.js) y sube ese archivo.

Si publicas la app en otra dirección, añádela a `ORIGENES_PERMITIDOS` en el Worker.

### Reconocer alimentos con foto (Gemini)

El botón «Reconocer con foto» del Inventario usa el mismo Worker, que envía la foto (reducida) a Gemini de Google y devuelve solo la lista de alimentos.

1. En [Google AI Studio](https://aistudio.google.com/apikey) pulsa **Create API key** y cópiala. El nivel gratuito sobra para uso familiar.
2. En Cloudflare, abre el Worker → **Settings → Variables and Secrets → Add**, tipo **Secret**, nombre `GEMINI_API_KEY`, valor la clave. Guarda.
3. Opcional: una variable de texto `GEMINI_MODELO` si quieres otro modelo (por defecto `gemini-2.5-flash`).

## Estructura

```
index.html          Shell de la app y navegación por pestañas
manifest.json       Manifiesto PWA (nombre, iconos, colores) para instalarla en el móvil
sw.js               Service worker (primero red; copia offline de la app)
icons/              Iconos PNG de la app instalada
css/style.css        Estilos
js/firebase-config.js  Config de tu proyecto Firebase (rellenar)
js/db.js             Acceso a Firestore (platos, restricciones, menús)
js/generator.js       Algoritmo del generador de menú (puro, sin Firebase)
js/escolar-pdf.js     Lectura del menú escolar en PDF (semanas, 1º/2º/postre, categorías)
js/compra.js          Lista de la compra: agrupar por alimento, sumar unidades, secciones
js/recetas.js         Convertir recetas de webs o texto pegado en platos
js/recetas-config.js  Dirección del intermediario de Cloudflare
cloudflare/           Código del intermediario (se pega en Cloudflare, no se publica)
js/app.js             Lógica de UI y pegamento entre módulos
data/platos-seed.json  Ejemplo de catálogo inicial para importar
```
