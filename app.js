/* App de campo — Vistoria de OAE (UL Palmas).
 * Funciona sem internet: dados das OAEs e vistorias ficam no próprio celular (IndexedDB).
 * A vistoria é exportada no formato JSON lido pelo gerar.py (ficha, relatório fotográfico e croqui).
 *
 * Parte 1: dados das OAEs, escolha da OAE (mais próxima pelo GPS), abertura da vistoria e tela de etapas.
 * Parte 2: roteiro de fotos — câmera do celular, GPS, bússola e posição no mini-croqui.
 */
"use strict";

const VERSAO_APP = "0.2";

/* ---------- armazenamento (IndexedDB) ---------- */
const BD = {
  _bd: null,
  abrir() {
    if (this._bd) return Promise.resolve(this._bd);
    return new Promise((ok, erro) => {
      const r = indexedDB.open("vistoria-oae", 1);
      r.onupgradeneeded = () => {
        const bd = r.result;
        bd.createObjectStore("chaves");                            // pacote de dados e preferências
        bd.createObjectStore("vistorias", { keyPath: "id" });
        bd.createObjectStore("fotos", { keyPath: "id" });           // usado a partir da parte 2
      };
      r.onsuccess = () => { this._bd = r.result; ok(this._bd); };
      r.onerror = () => erro(r.error);
    });
  },
  async _op(loja, modo, fn) {
    const bd = await this.abrir();
    return new Promise((ok, erro) => {
      const t = bd.transaction(loja, modo);
      const r = fn(t.objectStore(loja));
      t.oncomplete = () => ok(r && "result" in r ? r.result : undefined);
      t.onerror = () => erro(t.error);
    });
  },
  ler(loja, chave) { return this._op(loja, "readonly", s => s.get(chave)); },
  todos(loja) { return this._op(loja, "readonly", s => s.getAll()); },
  gravar(loja, valor, chave) { return this._op(loja, "readwrite", s => chave === undefined ? s.put(valor) : s.put(valor, chave)); },
  apagar(loja, chave) { return this._op(loja, "readwrite", s => s.delete(chave)); },
};

/* ---------- utilidades ---------- */
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v, casas = 2) => v == null || v === "" ? "–" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
const hoje = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const dataBR = iso => iso ? iso.split("-").reverse().join("/") : "";

function distanciaM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const textoDist = m => m == null ? "" : m < 1000 ? `${Math.round(m)} m` : `${num(m / 1000, m < 10000 ? 1 : 0)} km`;

