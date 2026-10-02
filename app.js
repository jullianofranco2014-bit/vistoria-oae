/* App de campo — Vistoria de OAE (UL Palmas).
 * Funciona sem internet: dados das OAEs e vistorias ficam no próprio celular (IndexedDB).
 * A vistoria é exportada no formato JSON lido pelo gerar.py (ficha, relatório fotográfico e croqui).
 *
 * Parte 1: dados das OAEs, escolha da OAE (mais próxima pelo GPS), abertura da vistoria e tela de etapas.
 * Parte 2: roteiro de fotos — câmera do celular, GPS, bússola e posição no mini-croqui.
 * Parte 3: fotos de dano — vinculadas a um elemento, com posição e direção marcadas no croqui; tiradas da
 *          própria foto do roteiro ("+ Dano aqui") ou avulsas. No relatório, cada foto de dano vem logo depois
 *          da foto do roteiro em que foi tirada; as avulsas vão para o fim.
 */
"use strict";

const VERSAO_APP = "0.3.1";

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
const pad = n => String(n).padStart(2, "0");
const enc = encodeURIComponent;

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
  const partes = location.hash.replace(/^#\/?/, "").split("/");
  const [rota, arg] = partes;
  try {
    if (!Estado.pacote && rota !== "dados") return telaDados(true);
    if (rota === "nova") return telaNova();
    if (rota === "vistoria" && arg) return telaVistoria(decodeURIComponent(arg));
    if (rota === "roteiro" && arg) return telaRoteiro(decodeURIComponent(arg));
    if (rota === "foto" && arg) return telaFoto(decodeURIComponent(arg), Number(partes[2]));
    if (rota === "danos" && arg) return telaDanos(decodeURIComponent(arg));
    // #/dano/<vistoria>/<nº do dano ou "novo">[/<foto do roteiro em que foi visto>]
    if (rota === "dano" && arg) return telaDano(decodeURIComponent(arg), partes[2], partes[3] ? Number(partes[3]) : null);
    // #/extra/<vistoria>/novo[/<foto do roteiro>]: foto extra (vista complementar, sem dano)
    if (rota === "extra" && arg) return telaDano(decodeURIComponent(arg), "novo", partes[3] ? Number(partes[3]) : null, true);
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
  const nExtras = v.fotos.filter(f => f.dano && ehExtra(f)).length, nDanos = v.fotos.filter(f => f.dano).length - nExtras;
  // [título, texto, parte futura, link, selo, selo ok?]
  const etapas = [
    ["Roteiro de fotos", `${feitas} de ${o.roteiro.length} fotos padrão do protocolo`, null, `#/roteiro/${enc(v.id)}`,
      feitas === o.roteiro.length ? "concluído" : "abrir ›", feitas === o.roteiro.length],
    ["Fotos de dano e extras", `${nDanos} de dano · ${nExtras} extra(s)`, null, `#/danos/${enc(v.id)}`, "abrir ›", false],
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
      ${etapas.map(([t, s, parte, link, selo, ok], k) => link ? `
        <a class="cartao etapa lista-item" href="${link}"><span class="num">${k + 1}</span>
          <div class="texto"><strong>${t}</strong><div class="suave">${s}</div></div>
          <span class="selo ${ok ? "ok" : ""}">${selo}</span></a>` : `
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
  const onde = Math.abs(r.x) < 0.5 ? "no início do tabuleiro, junto ao Encontro 01"
    : Math.abs(r.x - L) < 0.5 ? "no fim do tabuleiro, junto ao Encontro 02"
    : r.x < 0 ? `${num(-r.x, 0)} m antes do Encontro 01` : r.x > L ? `${num(r.x - L, 0)} m depois do Encontro 02`
    : `a ${num(r.x, 0)} m do Encontro 01`;
  return `${onde}, ${lado}`;
}

/* mini-croqui: LE em cima, LD embaixo, sentido crescente para a direita (mesma convenção do croqui.py).
 * geoCroqui: escala do desenho (px/py: metros e fração da largura -> tela; ix/iy: o inverso, para o toque). */
function geoCroqui(o, pontos, { H = 165, yt = 50, yb = 116 } = {}) {
  const ext = o.tramos.map(t => t.extensao_m || 0), L = ext.reduce((a, b) => a + b, 0) || o.comprimento_m || 10;
  const W = 340, x0 = 40, x1 = W - 40;
  const xs = pontos.map(r => r.x).filter(x => x != null);
  const xmin = Math.min(-12, ...xs), xmax = Math.max(L + 12, ...xs);
  return {
    ext, L, W, H, yt, yb,
    px: x => x0 + (x - xmin) / (xmax - xmin) * (x1 - x0), py: y => yt + (yb - yt) * y,
    ix: X => xmin + (X - x0) / (x1 - x0) * (xmax - xmin), iy: Y => (Y - yt) / (yb - yt),
  };
}

function fundoCroqui(g) {
  let apoios = "", acum = 0;
  g.ext.slice(0, -1).forEach(e => { acum += e; apoios += `<line x1="${g.px(acum)}" y1="${g.yt}" x2="${g.px(acum)}" y2="${g.yb}" stroke="#8a94a3" stroke-dasharray="3 3"/>`; });
  return `<text x="${g.W / 2}" y="18" text-anchor="middle" font-size="11" fill="#5a6472">sentido crescente →</text>
    <rect x="${g.px(0)}" y="${g.yt}" width="${g.px(g.L) - g.px(0)}" height="${g.yb - g.yt}" fill="#eef2f7" stroke="#14181f"/>
    ${apoios}
    <text x="${g.px(0) - 4}" y="${g.yt - 6}" font-size="10" text-anchor="end" fill="#5a6472">E1</text>
    <text x="${g.px(g.L) + 4}" y="${g.yt - 6}" font-size="10" fill="#5a6472">E2</text>
    <text x="8" y="${g.yt + 4}" font-size="11" font-weight="700" fill="#5a6472">LE</text>
    <text x="8" y="${g.yb + 4}" font-size="11" font-weight="700" fill="#5a6472">LD</text>`;
}

/* foto: ponto + seta de ponta cheia (mesmo símbolo do croqui da ficha); sem direção, só o ponto vazado */
function marcaFoto(g, r, cor) {
  const cx = g.px(r.x), cy = g.py(r.y);
  if (r.direcao == null) return `<circle cx="${cx}" cy="${cy}" r="5" fill="#fff" stroke="${cor}" stroke-width="2.5"/>`;
  const a = r.direcao * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const p = (u, v) => `${cx + u * c - v * s},${cy + u * s + v * c}`;
  return `<line x1="${cx}" y1="${cy}" x2="${cx + 24 * c}" y2="${cy + 24 * s}" stroke="${cor}" stroke-width="3"/>
    <polygon points="${p(34, 0)} ${p(22, -6)} ${p(22, 6)}" fill="${cor}"/>
    <circle cx="${cx}" cy="${cy}" r="5" fill="${cor}"/>`;
}

function miniCroqui(o, roteiro, atual, status) {
  const g = geoCroqui(o, roteiro);
  const pontos = roteiro.filter(r => r.n !== atual.n).map(r =>
    `<circle cx="${g.px(r.x)}" cy="${g.py(r.y)}" r="3.5" fill="${status[r.n] ? "#1d7a3e" : "#c3cad4"}"/>`).join("");
  return `<svg viewBox="0 0 ${g.W} ${g.H}" width="100%" role="img" aria-label="Posição da foto no croqui da OAE" style="background:#fff;border:1px solid var(--borda);border-radius:10px">
    ${fundoCroqui(g)}
    ${pontos}
    ${marcaFoto(g, atual, "#b42318")}
  </svg>`;
}

/* numeração das fotos no relatório: a ordem do roteiro, cada foto de dano logo depois da foto do roteiro em que
 * foi tirada (na ordem em que foram tiradas) e as fotos de dano avulsas no fim */
function renumerar(v, o) {
  const ordem = new Map(o.roteiro.map((r, i) => [r.n, i]));
  const chave = f => f.roteiro != null ? [ordem.get(f.roteiro) ?? 1e4, 0, 0]
    : [f.perto_de != null ? ordem.get(f.perto_de) ?? 1e4 : 1e5, 1, f.dano || 0];
  v.fotos.sort((a, b) => { const p = chave(a), q = chave(b); return p[0] - q[0] || p[1] - q[1] || p[2] - q[2]; });
  v.fotos.forEach((f, i) => { f.n = i + 1; });
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
    const aqui = v.fotos.filter(x => x.dano && x.perto_de === r.n), nx = aqui.filter(ehExtra).length, nd = aqui.length - nx;
    html += `<a class="lista-item linha" href="#/foto/${encodeURIComponent(vid)}/${r.n}" style="align-items:center">
      ${f ? `<img src="${f.miniatura}" alt="" style="width:64px;height:48px;object-fit:cover;border-radius:6px;flex:none">`
          : `<span style="width:64px;height:48px;border-radius:6px;flex:none;display:grid;place-items:center;background:#eef2f7;color:#5a6472;font-weight:700">R${String(r.n).padStart(2, "0")}</span>`}
      <span style="flex:1;min-width:0"><span class="nome" style="font-size:.92rem">${esc(r.legenda)}</span>
        <span class="detalhe" style="display:block">${DIRECAO[r.direcao] || ""}${r.elemento ? ` · ${esc(r.elemento)}` : ""}${nd ? ` · <b style="color:var(--erro)">${nd} dano(s)</b>` : ""}${nx ? ` · ${nx} extra(s)` : ""}</span></span>
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
  // danos vistos nesta foto do roteiro (tirados pelo "+ Dano aqui")
  const danosAqui = v.fotos.filter(f => f.dano && f.perto_de === n);
  const minisDano = await Promise.all(danosAqui.map(d => BD.ler("fotos", `${vid}#D${d.dano}`)));
  $("#tela").innerHTML = `
    <div class="cartao">
      <h3>${esc(r.legenda)}</h3>
      <p><b>Onde ficar:</b> ${textoPosicao(r, L)}.</p>
      <p><b>Para onde apontar:</b> ${DIRECAO[r.direcao] || "—"}${r.elemento ? ` · elemento <b>${esc(r.elemento)}</b>` : ""}.</p>
      ${miniCroqui(o, o.roteiro, r, st)}
    </div>
    <div id="gps"></div>
    ${foto ? `<div class="cartao"><img src="${url}" alt="Foto R${n}" style="width:100%;border-radius:8px">
      <p class="suave">${reg ? `${esc(reg.data_hora.replace("T", " ").slice(0, 16))} · ${reg.carimbo
        ? `${esc(reg.carimbo.lat)} ${esc(reg.carimbo.lon)} · GPS ±${Math.round(reg.precisao_gps)} m`
        : `<span style="color:var(--alerta)">sem GPS — refaça a foto com a localização ligada</span>`}${reg.azimute != null ? ` · bússola ${rumo(reg.azimute)}` : ""}` : ""}</p></div>` : ""}
    ${st[n] === "pulada" ? `<div class="cartao" style="border-color:var(--alerta)"><b>Marcada como não se aplica:</b> ${esc((v.roteiro_motivos || {})[n] || "")}</div>` : ""}
    <div class="botoes">
      <label class="botao ${foto ? "secundario" : ""}">${foto ? "Refazer foto" : "Tirar foto"}
        <input id="camera" type="file" accept="image/*" capture="environment" hidden></label>
      <div class="opcoes">
        <a class="botao secundario" style="border-color:var(--erro);color:var(--erro)" href="#/dano/${enc(vid)}/novo/${n}">+ Dano aqui</a>
        <a class="botao secundario" href="#/extra/${enc(vid)}/novo/${n}">+ Foto extra aqui</a>
      </div>
    </div>
    ${danosAqui.length ? `<h2>Danos e fotos extras desta foto</h2>${danosAqui.map((d, j) => `
      <a class="lista-item linha" href="#/dano/${enc(vid)}/${d.dano}" style="align-items:center">
        <img src="${minisDano[j]?.miniatura || ""}" alt="" style="width:64px;height:48px;object-fit:cover;border-radius:6px;flex:none">
        <span style="flex:1;min-width:0"><span class="nome" style="font-size:.9rem">F${pad(d.n)} · ${esc(d.legenda || "(sem legenda)")}</span></span>
        <span class="selo">editar</span></a>`).join("")}` : ""}
    <label class="campo"><span>Observação (opcional)</span>
      <textarea id="obs" rows="2" placeholder="Ex.: acesso difícil, foto tirada pelo LE">${esc(reg?.obs || "")}</textarea></label>
    <div class="botoes">
      ${st[n] !== "pulada" && !foto ? `<button id="pular" class="botao secundario">Não se aplica nesta OAE</button>` : ""}
      ${foto ? `<a class="botao" href="${prox ? `#/foto/${enc(vid)}/${prox.n}` : `#/roteiro/${enc(vid)}`}">${prox ? `Próxima foto: R${pad(prox.n)} ›` : "Voltar ao roteiro"}</a>` : ""}
      ${foto ? `<button id="excluir-foto" class="botao perigo">Excluir esta foto</button>` : ""}
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
  // foto tirada por engano: apaga e a foto do roteiro volta a ficar pendente (os danos ligados a ela ficam)
  const excluirFoto = $("#excluir-foto");
  if (excluirFoto) excluirFoto.onclick = async () => {
    if (!confirm(`Excluir a foto R${pad(n)}? Ela volta a ficar pendente no roteiro.`)) return;
    await BD.apagar("fotos", idFoto);
    const vv = await BD.ler("vistorias", vid);
    vv.fotos = vv.fotos.filter(f => f.roteiro !== n);
    if (vv.roteiro_status) delete vv.roteiro_status[n];
    renumerar(vv, o);
    vv.atualizado_em = new Date().toISOString();
    await BD.gravar("vistorias", vv);
    avisar("Foto excluída.");
    rotear();
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
    vv.fotos = [...vv.fotos.filter(f => f.roteiro !== n), registro];
    renumerar(vv, o);
    vv.roteiro_status = { ...(vv.roteiro_status || {}), [n]: "feita" };
    if (vv.roteiro_motivos) delete vv.roteiro_motivos[n];
    vv.atualizado_em = new Date().toISOString();
    await BD.gravar("vistorias", vv);
    if (!pos) avisar("Foto salva, mas sem GPS. Confira a localização do celular.", 5000);
    else if (pos.prec > 30) avisar(`Foto salva com GPS fraco (±${Math.round(pos.prec)} m).`, 4000);
    else avisar("Foto salva.", 1500);
    // fica na mesma foto (para conferir e, se houver dano, usar o "+ Dano aqui"); "Próxima foto" segue o roteiro
    rotear();
  };
}

/* ---------- fotos de dano ---------- */
// tipos de dano por tipo de elemento (termos da planilha de patologias da equipe; o usuário pediu a lista filtrada
// pelo elemento escolhido, com "ver todos" e "outro dano" escrito à mão)
const CONCRETO = ["Fissuras", "Trincas", "Armadura exposta", "Corrosão de armadura", "Desagregação", "Desplacamento",
  "Lixiviação/eflorescência", "Infiltração/umidade", "Manchas", "Carbonatação", "Ninhos de concretagem", "Sujidade",
  "Vegetação", "Pichação"];
const DANOS_POR_TIPO = {
  concreto_super: [...CONCRETO, "Colisão"],
  concreto_meso: [...CONCRETO, "Colisão", "Erosão", "Solapamento/fundação exposta", "Recalque"],
  aparelho: ["Deformação excessiva", "Rasgos/fissuras no neoprene", "Deslocamento/fora de posição", "Ausência do aparelho",
    "Corrosão das chapas", "Sujidade/obstrução"],
  junta: ["Junta danificada", "Vedação ausente ou rompida", "Obstrução/acúmulo de detritos", "Degrau/desnível", "Infiltração/umidade"],
  pavimento: ["Desgaste", "Panelas/buracos", "Trincas", "Fissuras", "Remendos", "Afundamento", "Obstrução de drenos/buzinotes",
    "Acúmulo de água"],
  protecao: ["Guarda-corpo danificado", "Ausência de trechos", "Fissuras", "Armadura exposta", "Desagregação", "Desplacamento",
    "Corrosão", "Colisão", "Sujidade", "Vegetação", "Pichação"],
  acesso: ["Erosão", "Recalque/degrau na transição", "Defensa danificada/ausente", "Sinalização deficiente", "Trincas no pavimento",
    "Obstrução de drenagem", "Vegetação"],
  madeira: ["Apodrecimento", "Ataque de cupins/insetos", "Fissuras/rachaduras", "Peças soltas ou faltando", "Desgaste", "Umidade", "Fungos"],
  metalico: ["Corrosão", "Perda de seção", "Pintura deteriorada", "Deformação/amassamento", "Ligações/parafusos soltos", "Colisão", "Sujidade"],
};
const NOME_TIPO = { concreto_super: "superestrutura de concreto", concreto_meso: "meso/infraestrutura de concreto",
  aparelho: "aparelho de apoio", junta: "junta", pavimento: "pavimento", protecao: "guarda-corpo, barreira e calçada",
  acesso: "acesso/aterro", madeira: "madeira", metalico: "elemento metálico" };
const DANOS = [...new Set(Object.values(DANOS_POR_TIPO).flat())];   // todos ("ver todos")

/* tipo do elemento, pelo código e pela descrição da ficha */
function tipoElemento(e) {
  const c = e.elemento.replace(/\d.*$/, ""), d = (e.detalhe || "").toUpperCase();
  if (/MADEIRA/.test(d)) return "madeira";
  if (/^J$/.test(c) || /JUNTA/.test(d)) return "junta";
  if (/^N$/.test(c) || /NEOPRENE|APARELHO/.test(d)) return "aparelho";
  if (/^PV$/.test(c) || /PAVIMENTO/.test(d)) return "pavimento";
  if (/GUARDA|NEW JERSEY|BARREIRA|CAL[ÇC]ADA|PASSARELA|RODEIRO|DEFENSA/.test(d) || /^(G|GC|GR|BR|NJ|CC|PP)$/.test(c)) return "protecao";
  if (/ATERRO|ACESSO|TRANSI/.test(d) || e.regiao === "Transição") return "acesso";
  if (/MET[ÁA]LIC|\bA[ÇC]O\b/.test(d)) return "metalico";
  if (/^(P|VT|B|BL|E|M|VB|R)$/.test(c) || e.regiao === "Mesoestrutura" || e.regiao === "Infraestrutura") return "concreto_meso";
  return "concreto_super";
}
const REGIOES = ["Superestrutura", "Mesoestrutura", "Infraestrutura", "Transição"];
const chaveEl = e => `${e.elemento}|${e.tramo}`;

function tramoDe(o, x) {
  let acum = 0;
  for (const t of o.tramos) { acum += t.extensao_m || 0; if (x < acum) return t.numero; }
  return o.tramos.length ? o.tramos[o.tramos.length - 1].numero : 1;
}
function centroTramo(o, numero) {
  let acum = 0;
  for (const t of o.tramos) { if (t.numero === numero) return acum + (t.extensao_m || 0) / 2; acum += t.extensao_m || 0; }
  return acum / 2;
}

/* elementos sugeridos para um dano visto numa foto do roteiro: os códigos citados na legenda (ex.: "APOIO 1: P1 E P2")
 * e, se a foto é de um tramo, a laje, as longarinas e as transversinas dele */
function sugestoes(o, r) {
  if (!r) return [];
  const t = tramoDe(o, Math.max(0, r.x));
  const lista = [];
  for (const c of new Set(`${r.legenda} ${r.elemento || ""}`.match(/\b[A-Z]{1,3}\d+\b/g) || [])) {
    const es = o.elementos.filter(e => e.elemento === c);
    if (es.length) lista.push(es.find(e => e.tramo === t) || es[0]);
  }
  const m = /TRAMO (\d+)/.exec(r.legenda);
  if (m) lista.push(...o.elementos.filter(e => e.tramo === Number(m[1]) && /^(L|V|T)\d+$/.test(e.elemento)));
  const vistos = new Set();
  return lista.filter(e => !vistos.has(chaveEl(e)) && vistos.add(chaveEl(e))).slice(0, 10);
}

/* legenda automática: "PILAR EM COLUNAS DE CONCRETO ARMADO (P1, TRAMO 1): ARMADURA EXPOSTA E CORROSÃO – FACE DO LD";
 * foto extra (vista complementar, sem dano): "VISTA COMPLEMENTAR – PILAR EM COLUNAS DE CONCRETO ARMADO (P1, TRAMO 1)" */
function montarLegenda(o, el, danos, onde, extra = false) {
  const tramo = el && o.tramos.length > 1 && el.tramo ? `, TRAMO ${el.tramo}` : "";
  const nome = el ? `${el.detalhe ? `${el.detalhe.toUpperCase()} ` : ""}(${el.elemento}${tramo})` : "";
  if (extra) return `VISTA COMPLEMENTAR${nome ? ` – ${nome}` : ""}`;
  if (!el) return "";
  const d = danos.map(x => x.toUpperCase());
  const lista = d.length > 1 ? `${d.slice(0, -1).join(", ")} E ${d[d.length - 1]}` : d.join("");
  return `${nome}${lista ? `: ${lista}` : ""}` + (onde.trim() ? ` – ${onde.trim().toUpperCase()}` : "");
}

const ehExtra = d => d.tipo === "extra";
const danoCompleto = d => d.posicao_marcada && (ehExtra(d) ? !!d.legenda : d.elemento && (d.danos?.length || d.legenda));

async function telaDanos(vid) {
  const v = await BD.ler("vistorias", vid);
  const o = v && Estado.oaes.get(v.oae);
  if (!o) { location.hash = "#/"; return; }
  cabecalho("Fotos de dano e extras", `${o.item}. ${o.nome}`, `#/vistoria/${enc(vid)}`);
  const danos = v.fotos.filter(f => f.dano).sort((a, b) => a.n - b.n);
  const minis = await Promise.all(danos.map(d => BD.ler("fotos", `${vid}#D${d.dano}`)));
  const nExtras = danos.filter(ehExtra).length;
  $("#tela").innerHTML = `
    <div class="opcoes" style="margin-top:12px">
      <a class="botao" href="#/dano/${enc(vid)}/novo">+ Foto de dano</a>
      <a class="botao secundario" href="#/extra/${enc(vid)}/novo">+ Foto extra</a>
    </div>
    <p class="suave">Durante o roteiro, use "+ Dano aqui" ou "+ Foto extra aqui" na própria foto do roteiro — a foto
      fica logo depois dela no relatório. Aqui ficam também as tiradas fora do roteiro (vão para o fim).</p>
    <h2>${danos.length - nExtras} foto(s) de dano${nExtras ? ` · ${nExtras} extra(s)` : ""}</h2>
    ${danos.map((d, j) => `
      <a class="lista-item linha" href="#/dano/${enc(vid)}/${d.dano}" style="align-items:center">
        <img src="${minis[j]?.miniatura || ""}" alt="" style="width:64px;height:48px;object-fit:cover;border-radius:6px;flex:none">
        <span style="flex:1;min-width:0"><span class="nome" style="font-size:.92rem">F${pad(d.n)} · ${esc(d.legenda || "(sem legenda)")}</span>
          <span class="detalhe" style="display:block">${ehExtra(d) ? "foto extra · " : ""}${d.perto_de != null ? `junto à foto R${pad(d.perto_de)} do roteiro` : "fora do roteiro"}</span></span>
        <span class="selo ${danoCompleto(d) ? "ok" : "alerta"}">${danoCompleto(d) ? "✓" : "falta dado"}</span></a>`).join("")
      || `<div class="vazio">Nenhuma foto de dano ou extra ainda.</div>`}`;
}

/* uma foto de dano: elemento, foto, posição e direção no croqui (dois toques), danos e legenda.
 * Antes da foto, o que for preenchido fica só na tela; depois da foto, cada mudança é gravada na hora. */
async function telaDano(vid, kArg, pertoArg, extraNovo = false) {
  const v = await BD.ler("vistorias", vid);
  const o = v && Estado.oaes.get(v.oae);
  if (!o) { location.hash = "#/"; return; }
  const k = kArg === "novo" ? null : Number(kArg);
  const reg = k ? v.fotos.find(f => f.dano === k) : null;
  if (k && !reg) { location.hash = `#/danos/${enc(vid)}`; return; }
  // foto extra: vista complementar sem dano (elemento opcional, legenda livre)
  const extra = reg ? ehExtra(reg) : extraNovo;
  const oQue = extra ? "foto extra" : "foto de dano";
  const perto = reg ? reg.perto_de : pertoArg;
  const r = perto != null ? o.roteiro.find(x => x.n === perto) : null;
  const voltar = r ? `#/foto/${enc(vid)}/${r.n}` : `#/danos/${enc(vid)}`;
  cabecalho(reg ? `${extra ? "Foto extra" : "Foto de dano"} F${pad(reg.n)}` : `Nova ${oQue}`,
    `${r ? `junto à R${pad(r.n)} · ` : ""}${o.item}. ${o.nome}`, voltar);
  GPS.iniciar();
  Bussola.iniciar();
  const foto = k ? await BD.ler("fotos", `${vid}#D${k}`) : null;
  const sug = sugestoes(o, r);
  const f = {
    el: reg ? o.elementos.find(e => e.elemento === reg.elemento && e.tramo === reg.tramo) || null : sug.length === 1 ? sug[0] : null,
    danos: reg?.danos ? [...reg.danos] : [], onde: reg?.onde || "", obs: reg?.obs || "",
    legenda: reg?.legenda || "", editada: !!reg?.legenda_editada,
    // posição: a gravada; se não, a da foto do roteiro em que o dano foi visto (já aceita, pode remarcar)
    x: reg ? reg.x : r ? r.x : null, y: reg ? reg.y : r ? r.y : 0.5, direcao: reg ? reg.direcao : r ? r.direcao : null,
    semDirecao: !!reg?.sem_direcao, verTodos: false,
  };
  let modo = (reg ? reg.posicao_marcada : !!r) ? "pronto" : "posicao";
  const legendaAtual = () => f.editada ? f.legenda : montarLegenda(o, f.el, f.danos, f.onde, extra);
  const campos = () => ({
    tipo: extra ? "extra" : "dano",
    perto_de: perto ?? null, elemento: f.el ? f.el.elemento : null, tramo: f.el ? f.el.tramo : null,
    danos: f.danos, onde: f.onde.trim(), legenda: legendaAtual(), legenda_editada: f.editada, obs: f.obs.trim(),
    x: f.x, y: f.y, direcao: f.semDirecao ? null : f.direcao, sem_direcao: f.semDirecao, posicao_marcada: modo === "pronto",
  });
  let fila = Promise.resolve();
  const gravar = () => {
    if (!k) return;
    fila = fila.then(async () => {
      const vv = await BD.ler("vistorias", vid);
      const rr = vv.fotos.find(x => x.dano === k);
      if (!rr) return;
      Object.assign(rr, campos());
      renumerar(vv, o);
      vv.atualizado_em = new Date().toISOString();
      await BD.gravar("vistorias", vv);
    }).catch(e => { console.error(e); avisar("Não foi possível gravar: " + e.message, 5000); });
  };

  const multiTramo = o.tramos.length > 1;
  const nomeEl = e => `${e.elemento} – ${e.detalhe || ""}${multiTramo ? ` (tramo ${e.tramo})` : ""}`;
  const porRegiao = [...REGIOES, null].map(rg => [rg, o.elementos.filter(e => rg ? e.regiao === rg : !REGIOES.includes(e.regiao))])
    .filter(([, es]) => es.length);
  const url = foto ? URL.createObjectURL(foto.blob) : null;
  $("#tela").innerHTML = `
    ${r ? `<div class="cartao"><p class="suave">${extra ? "Foto extra junto à" : "Dano visto na"} foto do roteiro:</p><p><b>R${pad(r.n)}</b> · ${esc(r.legenda)}</p></div>` : ""}
    <h2>1. Elemento${extra ? " (opcional)" : ""}</h2>
    ${sug.length ? `<div class="fichas" id="sug">${sug.map(e => `
      <label><input type="radio" name="sug" value="${esc(chaveEl(e))}" ${f.el && chaveEl(f.el) === chaveEl(e) ? "checked" : ""}><span>${esc(e.elemento)}${multiTramo ? ` · T${e.tramo}` : ""}</span></label>`).join("")}</div>
      <p class="suave">Ou escolha na lista completa:</p>` : ""}
    <select id="el-todos">
      <option value="">${sug.length ? "Outro elemento…" : "Escolha o elemento…"}</option>
      ${porRegiao.map(([rg, es]) => `<optgroup label="${esc(rg || "Outros")}">${es.map(e =>
        `<option value="${esc(chaveEl(e))}" ${f.el && chaveEl(f.el) === chaveEl(e) && !sug.some(s => chaveEl(s) === chaveEl(e)) ? "selected" : ""}>${esc(nomeEl(e))}</option>`).join("")}</optgroup>`).join("")}
    </select>
    <h2>2. Foto</h2>
    <div id="gps"></div>
    ${foto ? `<div class="cartao"><img src="${url}" alt="Foto do dano" style="width:100%;border-radius:8px">
      <p class="suave">${esc(reg.data_hora.replace("T", " ").slice(0, 16))} · ${reg.carimbo
        ? `${esc(reg.carimbo.lat)} ${esc(reg.carimbo.lon)} · GPS ±${Math.round(reg.precisao_gps)} m`
        : `<span style="color:var(--alerta)">sem GPS</span>`}${reg.azimute != null ? ` · bússola ${rumo(reg.azimute)}` : ""}</p></div>` : ""}
    <div class="botoes"><label class="botao ${foto ? "secundario" : ""}">${foto ? "Refazer foto" : extra ? "Tirar foto extra" : "Tirar foto do dano"}
      <input id="camera" type="file" accept="image/*" capture="environment" hidden></label></div>
    <h2>3. Posição e direção no croqui</h2>
    <div class="cartao"><p id="instr"></p><div id="croqui"></div>
      <div class="opcoes" style="margin-top:10px">
        <button id="remarcar" class="botao secundario">Marcar de novo</button>
        <button id="semdir" class="botao secundario"></button>
      </div></div>
    ${extra ? "" : `<h2>4. Dano</h2>
    <p class="suave" id="danos-tipo"></p>
    <div class="fichas" id="danos"></div>
    <button id="ver-todos" class="botao secundario" style="min-height:40px;padding:6px 14px;width:auto;font-size:.9rem"></button>
    <div class="linha" style="margin-top:10px">
      <input id="outro" type="text" placeholder="Outro dano…">
      <button id="add-outro" class="botao" style="width:auto;min-height:48px;padding:8px 14px">Adicionar</button>
    </div>
    <label class="campo"><span>Onde no elemento / extensão (opcional)</span>
      <input id="onde" type="text" value="${esc(f.onde)}" placeholder="Ex.: face inferior, 1,20 m"></label>`}
    <label class="campo"><span>${extra ? "4. Legenda" : "Legenda"}</span>
      <textarea id="legenda" rows="3"></textarea></label>
    <div class="botoes" style="margin-top:0"><button id="leg-auto" class="botao secundario">Voltar à legenda automática</button></div>
    <label class="campo"><span>Observação (opcional)</span>
      <textarea id="obs" rows="2" placeholder="Ex.: dano visto só da margem LE">${esc(f.obs)}</textarea></label>
    <div class="botoes">
      <button id="concluir" class="botao">Concluir</button>
      ${reg ? `<button id="excluir" class="botao perigo">Excluir ${oQue}</button>` : ""}
    </div>`;

  const desenharLegenda = () => {
    $("#legenda").value = legendaAtual();
    $("#leg-auto").hidden = !f.editada;
  };
  const escolher = chave => {
    f.el = o.elementos.find(e => chaveEl(e) === chave) || null;
    if (f.el && f.x == null) { f.x = centroTramo(o, f.el.tramo); f.y = 0.5; }   // sugestão: meio do tramo
    document.querySelectorAll("#sug input").forEach(i => { i.checked = f.el && i.value === chave; });
    $("#el-todos").value = f.el && !sug.some(e => chaveEl(e) === chave) ? chave : "";
    desenharDanos(); desenharLegenda(); desenharCroqui(); gravar();
  };
  // danos: só os do tipo do elemento escolhido (ou todos, a pedido), mais os já marcados e os escritos à mão
  const desenharDanos = () => {
    if (extra) return;
    const tipo = f.el ? tipoElemento(f.el) : null;
    const lista = [...new Set([...(!tipo || f.verTodos ? DANOS : DANOS_POR_TIPO[tipo]), ...f.danos])];
    $("#danos").innerHTML = lista.map(d => `
      <label><input type="checkbox" value="${esc(d)}" ${f.danos.includes(d) ? "checked" : ""}><span>${esc(d)}</span></label>`).join("");
    $("#danos-tipo").textContent = !tipo ? "Escolha o elemento para ver só os danos do tipo dele."
      : f.verTodos ? "Mostrando todos os tipos de dano." : `Danos de ${NOME_TIPO[tipo]}:`;
    $("#ver-todos").hidden = !tipo;
    $("#ver-todos").textContent = f.verTodos && tipo ? `Mostrar só os de ${NOME_TIPO[tipo]}` : "Ver todos os tipos de dano";
    document.querySelectorAll("#danos input").forEach(i => {
      i.onchange = () => {
        f.danos = i.checked ? [...f.danos, i.value] : f.danos.filter(x => x !== i.value);
        desenharLegenda(); gravar();
      };
    });
  };
  document.querySelectorAll("#sug input").forEach(i => { i.onchange = () => escolher(i.value); });
  $("#el-todos").onchange = ev => { if (ev.target.value) escolher(ev.target.value); };

  // croqui: 1º toque = onde estava; 2º toque = para onde a câmera apontou
  const desenharCroqui = () => {
    const outros = v.fotos.filter(x => x.dano && x.dano !== k && x.x != null);
    const g = geoCroqui(o, [...o.roteiro, ...outros, ...(f.x != null ? [f] : [])], { H: 205, yt: 52, yb: 152 });
    const st = v.roteiro_status || {};
    const pts = o.roteiro.map(rr => `<circle cx="${g.px(rr.x)}" cy="${g.py(rr.y)}" r="3" fill="${st[rr.n] ? "#1d7a3e" : "#c3cad4"}"/>`).join("")
      + outros.map(d => `<circle cx="${g.px(d.x)}" cy="${g.py(d.y)}" r="3.5" fill="#e07b1a"/>`).join("");
    let marca = "";
    if (f.x != null) {
      marca = modo === "posicao"
        ? `<circle cx="${g.px(f.x)}" cy="${g.py(f.y)}" r="7" fill="none" stroke="#b42318" stroke-width="2" stroke-dasharray="3 2"/>`
        : marcaFoto(g, { x: f.x, y: f.y, direcao: modo === "pronto" && !f.semDirecao ? f.direcao : null }, "#b42318");
    }
    $("#croqui").innerHTML = `<svg id="croqui-toque" viewBox="0 0 ${g.W} ${g.H}" width="100%" role="img" aria-label="Toque para marcar a foto no croqui"
      style="background:#fff;border:2px solid ${modo === "pronto" ? "var(--borda)" : "var(--erro)"};border-radius:10px;touch-action:manipulation">
      ${fundoCroqui(g)}${pts}${marca}</svg>`;
    $("#instr").innerHTML = modo === "posicao"
      ? `<b>1º toque:</b> onde você estava ao tirar a foto.${f.x != null ? " O círculo tracejado é a sugestão pelo elemento." : ""}`
      : modo === "direcao" ? `<b>2º toque:</b> para onde a câmera apontou.`
      : `<b>Marcado:</b> ${textoPosicao(f, g.L)}${f.semDirecao ? " · direção não identificável" : f.direcao != null ? ` · direção ${f.direcao}°` : ""}.`;
    $("#semdir").textContent = f.semDirecao ? "Marcar a direção" : "Direção não identificável";
    const svg = $("#croqui-toque");
    svg.onclick = ev => {
      if (modo === "pronto") return avisar('Para mudar, toque em "Marcar de novo".', 2500);
      const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      if (modo === "posicao") {
        f.x = Math.round(g.ix(p.x) * 10) / 10;
        f.y = Math.round(Math.min(1.5, Math.max(-0.5, g.iy(p.y))) * 100) / 100;
        f.direcao = null;
        modo = f.semDirecao ? "pronto" : "direcao";
      } else {
        const dx = p.x - g.px(f.x), dy = p.y - g.py(f.y);
        if (Math.hypot(dx, dy) < 10) return avisar("Toque um pouco mais longe do ponto, na direção da foto.", 2500);
        f.direcao = (Math.round(((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360) / 5) * 5) % 360;
        modo = "pronto";
      }
      desenharCroqui(); gravar();
    };
  };
  $("#remarcar").onclick = () => { modo = "posicao"; desenharCroqui(); gravar(); };
  $("#semdir").onclick = () => {
    f.semDirecao = !f.semDirecao;
    modo = f.semDirecao ? (f.x != null ? "pronto" : "posicao") : (f.x != null ? "direcao" : "posicao");
    desenharCroqui(); gravar();
  };

  if (!extra) {
    $("#ver-todos").onclick = () => { f.verTodos = !f.verTodos; desenharDanos(); };
    $("#add-outro").onclick = () => {
      const t = $("#outro").value.trim();
      if (!t) return avisar("Escreva o dano no campo ao lado.");
      if (!f.danos.some(d => d.toLowerCase() === t.toLowerCase())) f.danos.push(t);
      $("#outro").value = "";
      desenharDanos(); desenharLegenda(); gravar();
    };
    $("#outro").onkeydown = ev => { if (ev.key === "Enter") { ev.preventDefault(); $("#add-outro").click(); } };
    $("#onde").oninput = ev => { f.onde = ev.target.value; desenharLegenda(); };
    $("#onde").onchange = gravar;
  }
  $("#legenda").oninput = ev => { f.legenda = ev.target.value; f.editada = true; $("#leg-auto").hidden = false; };
  $("#legenda").onchange = gravar;
  $("#leg-auto").onclick = () => { f.editada = false; desenharLegenda(); gravar(); };
  $("#obs").onchange = ev => { f.obs = ev.target.value; gravar(); };

  const desenharGPS = () => { $("#gps").innerHTML = GPS.html() + (Bussola.azimute != null ? `<div class="gps"><span class="ponto" style="background:${Bussola.confiavel ? "var(--ok)" : "var(--alerta)"}"></span>Bússola: câmera apontando para ${rumo(Bussola.azimute)}</div>` : ""); };
  desligarGPS = GPS.ouvir(desenharGPS);
  desenharGPS();
  const intervalo = setInterval(() => { if (!document.body.contains($("#gps"))) return clearInterval(intervalo); desenharGPS(); }, 1500);

  $("#camera").onchange = async ev => {
    const arq = ev.target.files[0];
    if (!arq) return;
    avisar("Salvando a foto…", 1500);
    const azimute = Bussola.azimute, bussolaOk = Bussola.confiavel;
    const pos = await posicaoAgora();
    await fila;
    const vv = await BD.ler("vistorias", vid);
    const agora = new Date(); agora.setMinutes(agora.getMinutes() - agora.getTimezoneOffset());
    let kk = k;
    if (!kk) { kk = (vv.dano_seq || 0) + 1; vv.dano_seq = kk; }
    await BD.gravar("fotos", { id: `${vid}#D${kk}`, vistoria: vid, dano: kk, blob: arq, tipo: arq.type, miniatura: await miniatura(arq), criado_em: new Date().toISOString() });
    const base = {
      roteiro: null, dano: kk, arquivo: `${extra ? "X" : "D"}${pad(kk)}_${vv.oae}_${vv.data}.jpg`,
      lat: pos ? pos.lat : null, lon: pos ? pos.lon : null, precisao_gps: pos ? pos.prec : null,
      carimbo: pos ? { lat: dms(pos.lat, "lat"), lon: dms(pos.lon, "lon") } : null,
      azimute: azimute != null ? Math.round(azimute) : null, bussola_confiavel: bussolaOk,
      data_hora: agora.toISOString().slice(0, 19),
    };
    const existente = vv.fotos.find(x => x.dano === kk);
    if (existente) Object.assign(existente, base);
    else vv.fotos.push({ n: 0, ...base, ...campos() });
    renumerar(vv, o);
    vv.atualizado_em = new Date().toISOString();
    await BD.gravar("vistorias", vv);
    avisar(pos ? "Foto salva." : "Foto salva, mas sem GPS. Confira a localização do celular.", pos ? 1500 : 5000);
    if (k) rotear(); else location.hash = `#/dano/${enc(vid)}/${kk}`;
  };

  $("#concluir").onclick = async () => {
    if (!k) return avisar(`Tire a ${oQue} antes de concluir.`);
    if (!extra && !f.el) return avisar("Escolha o elemento do dano.");
    if (modo !== "pronto") return avisar('Marque no croqui onde você estava e para onde a câmera apontou (ou "Direção não identificável").', 5000);
    if (extra ? !legendaAtual().trim() : !f.danos.length && !(f.editada && f.legenda.trim()))
      return avisar(extra ? "Escreva a legenda da foto." : "Marque o tipo de dano ou escreva a legenda.");
    await fila;
    location.hash = voltar;
  };
  if ($("#excluir")) $("#excluir").onclick = async () => {
    if (!confirm(`Excluir esta ${oQue}? Isso não pode ser desfeito.`)) return;
    await fila;
    await BD.apagar("fotos", `${vid}#D${k}`);
    const vv = await BD.ler("vistorias", vid);
    vv.fotos = vv.fotos.filter(x => x.dano !== k);
    renumerar(vv, o);
    vv.atualizado_em = new Date().toISOString();
    await BD.gravar("vistorias", vv);
    avisar(extra ? "Foto extra excluída." : "Foto de dano excluída.");
    location.hash = voltar;
  };

  desenharDanos();
  desenharLegenda();
  desenharCroqui();
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
