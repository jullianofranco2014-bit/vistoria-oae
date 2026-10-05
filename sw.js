/* Service worker: guarda os arquivos do app para funcionar sem internet.
 * Ao publicar uma versão nova do app, trocar o nome do CACHE (e o ?v= no index.html). */
const CACHE = "vistoria-oae-v0.7.1";
const ARQUIVOS = ["./", "index.html", "estilo.css", "app.js", "manifest.webmanifest", "icone.svg", "icone-192.png", "icone-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/dados/")) return;
  // arquivos do app: primeiro a rede (pega a versão nova quando há internet) e, sem internet, o cache
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