function avisar(msg, ms = 3500) {
  const el = $("#aviso");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(avisar._t);
  avisar._t = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------- GPS ---------- */
const GPS = {
  pos: null, erro: null, _id: null, _ouvintes: new Set(),
  iniciar() {
    if (this._id !== null || !("geolocation" in navigator)) return;
    this._id = navigator.geolocation.watchPosition(
      p => { this.pos = { lat: p.coords.latitude, lon: p.coords.longitude, prec: p.coords.accuracy, t: p.timestamp }; this.erro = null; this._avisar(); },
      e => { this.erro = e.code === 1 ? "Permissão de localização negada" : "GPS indisponível"; this._avisar(); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  },
  ouvir(fn) { this._ouvintes.add(fn); return () => this._ouvintes.delete(fn); },
  _avisar() { this._ouvintes.forEach(fn => fn(this)); },
  html() {
    if (this.erro) return `<div class="gps"><span class="ponto"></span>${esc(this.erro)}</div>`;
    if (!this.pos) return `<div class="gps"><span class="ponto"></span>Procurando sinal de GPS…</div>`;
    const fraco = this.pos.prec > 30;
    return `<div class="gps ${fraco ? "fraco" : "ativo"}"><span class="ponto"></span>GPS ${fraco ? "fraco" : "ativo"} · precisão ${Math.round(this.pos.prec)} m</div>`;
  },
};

/* ---------- estado ---------- */
const Estado = { pacote: null, oaes: new Map() };

async function carregarPacote() {
  const p = await BD.ler("chaves", "pacote");
  Estado.pacote = p || null;
  Estado.oaes = new Map((p?.oaes || []).map(o => [o.id, o]));
}

function validarPacote(p) {
  if (!p || p.tipo !== "pacote-oaes-ulpalmas" || !Array.isArray(p.oaes) || !p.oaes.length)
    throw new Error("Arquivo não é um pacote de OAEs válido (gerado pelo exportar_app.py).");
  return p;
}

async function instalarPacote(p) {
  validarPacote(p);
  await BD.gravar("chaves", p, "pacote");
  await carregarPacote();
  avisar(`${p.oaes.length} OAEs carregadas (pacote de ${p.gerado_em}).`);
}

/* ---------- navegação ---------- */
let desligarGPS = null;
function cabecalho(titulo, subtitulo, voltar) {
  $("#titulo").textContent = titulo;
  $("#subtitulo").textContent = subtitulo || "";
  const b = $("#voltar");
  b.hidden = !voltar;
  b.onclick = voltar ? () => { location.hash = voltar; } : null;
}

async function rotear() {
  if (desligarGPS) { desligarGPS(); desligarGPS = null; }
  window.scrollTo(0, 0);
  const [rota, arg] = location.hash.replace(/^#\/?/, "").split("/");
  try {
    if (!Estado.pacote && rota !== "dados") return telaDados(true);
    if (rota === "nova") return telaNova();
    if (rota === "vistoria" && arg) return telaVistoria(decodeURIComponent(arg));
    if (rota === "roteiro" && arg) return telaRoteiro(decodeURIComponent(arg));
    if (rota === "foto" && arg) return telaFoto(decodeURIComponent(arg), Number(location.hash.split("/").pop()));
    if (rota === "dados") return telaDados(false);
    return telaInicio();
  } catch (e) {
    console.error(e);
    $("#tela").innerHTML = `<div class="cartao"><h3>Erro</h3><p>${esc(e.message)}</p></div>`;
  }
}

/* ---------- tela: dados das OAEs ---------- */
function telaDados(primeiroUso) {
  cabecalho("Dados das OAEs", "Pacote do cadastro", primeiroUso ? null : "#/");
  const p = Estado.pacote;
  $("#tela").innerHTML = `
    ${primeiroUso ? `<div class="cartao"><h3>Primeiro uso</h3>
      <p>Carregue o arquivo <b>oaes_ulpalmas.json</b> (gerado no computador pelo <code>exportar_app.py</code>).
      Depois disso o app funciona sem internet.</p></div>` : ""}
    ${p ? `<div class="cartao"><h3>Pacote atual</h3>
      <p>${p.oaes.length} OAEs · gerado em ${esc(p.gerado_em)}</p>
      <p class="suave">Carregar um pacote novo substitui os dados das OAEs. As vistorias já feitas não são apagadas.</p></div>` : ""}
    <div class="botoes">
      <label class="botao">Escolher arquivo do pacote
        <input id="arquivo" type="file" accept=".json,application/json" hidden></label>
      ${/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? `<button id="servidor" class="botao secundario">Carregar do servidor</button>` : ""}
    </div>
    ${primeiroUso ? `<p class="suave">Para levar o arquivo ao celular: WhatsApp, Google Drive ou cabo USB. No celular ele costuma ficar na pasta Downloads.</p>` : ""}`;
  $("#arquivo").onchange = async ev => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      await instalarPacote(JSON.parse(await f.text()));
      location.hash = "#/";
      rotear();
    } catch (e) { avisar(e.message, 6000); }
  };
  if ($("#servidor")) $("#servidor").onclick = async () => {
    try {
      const r = await fetch("dados/oaes_ulpalmas.json", { cache: "no-store" });
      if (!r.ok) throw new Error("Pacote não encontrado no servidor.");
      await instalarPacote(await r.json());
      location.hash = "#/";
      rotear();
    } catch (e) { avisar(e.message, 6000); }
  };
}

/* ---------- tela: início ---------- */
async function telaInicio() {
  cabecalho("Vistoria OAE", "UL Palmas · Consórcio Houer-Consane", null);
  const vs = (await BD.todos("vistorias")).sort((a, b) => (b.atualizado_em || "").localeCompare(a.atualizado_em || ""));
  const itens = vs.map(v => {
    const o = Estado.oaes.get(v.oae);
    return `<button class="lista-item" data-id="${esc(v.id)}">
      <div class="linha"><span class="nome">${esc(o ? `${o.item}. ${o.nome}` : v.oae)}</span>
        <span class="selo">${esc(v.tipo_inspecao)}</span></div>
      <div class="detalhe">${dataBR(v.data)} · ${v.fotos.length} foto(s) · ${v.avaliacao.length} elemento(s) avaliado(s)</div>
    </button>`;
  }).join("");
  $("#tela").innerHTML = `
    <div class="botoes"><a class="botao" href="#/nova">Nova vistoria</a></div>
    <h2>Vistorias neste celular</h2>
    ${itens || `<div class="vazio">Nenhuma vistoria ainda.</div>`}
    <h2>Dados</h2>
    <a class="lista-item" href="#/dados"><span class="nome">Dados das OAEs</span>
      <div class="detalhe">${Estado.oaes.size} OAEs · pacote de ${esc(Estado.pacote.gerado_em)}</div></a>
    <p class="suave" style="text-align:center">Versão ${VERSAO_APP}</p>`;
  $("#tela").querySelectorAll("[data-id]").forEach(b => b.onclick = () => { location.hash = `#/vistoria/${encodeURIComponent(b.dataset.id)}`; });
}

/* ---------- tela: nova vistoria ---------- */
function telaNova() {
  cabecalho("Nova vistoria", "Escolha a OAE", "#/");
  GPS.iniciar();
  $("#tela").innerHTML = `
    <div id="gps"></div>
    <input id="busca" type="search" placeholder="Buscar por nome, item, rodovia ou km" autocomplete="off">
    <h2 id="ordem">OAEs</h2>
    <div id="lista"></div>`;
  let filtro = "";
  const desenhar = () => {
    $("#gps").innerHTML = GPS.html();
    const pos = GPS.pos;
    let oaes = [...Estado.oaes.values()].map(o => ({ o, d: pos && o.lat ? distanciaM(pos.lat, pos.lon, o.lat, o.lon) : null }));
    if (filtro) {
      const f = filtro.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
      oaes = oaes.filter(({ o }) => `${o.item} ${o.nome} ${o.rodovia} ${o.km} ${num(o.km)} ${o.cidade}`
        .toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").includes(f));
    }
    oaes.sort((a, b) => a.d != null && b.d != null ? a.d - b.d : a.o.item - b.o.item);
    $("#ordem").textContent = pos ? "OAEs — mais próximas primeiro" : "OAEs — pela ordem do contrato";
    $("#lista").innerHTML = oaes.map(({ o, d }, k) => `
      <button class="lista-item" data-oae="${esc(o.id)}">
        <div class="linha"><span class="nome">${o.item}. ${esc(o.nome)}</span>
          ${d != null ? `<span class="selo ${k === 0 && d < 500 ? "ok" : ""}">${textoDist(d)}</span>` : ""}</div>
        <div class="detalhe">${esc(o.rodovia)} km ${num(o.km)} · ${esc(o.cidade || "")} · ${num(o.comprimento_m, 1)} m</div>
      </button>`).join("") || `<div class="vazio">Nenhuma OAE encontrada.</div>`;
    $("#lista").querySelectorAll("[data-oae]").forEach(b => b.onclick = () => formNova(b.dataset.oae));
  };
  $("#busca").oninput = ev => { filtro = ev.target.value.trim(); desenhar(); };
  desligarGPS = GPS.ouvir(() => { if (!filtro) desenhar(); else $("#gps").innerHTML = GPS.html(); });
  desenhar();
}

function formNova(oaeId) {
  const o = Estado.oaes.get(oaeId);
  cabecalho("Nova vistoria", `${o.item}. ${o.nome}`, "#/nova");
  if (desligarGPS) { desligarGPS(); desligarGPS = null; }
  $("#tela").innerHTML = `
    ${cartaoOAE(o)}
    <label class="campo"><span>Data da vistoria</span><input id="data" type="date" value="${hoje()}"></label>
    <div class="campo"><span>Tipo de inspeção</span>
      <div class="opcoes">
        <label><input type="radio" name="tipo" value="Rotineira" checked><span>Rotineira</span></label>
        <label><input type="radio" name="tipo" value="Cadastral"><span>Cadastral</span></label>
      </div>
      <p class="suave">Rotineira: ficha só com o Anexo B. Cadastral: Anexos A e B.</p>
    </div>
    <label class="campo"><span>Equipe (opcional)</span><input id="equipe" type="text" placeholder="Nomes de quem está na vistoria"></label>
    <div class="botoes"><button id="iniciar" class="botao">Iniciar vistoria</button></div>`;
  $("#iniciar").onclick = async () => {
    const data = $("#data").value;
    if (!data) return avisar("Informe a data da vistoria.");
    const existentes = new Set((await BD.todos("vistorias")).map(v => v.id));
    let id = `${o.id}_${data}`, n = 2;
    while (existentes.has(id)) id = `${o.id}_${data}_${n++}`;
    const agora = new Date().toISOString();
    const v = {
      id, oae: o.id, data, tipo_inspecao: $("input[name=tipo]:checked").value,
      equipe: $("#equipe").value.trim(), pasta_fotos: null,
      fotos: [], avaliacao: [], aspectos_especiais: "", deficiencias_funcionais: [],
      observacao_anexo_b: "", observacoes: "", laudo: "",
      origem: `app de campo v${VERSAO_APP}`, criado_em: agora, atualizado_em: agora,
    };
    await BD.gravar("vistorias", v);
    if (navigator.storage?.persist) navigator.storage.persist();   // evita que o sistema apague os dados
    location.hash = `#/vistoria/${encodeURIComponent(id)}`;
  };
}

function cartaoOAE(o, dist) {
  const tramos = o.tramos.map(t => num(t.extensao_m, 2)).join(" · ");
  return `<div class="cartao">
    <h3>${o.item}. ${esc(o.nome)}</h3>
    <p class="suave">${esc(o.rodovia)} km ${num(o.km)} · ${esc(o.cidade || "")}${o.codigo_sge ? ` · SGE ${esc(o.codigo_sge)}` : ""}</p>
    <div class="dados-oae">
      <div><b>Comprimento</b>${num(o.comprimento_m, 2)} m</div>
      <div><b>Largura</b>${num(o.largura_m, 2)} m</div>
      <div><b>Tramos</b>${o.tramos.length}${o.extensao_estimada ? " (extensões estimadas)" : ""}</div>
      <div><b>Elementos</b>${o.elementos.length}</div>
      <div style="grid-column:1/-1"><b>Extensões (m)</b>${tramos}</div>
      ${dist != null ? `<div style="grid-column:1/-1"><b>Distância até a OAE</b>${textoDist(dist)}</div>` : ""}
    </div></div>`;
}

/* ---------- tela: vistoria (etapas) ---------- */
async function telaVistoria(id) {
  const v = await BD.ler("vistorias", id);
  if (!v) { avisar("Vistoria não encontrada."); location.hash = "#/"; return; }
  const o = Estado.oaes.get(v.oae);
  if (!o) { $("#tela").innerHTML = `<div class="cartao"><p>A OAE ${esc(v.oae)} não está no pacote de dados atual.</p></div>`; return; }
  cabecalho(`${o.item}. ${o.nome}`, `${v.tipo_inspecao} · ${dataBR(v.data)}`, "#/");
  GPS.iniciar();
  const st = v.roteiro_status || {};
  const feitas = o.roteiro.filter(r => st[r.n]).length;
  const etapas = [
    ["Roteiro de fotos", `${feitas} de ${o.roteiro.length} fotos padrão do protocolo`, null, `#/roteiro/${encodeURIComponent(v.id)}`],
    ["Fotos de dano", "Fotos extras vinculadas ao elemento", "parte 3"],
    ["Avaliação dos elementos", `${o.elementos.length} elementos · nota e danos`, "parte 4"],
    ["Textos e laudo", "Aspectos especiais, deficiências, observações e laudo", "parte 5"],
    ["Exportar", "Pacote para o computador (JSON + fotos)", "parte 6"],
  ];
  const desenhar = () => {
    const d = GPS.pos && o.lat ? distanciaM(GPS.pos.lat, GPS.pos.lon, o.lat, o.lon) : null;
    $("#tela").innerHTML = `
      ${cartaoOAE(o, d)}
      ${GPS.html()}
      ${d != null && d > 500 ? `<div class="cartao" style="border-color:var(--alerta)"><p><b>Atenção:</b> você está a ${textoDist(d)} da coordenada cadastrada desta OAE. Confira se é a OAE certa.</p></div>` : ""}
      <h2>Etapas da vistoria</h2>
      ${etapas.map(([t, s, parte, link], k) => link ? `
        <a class="cartao etapa lista-item" href="${link}"><span class="num">${k + 1}</span>
          <div class="texto"><strong>${t}</strong><div class="suave">${s}</div></div>
          <span class="selo ${feitas === o.roteiro.length ? "ok" : ""}">${feitas === o.roteiro.length ? "concluído" : "abrir ›"}</span></a>` : `
        <div class="cartao etapa futura"><span class="num">${k + 1}</span>
          <div class="texto"><strong>${t}</strong><div class="suave">${s}</div></div>
          <span class="selo alerta">${parte}</span></div>`).join("")}
      <div class="botoes">
        <button id="baixar" class="botao secundario">Baixar JSON da vistoria (teste)</button>
        <button id="excluir" class="botao perigo">Excluir vistoria</button>
      </div>`;
    $("#baixar").onclick = () => baixarJSON(v);
    $("#excluir").onclick = async () => {
      if (!confirm("Excluir esta vistoria do celular, com todas as fotos? Isso não pode ser desfeito.")) return;
      for (const f of await BD.todos("fotos")) if (f.vistoria === v.id) await BD.apagar("fotos", f.id);
      await BD.apagar("vistorias", v.id);
      avisar("Vistoria excluída.");
      location.hash = "#/";
    };
  };
  desligarGPS = GPS.ouvir(desenhar);
  desenhar();
}

function baixarJSON(v) {
  const { id, criado_em, atualizado_em, ...saida } = v;
  const blob = new Blob([JSON.stringify(saida, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${v.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- bússola: azimute para onde aponta a câmera traseira ---------- */
const Bussola = {
  azimute: null, confiavel: false, _ok: false,
  iniciar() {
    if (this._ok) return;
    this._ok = true;
    const tratar = (e, absoluto) => {
      if (e.alpha == null) return;
      const r = Math.PI / 180, a = e.alpha * r, b = (e.beta || 0) * r, g = (e.gamma || 0) * r;
      // vetor da câmera traseira (-Z do aparelho) no referencial Leste-Norte-Cima
      const vx = -(Math.cos(a) * Math.sin(g) + Math.cos(g) * Math.sin(a) * Math.sin(b));
      const vy = -(Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.cos(g) * Math.sin(b));
      if (Math.hypot(vx, vy) < 0.3) { this.confiavel = false; return; }   // celular deitado: câmera para baixo
      this.azimute = (Math.atan2(vx, vy) / r + 360) % 360;
      this.confiavel = absoluto;
    };
    if ("ondeviceorientationabsolute" in window) window.addEventListener("deviceorientationabsolute", e => tratar(e, true));
    else window.addEventListener("deviceorientation", e => tratar(e, !!e.absolute));
  },
};
const rumo = az => az == null ? "" : `${Math.round(az)}° ${["N", "NE", "L", "SE", "S", "SO", "O", "NO"][Math.round(az / 45) % 8]}`;

/* coordenada no padrão dos relatórios: 9°48'33,030" S */
function dms(graus, eixo) {
  const h = eixo === "lat" ? (graus < 0 ? "S" : "N") : (graus < 0 ? "W" : "E");
  const g = Math.abs(graus), gi = Math.floor(g);
  let m = Math.floor((g - gi) * 60), s = (g - gi - m / 60) * 3600;
  if (Math.round(s * 1000) / 1000 >= 60) { m += 1; s = 0; }
  return `${gi}°${m}'${s.toFixed(3).padStart(6, "0").replace(".", ",")}" ${h}`;
}

async function posicaoAgora() {
  if (GPS.pos && Date.now() - GPS.pos.t < 20000) return GPS.pos;
  return new Promise(ok => navigator.geolocation ? navigator.geolocation.getCurrentPosition(
    p => ok({ lat: p.coords.latitude, lon: p.coords.longitude, prec: p.coords.accuracy, t: p.timestamp }),
    () => ok(GPS.pos || null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 }) : ok(null));
}

async function miniatura(blob, lado = 320) {
  const img = await createImageBitmap(blob);
  const k = lado / Math.max(img.width, img.height);
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}

const DIRECAO = { 0: "no sentido crescente", 90: "para o lado LD", 180: "no sentido decrescente", 270: "para o lado LE" };
function textoPosicao(r, L) {
  const lado = r.y < 0 ? "fora do tabuleiro, do lado LE" : r.y > 1 ? "fora do tabuleiro, do lado LD"
    : r.y < 0.3 ? "junto ao lado LE" : r.y > 0.7 ? "junto ao lado LD" : "no eixo";
  const onde = r.x < 0 ? `${num(-r.x, 0)} m antes do Encontro 01` : r.x > L ? `${num(r.x - L, 0)} m depois do Encontro 02`
    : `a ${num(r.x, 0)} m do Encontro 01`;
  return `${onde}, ${lado}`;
}

/* mini-croqui: LE em cima, LD embaixo, sentido crescente para a direita (mesma convenção do croqui.py) */
function miniCroqui(o, roteiro, atual, status) {
  const ext = o.tramos.map(t => t.extensao_m || 0), L = ext.reduce((a, b) => a + b, 0) || o.comprimento_m || 10;
  const W = 340, H = 165, m = 22, x0 = m + 18, x1 = W - m - 18, yt = 50, yb = 116;
  const xmin = Math.min(-12, ...roteiro.map(r => r.x)), xmax = Math.max(L + 12, ...roteiro.map(r => r.x));
  const px = x => x0 + (x - xmin) / (xmax - xmin) * (x1 - x0), py = y => yt + (yb - yt) * y;
  let apoios = "", acum = 0;
  ext.slice(0, -1).forEach(e => { acum += e; apoios += `<line x1="${px(acum)}" y1="${yt}" x2="${px(acum)}" y2="${yb}" stroke="#8a94a3" stroke-dasharray="3 3"/>`; });
  const seta = (r, cor, larg, comp) => {
    if (r.direcao == null) return "";
    const a = r.direcao * Math.PI / 180, cx = px(r.x), cy = py(r.y), ex = cx + comp * Math.cos(a), ey = cy + comp * Math.sin(a);
    const h = 7, b1 = a + Math.PI * 0.82, b2 = a - Math.PI * 0.82;
    return `<line x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}" stroke="${cor}" stroke-width="${larg}"/>
      <polygon points="${ex},${ey} ${ex + h * Math.cos(b1)},${ey + h * Math.sin(b1)} ${ex + h * Math.cos(b2)},${ey + h * Math.sin(b2)}" fill="${cor}"/>`;
  };
  const pontos = roteiro.filter(r => r.n !== atual.n).map(r =>
    `<circle cx="${px(r.x)}" cy="${py(r.y)}" r="3.5" fill="${status[r.n] ? "#1d7a3e" : "#c3cad4"}"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Posição da foto no croqui da OAE" style="background:#fff;border:1px solid var(--borda);border-radius:10px">
    <text x="${W / 2}" y="18" text-anchor="middle" font-size="11" fill="#5a6472">sentido crescente →</text>
    <rect x="${px(0)}" y="${yt}" width="${px(L) - px(0)}" height="${yb - yt}" fill="#eef2f7" stroke="#14181f"/>
    ${apoios}
    <text x="${px(0) - 4}" y="${yt - 6}" font-size="10" text-anchor="end" fill="#5a6472">E1</text>
    <text x="${px(L) + 4}" y="${yt - 6}" font-size="10" fill="#5a6472">E2</text>
    <text x="8" y="${yt + 4}" font-size="11" font-weight="700" fill="#5a6472">LE</text>
    <text x="8" y="${yb + 4}" font-size="11" font-weight="700" fill="#5a6472">LD</text>
    ${pontos}
    <circle cx="${px(atual.x)}" cy="${py(atual.y)}" r="6" fill="#b42318"/>
    ${seta(atual, "#b42318", 3, 34)}
  </svg>`;
}

/* ---------- tela: roteiro de fotos ---------- */
async function telaRoteiro(vid) {
  const v = await BD.ler("vistorias", vid);
  const o = v && Estado.oaes.get(v.oae);
  if (!o) { location.hash = "#/"; return; }
  cabecalho("Roteiro de fotos", `${o.item}. ${o.nome}`, `#/vistoria/${encodeURIComponent(vid)}`);
  GPS.iniciar();
  const st = v.roteiro_status || {};
  const fotos = new Map((await BD.todos("fotos")).filter(f => f.vistoria === vid).map(f => [f.roteiro, f]));
  const feitas = o.roteiro.filter(r => st[r.n]).length;
  let grupo = null, html = "";
  for (const r of o.roteiro) {
    if (r.grupo !== grupo) { grupo = r.grupo; html += `<h2>${esc(grupo)}</h2>`; }
    const f = fotos.get(r.n), s = st[r.n];
    html += `<a class="lista-item linha" href="#/foto/${encodeURIComponent(vid)}/${r.n}" style="align-items:center">
      ${f ? `<img src="${f.miniatura}" alt="" style="width:64px;height:48px;object-fit:cover;border-radius:6px;flex:none">`
          : `<span style="width:64px;height:48px;border-radius:6px;flex:none;display:grid;place-items:center;background:#eef2f7;color:#5a6472;font-weight:700">R${String(r.n).padStart(2, "0")}</span>`}
      <span style="flex:1;min-width:0"><span class="nome" style="font-size:.92rem">${esc(r.legenda)}</span>
        <span class="detalhe" style="display:block">${DIRECAO[r.direcao] || ""}${r.elemento ? ` · ${esc(r.elemento)}` : ""}</span></span>
      <span class="selo ${s === "feita" ? "ok" : s === "pulada" ? "alerta" : ""}">${s === "feita" ? "✓" : s === "pulada" ? "n/a" : "›"}</span></a>`;
  }
  const prox = o.roteiro.find(r => !st[r.n]);
  $("#tela").innerHTML = `
    <div class="cartao"><div class="linha"><strong>${feitas} de ${o.roteiro.length} fotos</strong>
      <span class="suave">${o.roteiro.length - feitas} pendente(s)</span></div>
      <div style="height:8px;background:#e5e9ef;border-radius:4px;margin-top:8px"><div style="height:8px;border-radius:4px;background:var(--ok);width:${Math.round(100 * feitas / o.roteiro.length)}%"></div></div></div>
    ${prox ? `<div class="botoes"><a class="botao" href="#/foto/${encodeURIComponent(vid)}/${prox.n}">Próxima pendente: R${String(prox.n).padStart(2, "0")}</a></div>` : ""}
    ${html}`;
}

/* ---------- tela: uma foto do roteiro ---------- */
async function telaFoto(vid, n) {
  const v = await BD.ler("vistorias", vid);
  const o = v && Estado.oaes.get(v.oae);
  const r = o && o.roteiro.find(x => x.n === n);
  if (!r) { location.hash = `#/roteiro/${encodeURIComponent(vid)}`; return; }
  const L = o.tramos.reduce((a, t) => a + (t.extensao_m || 0), 0) || o.comprimento_m;
  const idFoto = `${vid}#R${n}`;
  const st = v.roteiro_status || {};
  cabecalho(`R${String(n).padStart(2, "0")} · ${r.grupo}`, `${o.item}. ${o.nome}`, `#/roteiro/${encodeURIComponent(vid)}`);
  GPS.iniciar();
  Bussola.iniciar();
  const foto = await BD.ler("fotos", idFoto);
  const reg = v.fotos.find(f => f.roteiro === n);
  const i = o.roteiro.indexOf(r), ant = o.roteiro[i - 1], prox = o.roteiro[i + 1];
  const url = foto ? URL.createObjectURL(foto.blob) : null;
  $("#tela").innerHTML = `
    <div class="cartao">
      <h3>${esc(r.legenda)}</h3>
      <p><b>Onde ficar:</b> ${textoPosicao(r, L)}.</p>
      <p><b>Para onde apontar:</b> ${DIRECAO[r.direcao] || "—"}${r.elemento ? ` · elemento <b>${esc(r.elemento)}</b>` : ""}.</p>
      ${miniCroqui(o, o.roteiro, r, st)}
    </div>
    <div id="gps"></div>
    ${foto ? `<div class="cartao"><img src="${url}" alt="Foto R${n}" style="width:100%;border-radius:8px">
      <p class="suave">${reg ? `${esc(reg.data_hora.replace("T", " ").slice(0, 16))} · ${esc(reg.carimbo.lat)} ${esc(reg.carimbo.lon)} · GPS ±${Math.round(reg.precisao_gps)} m${reg.azimute != null ? ` · bússola ${rumo(reg.azimute)}` : ""}` : ""}</p></div>` : ""}
    ${st[n] === "pulada" ? `<div class="cartao" style="border-color:var(--alerta)"><b>Marcada como não se aplica:</b> ${esc((v.roteiro_motivos || {})[n] || "")}</div>` : ""}
    <div class="botoes">
      <label class="botao">${foto ? "Refazer foto" : "Tirar foto"}
        <input id="camera" type="file" accept="image/*" capture="environment" hidden></label>
    </div>
    <label class="campo"><span>Observação (opcional)</span>
      <textarea id="obs" rows="2" placeholder="Ex.: acesso difícil, foto tirada pelo LE">${esc(reg?.obs || "")}</textarea></label>
    <div class="botoes">
      ${st[n] !== "pulada" && !foto ? `<button id="pular" class="botao secundario">Não se aplica nesta OAE</button>` : ""}
      <div class="opcoes">
        <button class="botao secundario" ${ant ? "" : "disabled"} onclick="location.hash='#/foto/${encodeURIComponent(vid)}/${ant ? ant.n : n}'">‹ Anterior</button>
        <button class="botao secundario" ${prox ? "" : "disabled"} onclick="location.hash='#/foto/${encodeURIComponent(vid)}/${prox ? prox.n : n}'">Próxima ›</button>
      </div>
    </div>`;
  const desenharGPS = () => { $("#gps").innerHTML = GPS.html() + (Bussola.azimute != null ? `<div class="gps"><span class="ponto" style="background:${Bussola.confiavel ? "var(--ok)" : "var(--alerta)"}"></span>Bússola: câmera apontando para ${rumo(Bussola.azimute)}</div>` : ""); };
  desligarGPS = GPS.ouvir(desenharGPS);
  desenharGPS();
  const intervalo = setInterval(() => { if (!document.body.contains($("#gps"))) return clearInterval(intervalo); desenharGPS(); }, 1500);

  $("#obs").onchange = async ev => {
    const vv = await BD.ler("vistorias", vid);
    const rr = vv.fotos.find(f => f.roteiro === n);
    if (rr) { rr.obs = ev.target.value.trim(); vv.atualizado_em = new Date().toISOString(); await BD.gravar("vistorias", vv); }
  };
  const pular = $("#pular");
  if (pular) pular.onclick = async () => {
    const motivo = prompt("Por que esta foto não se aplica? (ex.: OAE sem juntas, acesso impossível)");
    if (motivo === null) return;
    const vv = await BD.ler("vistorias", vid);
    vv.roteiro_status = { ...(vv.roteiro_status || {}), [n]: "pulada" };
    vv.roteiro_motivos = { ...(vv.roteiro_motivos || {}), [n]: motivo.trim() };
    vv.atualizado_em = new Date().toISOString();
    await BD.gravar("vistorias", vv);
    location.hash = prox ? `#/foto/${encodeURIComponent(vid)}/${prox.n}` : `#/roteiro/${encodeURIComponent(vid)}`;
  };
  $("#camera").onchange = async ev => {
    const arq = ev.target.files[0];
    if (!arq) return;
    avisar("Salvando a foto…", 1500);
    const azimute = Bussola.azimute, bussolaOk = Bussola.confiavel;
    const pos = await posicaoAgora();
    const vv = await BD.ler("vistorias", vid);
    const agora = new Date(); agora.setMinutes(agora.getMinutes() - agora.getTimezoneOffset());
    const nomeArq = `R${String(n).padStart(2, "0")}_${vv.oae}_${vv.data}.jpg`;
    await BD.gravar("fotos", { id: idFoto, vistoria: vid, roteiro: n, blob: arq, tipo: arq.type, miniatura: await miniatura(arq), criado_em: new Date().toISOString() });
    const registro = {
      n, roteiro: n, arquivo: nomeArq, legenda: r.legenda, x: r.x, y: r.y, direcao: r.direcao, elemento: r.elemento || null,
      lat: pos ? pos.lat : null, lon: pos ? pos.lon : null, precisao_gps: pos ? pos.prec : null,
      carimbo: pos ? { lat: dms(pos.lat, "lat"), lon: dms(pos.lon, "lon") } : null,
      azimute: azimute != null ? Math.round(azimute) : null, bussola_confiavel: bussolaOk,
      data_hora: agora.toISOString().slice(0, 19), obs: $("#obs").value.trim(),
    };
    vv.fotos = [...vv.fotos.filter(f => f.roteiro !== n), registro].sort((a, b) => (a.roteiro ?? 999) - (b.roteiro ?? 999));
    vv.roteiro_status = { ...(vv.roteiro_status || {}), [n]: "feita" };
    if (vv.roteiro_motivos) delete vv.roteiro_motivos[n];
    vv.atualizado_em = new Date().toISOString();
    await BD.gravar("vistorias", vv);
    if (!pos) avisar("Foto salva, mas sem GPS. Confira a localização do celular.", 5000);
    else if (pos.prec > 30) avisar(`Foto salva com GPS fraco (±${Math.round(pos.prec)} m).`, 4000);
    else avisar("Foto salva.", 1500);
    location.hash = prox ? `#/foto/${encodeURIComponent(vid)}/${prox.n}` : `#/roteiro/${encodeURIComponent(vid)}`;
  };
}

/* ---------- instalação e modo offline ---------- */
let pedidoInstalar = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  pedidoInstalar = e;
  $("#instalar").hidden = false;
});
$("#instalar").onclick = async () => {
  if (!pedidoInstalar) return;
  pedidoInstalar.prompt();
  await pedidoInstalar.userChoice;
  pedidoInstalar = null;
  $("#instalar").hidden = true;
};
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(e => console.warn("service worker:", e));
}

/* ---------- início ---------- */
window.addEventListener("hashchange", rotear);
carregarPacote().then(rotear).catch(e => {
  $("#tela").innerHTML = `<div class="cartao"><h3>Não foi possível abrir o armazenamento</h3><p>${esc(e.message)}</p></div>`;
});
