/* Service worker: guarda os arquivos do app para funcionar sem internet.
 * Ao publicar uma versão nova do app, trocar o nome do CACHE (e o ?v= no index.html). */
const CACHE = "vistoria-oae-v0.8.2";
const ARQUIVOS = ["./", "index.html", "estilo.css", "app.js", "manifest.webmanifest", "icone.svg", "icone-192.png", "icone-512.png"];
// páginas da Cartilha de Bolso (0.8.0): num cache à parte, que não se apaga a cada versão nova do app (5,6 MB). Quem
// baixa é o app (baixarCartilha, em app.js, com o mesmo nome); aqui elas só são servidas, primeiro do aparelho.
const CACHE_CARTILHA = "cartilha-ipr-2025";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== CACHE_CARTILHA).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/dados/")) return;
  // páginas da Cartilha: não mudam entre versões; primeiro o aparelho e, se faltar, a rede (e fica guardada)
  if (url.pathname.includes("/cartilha/")) {
    e.respondWith(caches.open(CACHE_CARTILHA).then(async c => {
      const r = await c.match(e.request, { ignoreSearch: true, ignoreVary: true });
      if (r) return r;
      const n = await fetch(e.request);
      if (n.ok) await c.put(e.request, n.clone()).catch(() => {});   // sem espaço: serve assim mesmo
      return n;
    }));
    return;
  }
  // arquivos do app: primeiro a rede (pega a versão nova quando há internet) e, sem internet, o cache
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
