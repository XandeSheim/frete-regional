/*
 * Base de CEPs automática (IBGE – CNEFE, Censo 2022)
 * ==================================================
 * O IBGE publica, de graça, todos os endereços do Brasil com CEP + latitude/longitude
 * (Cadastro Nacional de Endereços para Fins Estatísticos), separados por município.
 * O servidor do IBGE permite acesso direto do navegador (CORS), então:
 * 1. A malha de municípios vem junto com o site (data/malha_municipios.geojson)
 * 2. Descobre quais municípios o polígono da loja toca
 * 3. Baixa só o CNEFE desses municípios (lendo o zip em streaming) e reduz a
 *    1 ponto por CEP (mediana dos endereços)
 * 4. Guarda o resultado no navegador (IndexedDB) -> próximas vezes são instantâneas
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FreteIBGE = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const CNEFE_URL = "https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/" +
    "Censo_Demografico_2022/Arquivos_CNEFE/CSV/Municipio/";

  // A malha "mínima" é simplificada: uma margem (~3 km) garante que municípios
  // vizinhos à borda do polígono não fiquem de fora. CEPs a mais não atrapalham:
  // o teste final (CEP dentro do polígono) é feito ponto a ponto.
  const MARGEM_GRAUS = 0.03;
  // NV_GEO_COORD 1-4 = endereço/face de quadra; 5-6 = localidade/setor (impreciso)
  const NIVEL_GEO_MAX = 4;
  const CACHE_VERSION = 1;

  const lib = (name, nodeName) =>
    root[name] || (typeof require === "function" ? require(nodeName) : null);
  const fmt = (n) => n.toLocaleString("pt-BR");

  // ------------------------------------------------------------- geometria
  function polysOf(geometry) {
    return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  }

  function bbox(polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const rings of polys) for (const [x, y] of rings[0]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }

  function pointSegDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function segDist(a, b, c, d) {
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0; // se cruzam
    return Math.min(
      pointSegDist(a[0], a[1], c[0], c[1], d[0], d[1]), pointSegDist(b[0], b[1], c[0], c[1], d[0], d[1]),
      pointSegDist(c[0], c[1], a[0], a[1], b[0], b[1]), pointSegDist(d[0], d[1], a[0], a[1], b[0], b[1])
    );
  }

  function pointInRing(ring, x, y) {
    let r = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
    }
    return r;
  }
  const inside = (polys, x, y) =>
    polys.some((rings) => pointInRing(rings[0], x, y) && !rings.slice(1).some((h) => pointInRing(h, x, y)));

  /** O município fica a até `margem` graus do polígono da loja (equivale a buffer + intersects). */
  function nearPolygon(muni, store, margem) {
    if (store.some((rings) => inside(muni, rings[0][0][0], rings[0][0][1]))) return true;
    if (muni.some((rings) => inside(store, rings[0][0][0], rings[0][0][1]))) return true;
    for (const mr of muni) for (const ring of mr) for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      for (const sr of store) for (const sring of sr) for (let j = 1; j < sring.length; j++) {
        if (segDist(a, b, sring[j - 1], sring[j]) <= margem) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------- cache (IndexedDB)
  const cache = {
    db: null,
    async open() {
      if (this.db !== null) return this.db;
      this.db = await new Promise((resolve) => {
        try {
          const req = root.indexedDB.open("frete-regional", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("ceps");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(false);
        } catch { resolve(false); } // sem IndexedDB (Node, janela privada...) -> sem cache
      });
      return this.db;
    },
    async get(code) {
      const db = await this.open();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const req = db.transaction("ceps").objectStore("ceps").get(code);
          req.onsuccess = () => resolve(req.result && req.result.v === CACHE_VERSION ? req.result : null);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    },
    async set(code, value) {
      const db = await this.open();
      if (!db) return;
      try { db.transaction("ceps", "readwrite").objectStore("ceps").put({ ...value, v: CACHE_VERSION }, code); } catch {}
    },
    async clear() {
      const db = await this.open();
      if (!db) return;
      await new Promise((resolve) => {
        try { const tx = db.transaction("ceps", "readwrite"); tx.objectStore("ceps").clear(); tx.oncomplete = resolve; tx.onerror = resolve; }
        catch { resolve(); }
      });
    },
  };

  // ------------------------------------------------------------- IBGE
  /**
   * createIbge({ loadMalha }) -> { cepsForPolygon(polys, log) }
   * loadMalha: async () => GeoJSON da malha de municípios.
   */
  function createIbge({ loadMalha }) {
    let malha = null;
    const listings = {};

    async function municipiosNoPoligono(polys) {
      if (!malha) {
        const gj = await loadMalha();
        malha = gj.features.map((f) => {
          const p = polysOf(f.geometry);
          return { code: f.properties.codarea, polys: p, bbox: bbox(p) };
        });
      }
      const [x0, y0, x1, y1] = bbox(polys);
      const m = MARGEM_GRAUS;
      return malha
        .filter(({ bbox: b }) => b[0] <= x1 + m && b[2] >= x0 - m && b[1] <= y1 + m && b[3] >= y0 - m)
        .filter((mu) => nearPolygon(mu.polys, polys, m))
        .map((mu) => mu.code)
        .sort();
    }

    async function getText(url) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`IBGE respondeu ${resp.status} em ${url}`);
      return new TextDecoder("windows-1252").decode(await resp.arrayBuffer());
    }

    /** URL do zip do município (o nome tem o município: 4209102_JOINVILLE.zip). */
    async function arquivoMunicipio(code) {
      const uf = code.slice(0, 2);
      if (!listings[uf]) {
        if (!listings.root) {
          const html = await getText(CNEFE_URL);
          listings.root = {};
          for (const [, m] of html.matchAll(/href="(\d{2}_[A-Z]{2}\/)"/g)) listings.root[m.slice(0, 2)] = m;
        }
        const pasta = listings.root[uf];
        if (!pasta) throw new Error(`UF ${uf} não encontrada no servidor do IBGE.`);
        const html = await getText(CNEFE_URL + pasta);
        listings[uf] = {};
        for (const [, m] of html.matchAll(/href="(\d{7}_[^"]+\.zip)"/g)) listings[uf][m.slice(0, 7)] = CNEFE_URL + pasta + m;
      }
      const url = listings[uf][code];
      if (!url) throw new Error(`Município ${code} não encontrado no CNEFE do IBGE.`);
      return url;
    }

    async function baixarMunicipio(code, i, n, log) {
      const fflate = lib("fflate", "fflate");
      const url = await arquivoMunicipio(code);
      const nome = decodeURIComponent(url.split("/").pop()).slice(8, -4).replace(/_/g, " ")
        .toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
      log(`  [${i}/${n}] Baixando endereços de ${nome} (IBGE)...`, "info");

      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`IBGE respondeu ${resp.status} ao baixar ${nome}.`);
      const total = Number(resp.headers.get("content-length")) || 0;

      // CEP -> { p: tem endereço preciso, lat: [], lon: [] }
      const agg = new Map();
      let iCep = -1, iLat = -1, iLon = -1, iNv = -1, header = true, rest = "", csvFound = false, zipErr = null;
      const dec = new TextDecoder("windows-1252");

      const handleLine = (line) => {
        if (!line) return;
        const f = line.split(";");
        if (header) {
          const h = f.map((x) => x.replace(/"/g, "").trim().toUpperCase());
          [iCep, iLat, iLon, iNv] = ["CEP", "LATITUDE", "LONGITUDE", "NV_GEO_COORD"].map((c) => h.indexOf(c));
          if (iCep < 0 || iLat < 0 || iLon < 0) throw new Error(`Arquivo do IBGE de ${nome} em formato inesperado.`);
          header = false;
          return;
        }
        const cep = (f[iCep] || "").replace(/\D/g, "");
        const lat = parseFloat((f[iLat] || "").replace(",", ".")), lon = parseFloat((f[iLon] || "").replace(",", "."));
        if (!cep || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const precise = iNv < 0 || Number(f[iNv]) <= NIVEL_GEO_MAX;
        let e = agg.get(cep);
        if (!e) agg.set(cep, (e = { p: precise, lat: [], lon: [] }));
        else if (precise && !e.p) { e.p = true; e.lat = []; e.lon = []; } // descarta os imprecisos
        else if (!precise && e.p) return;
        e.lat.push(lat); e.lon.push(lon);
      };
      const handleText = (text, final) => {
        const lines = (rest + text).split("\n");
        rest = final ? "" : lines.pop();
        for (const l of lines) handleLine(l.replace(/\r$/, ""));
      };

      const unzip = new fflate.Unzip();
      unzip.register(fflate.UnzipInflate);
      unzip.onfile = (file) => {
        if (csvFound || !/\.csv$/i.test(file.name)) return;
        csvFound = true;
        file.ondata = (err, chunk, final) => {
          if (err) { zipErr = err; return; }
          try { handleText(dec.decode(chunk, { stream: !final }), final); } catch (e) { zipErr = e; }
        };
        file.start();
      };

      const reader = resp.body.getReader();
      let done = 0, nextReport = 0.25;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) { unzip.push(new Uint8Array(0), true); break; }
        unzip.push(value, false);
        if (zipErr) { reader.cancel(); throw zipErr; }
        done += value.length;
        if (total > 20e6 && done / total >= nextReport) {
          log(`    ${nome}: ${Math.round((100 * done) / total)}% de ${Math.round(total / 1e6)} MB`, "info");
          nextReport += 0.25;
        }
      }
      if (zipErr) throw zipErr;
      if (!csvFound) throw new Error(`O zip do IBGE de ${nome} não tem CSV.`);

      // 1 ponto por CEP: mediana dos endereços precisos; se o CEP só tiver
      // coordenadas imprecisas (localidade/setor), usa essas mesmo.
      const median = (arr) => {
        const s = Float64Array.from(arr).sort(), m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      };
      const ceps = new Int32Array(agg.size), lat = new Float64Array(agg.size), lon = new Float64Array(agg.size);
      let k = 0;
      for (const [cep, e] of agg) { ceps[k] = parseInt(cep, 10); lat[k] = median(e.lat); lon[k] = median(e.lon); k++; }
      log(`         ${nome}: ${fmt(agg.size)} CEPs`, "success");
      return { ceps, lat, lon };
    }

    /** [{cep, lat, lon}] de todos os municípios que o polígono toca. */
    async function cepsForPolygon(polys, log = () => {}) {
      const codes = await municipiosNoPoligono(polys);
      if (!codes.length) {
        throw new Error("O polígono da loja não toca nenhum município do Brasil. " +
          "Confira se o GeoJSON está correto (longitude, latitude).");
      }
      const cached = {};
      for (const c of codes) cached[c] = await cache.get(c);
      const faltando = codes.filter((c) => !cached[c]).length;
      log(`Municípios no range: ${codes.length} (${codes.length - faltando} já salvos no navegador, ${faltando} para baixar do IBGE)`, "info");

      const out = [];
      for (let i = 0; i < codes.length; i++) {
        let data = cached[codes[i]];
        if (!data) {
          data = await baixarMunicipio(codes[i], i + 1, codes.length, log);
          await cache.set(codes[i], data);
        }
        for (let k = 0; k < data.ceps.length; k++) out.push({ cep: data.ceps[k], lat: data.lat[k], lon: data.lon[k] });
      }
      return out;
    }

    return { cepsForPolygon, municipiosNoPoligono };
  }

  return { createIbge, clearCache: () => cache.clear() };
});
