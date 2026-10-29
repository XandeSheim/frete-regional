/*
 * Processador de Frete Regional (roda no navegador e no Node)
 * ===========================================================
 * Pipeline:
 * 1. Lê o GeoJSON da loja -> lista de polígonos
 * 2. Busca os CEPs da região no IBGE (ibge.js) ou numa base própria
 *    (cep, latitude, longitude) -> CEPs DENTRO do polígono
 * 3. Lê as planilhas de frete base (todas as abas) -> mantém só as faixas
 *    [cep_inicio, cep_fim] que contêm pelo menos um CEP da região
 * 4. Junta as faixas de todas as planilhas num único Modelo 1 (Retirada) e
 *    num único Modelo 2 (Entrega)
 * 5. Exporta .xls (BIFF8, via SheetJS) e compacta tudo em planilhas_frete.zip
 *
 * Os nomes, a ordem e o formato das colunas originais são preservados: só as
 * colunas de preço e de prazo são alteradas.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FreteProcessor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const lib = (name, nodeName) =>
    root[name] || (typeof require === "function" ? require(nodeName) : null);

  const ZIP_NAME = "planilhas_frete.zip";
  const XLS_MAX_ROWS = 65000; // limite do formato .xls é 65.536 linhas (incluindo cabeçalho)

  /** 'Zip Code_Start' -> 'zipcodestart' (comparação de colunas sem caixa/espaço/_). */
  const norm = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // ===========================================================================
  // MAPEAMENTO DE COLUNAS
  // ===========================================================================
  // Planilhas VTEX/Karsten (ZipCodeStart...) e o padrão (cep_inicio...) funcionam
  // sem precisar de config.json.
  const COLUMN_ALIASES = {
    cep_inicio: ["cepinicio", "cepinicial", "zipcodestart", "zipstart", "cepde"],
    cep_fim: ["cepfim", "cepfinal", "zipcodeend", "zipend", "cepate"],
    absolute_money_cost: ["absolutemoneycost"],
    price_percent: ["pricepercent"],
    price_by_extra_weight: ["pricebyextraweight"],
    time_cost: ["timecost"],
  };

  // Chaves aceitas no config.json (formato antigo) -> coluna lógica
  const CONFIG_KEYS = {
    cep_inicio: "cep_inicio",
    cep_fim: "cep_fim",
    valor_minimo: "absolute_money_cost",
    valor_ad_valorem: "price_percent",
    valor_kg: "price_by_extra_weight",
    prazo: "time_cost",
  };

  const PRICE_COLUMNS = ["absolute_money_cost", "price_percent", "price_by_extra_weight"];

  /** Apelidos de colunas, acrescidos dos nomes do config.json (objeto já lido, opcional). */
  function loadColumnConfig(cfg) {
    const aliases = {};
    for (const [k, v] of Object.entries(COLUMN_ALIASES)) aliases[k] = [...v];
    for (const [key, colName] of Object.entries(cfg || {})) {
      const logical = CONFIG_KEYS[key.toLowerCase()];
      if (logical) aliases[logical].unshift(norm(colName));
    }
    return aliases;
  }

  /** Coluna lógica -> índice REAL da coluna nos cabeçalhos (ou -1 se não existir). */
  function resolveColumns(headers, aliases) {
    const byNorm = new Map();
    headers.forEach((h, i) => { if (!byNorm.has(norm(h))) byNorm.set(norm(h), i); });
    const out = {};
    for (const [logical, names] of Object.entries(aliases)) {
      const hit = names.find((a) => byNorm.has(a));
      out[logical] = hit === undefined ? -1 : byNorm.get(hit);
    }
    return out;
  }

  // ===========================================================================
  // POLÍGONO DA LOJA
  // ===========================================================================
  /** Lê Feature, FeatureCollection ou Geometry -> lista de polígonos (cada um = lista de anéis). */
  function readGeojsonPolygons(gj) {
    let geoms;
    if (gj && gj.type === "FeatureCollection") geoms = (gj.features || []).map((f) => f && f.geometry);
    else if (gj && gj.type === "Feature") geoms = [gj.geometry];
    else geoms = [gj];

    const polys = [];
    for (const g of geoms) {
      if (!g) continue;
      if (g.type === "Polygon") polys.push(g.coordinates);
      else if (g.type === "MultiPolygon") polys.push(...g.coordinates);
    }
    if (!polys.length) throw new Error("O GeoJSON não contém nenhum polígono (Polygon/MultiPolygon).");
    return polys;
  }

  function pointInRing(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** Ponto dentro de algum polígono (respeitando buracos). */
  function pointInPolygons(polys, x, y) {
    for (const rings of polys) {
      if (pointInRing(rings[0], x, y) && !rings.slice(1).some((h) => pointInRing(h, x, y))) return true;
    }
    return false;
  }

  function bboxOf(polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const rings of polys) for (const [x, y] of rings[0]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }

  // ===========================================================================
  // CEPs DENTRO DO POLÍGONO
  // ===========================================================================
  /** Converte CEPs em qualquer formato ('01000-000', 1000000, '1000000.0') para int. Inválido -> -1. */
  function cepToInt(v) {
    if (v === null || v === undefined || v === "") return -1;
    if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : -1;
    let s = String(v).trim();
    if (/^\d+\.0+$/.test(s)) s = s.split(".")[0];
    const digits = s.replace(/\D/g, "");
    return digits ? parseInt(digits, 10) : -1;
  }

  const toNum = (v) => (typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", ".")));

  /** Qualquer tabela {colunas, linhas} com cep/latitude/longitude -> [{cep, lat, lon}]. */
  function normalizeCepBase(headers, rows) {
    const byNorm = new Map(headers.map((h, i) => [norm(h), i]));
    const pick = (...names) => { const n = names.find((x) => byNorm.has(x)); return n === undefined ? -1 : byNorm.get(n); };
    const cCep = pick("cep", "zipcode", "postcode"), cLat = pick("latitude", "lat"), cLon = pick("longitude", "lon", "lng");
    if (cCep < 0 || cLat < 0 || cLon < 0) {
      throw new Error("A base de CEPs precisa das colunas: cep, latitude, longitude.\nEncontradas: " + headers.join(", "));
    }
    const out = [];
    for (const r of rows) {
      const cep = cepToInt(r[cCep]), lat = toNum(r[cLat]), lon = toNum(r[cLon]);
      if (cep > 0 && Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) out.push({ cep, lat, lon });
    }
    return out;
  }

  /** CEPs (int, ordenados, únicos) cujo ponto (lon, lat) cai dentro do polígono. */
  function cepsInPolygon(cepBase, polys) {
    const [x0, y0, x1, y1] = bboxOf(polys);
    const set = new Set();
    for (const { cep, lat, lon } of cepBase) {
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
      if (pointInPolygons(polys, lon, lat)) set.add(cep);
    }
    return Float64Array.from(set).sort();
  }

  // ===========================================================================
  // LEITURA DAS PLANILHAS
  // ===========================================================================
  /** CSV simples com detecção de separador (, ; tab |) e aspas. */
  function parseCsv(text) {
    text = text.replace(/^﻿/, "");
    const first = text.slice(0, text.indexOf("\n") + 1 || text.length);
    const sep = [",", ";", "\t", "|"].reduce((a, b) => (first.split(b).length > first.split(a).length ? b : a));
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += ch;
      } else if (ch === '"' && field === "") quoted = true;
      else if (ch === sep) { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += ch;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.map((r) => r.map((v) => (v === "" ? null : v)));
  }

  function decodeText(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return new TextDecoder("windows-1252").decode(bytes); }
  }

  const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

  /** Arquivo -> abas {nome: matriz de células}. Muitos '.xls' de sistemas são xlsx ou HTML: o SheetJS lê todos. */
  function readSheets(name, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ext = name.toLowerCase().split(".").pop();
    if (ext === "csv" || ext === "txt") return { csv: parseCsv(decodeText(bytes)) };
    if (ext !== "xls" && ext !== "xlsx") throw new Error(`Formato não suportado: ${name} (use .xls, .xlsx ou .csv)`);
    const XLSX = lib("XLSX", "xlsx");
    let wb;
    try { wb = XLSX.read(bytes, { type: "array", cellDates: false }); }
    catch (e) { throw new Error(`Não foi possível ler '${name}': ${e.message}`); }
    const out = {};
    for (const sn of wb.SheetNames) {
      out[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null, blankrows: false });
    }
    return out;
  }

  /**
   * Lê todas as abas de uma planilha e junta as que têm colunas de CEP
   * (abas de instruções/legenda são ignoradas). Mantém os nomes originais.
   * Retorna { headers, rows } com rows = matriz alinhada aos headers.
   */
  function readFreightFile(name, data, aliases, log = () => {}) {
    const sheets = readSheets(name, data);
    const headers = [];
    const rows = [];
    let used = 0;
    for (const [sn, matrix] of Object.entries(sheets)) {
      const body = matrix.filter((r) => r && r.some((v) => !isBlank(v)));
      if (!body.length) continue;
      const head = body[0].map((h) => (h === null ? "" : String(h).trim()));
      const cols = resolveColumns(head, aliases);
      if (cols.cep_inicio < 0 || cols.cep_fim < 0 || body.length < 2) {
        log(`  ${name} / aba '${sn}' ignorada (sem colunas de CEP)`, "info");
        continue;
      }
      used++;
      // alinha colunas por nome entre abas (como pd.concat)
      const idx = head.map((h) => { let k = headers.indexOf(h); if (k < 0) { headers.push(h); k = headers.length - 1; } return k; });
      for (const r of body.slice(1)) {
        const out = [];
        idx.forEach((k, i) => { out[k] = r[i] === undefined ? null : r[i]; });
        rows.push(out);
      }
    }
    if (!used) {
      throw new Error(
        `'${name}': nenhuma aba tem colunas de CEP inicial/final ` +
        "(ex.: ZipCodeStart/ZipCodeEnd ou cep_inicio/cep_fim). Se os nomes forem diferentes, use um config.json."
      );
    }
    for (const r of rows) for (let k = 0; k < headers.length; k++) if (r[k] === undefined) r[k] = null;
    restoreNumbers(headers, rows, aliases);
    return { headers, rows };
  }

  const NUMERIC = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

  /** Converte para número as colunas 100% numéricas (exceto CEPs e TimeCost, mantidos como vieram). */
  function restoreNumbers(headers, rows, aliases) {
    const cols = resolveColumns(headers, aliases);
    const keep = new Set([cols.cep_inicio, cols.cep_fim, cols.time_cost]);
    for (let c = 0; c < headers.length; c++) {
      if (keep.has(c)) continue;
      const allNum = rows.every((r) => r[c] === null || typeof r[c] === "number" || (typeof r[c] === "string" && NUMERIC.test(r[c])));
      if (allNum) for (const r of rows) if (typeof r[c] === "string") r[c] = Number(r[c]);
    }
  }

  // ===========================================================================
  // REGRAS DOS MODELOS
  // ===========================================================================
  const DEFAULT_TIMECOST = 1;

  /** TimeCost = `dias`, respeitando o formato original ('20.00:00:00' -> '3.00:00:00'). */
  const timecostDays = (v, dias) => (typeof v === "string" && v.includes(":") ? `${dias}.00:00:00` : dias);

  /**
   * MODELO 1 - RETIRADA
   * - AbsoluteMoneyCost, PricePercent, PriceByExtraWeight -> 0
   * - TimeCost -> dias escolhidos (padrão 1)
   * - Demais colunas: mantidas exatamente como no original.
   */
  function buildModelRetirada(rows, cols, dias = DEFAULT_TIMECOST) {
    return rows.map((r) => {
      const m = r.slice();
      for (const l of PRICE_COLUMNS) if (cols[l] >= 0) m[cols[l]] = 0;
      if (cols.time_cost >= 0) m[cols.time_cost] = timecostDays(m[cols.time_cost], dias);
      return m;
    });
  }

  /**
   * MODELO 2 - ENTREGA
   * - Preços: ORIGINAIS
   * - TimeCost -> dias escolhidos (padrão 1); null = mantém o prazo da planilha
   * - Demais colunas: mantidas exatamente como no original.
   */
  function buildModelEntrega(rows, cols, dias = DEFAULT_TIMECOST) {
    return rows.map((r) => {
      const m = r.slice();
      if (cols.time_cost >= 0 && dias !== null) m[cols.time_cost] = timecostDays(m[cols.time_cost], dias);
      return m;
    });
  }

  // ===========================================================================
  // FILTRO, EXPORTAÇÃO .XLS E ZIP
  // ===========================================================================
  function lowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }
  function upperBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo; }

  /** Mantém linhas cuja faixa [inicio, fim] contém ao menos um CEP da região (busca binária). */
  function filterByCeps(rows, cols, target) {
    let invalid = 0;
    const kept = rows.filter((r) => {
      const a = cepToInt(r[cols.cep_inicio]), b = cepToInt(r[cols.cep_fim]);
      if (a < 0 || b < 0) { invalid++; return false; }
      return upperBound(target, Math.max(a, b)) - lowerBound(target, Math.min(a, b)) > 0;
    });
    return { kept, invalid };
  }

  function cellValue(v) {
    if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) return null;
    if (typeof v === "boolean" || typeof v === "number") return v;
    return String(v);
  }

  /** Grava a tabela em .xls (BIFF8), sem coluna de índice. */
  function exportXls(headers, rows, sheetName) {
    const XLSX = lib("XLSX", "xlsx");
    const ws = XLSX.utils.aoa_to_sheet([headers.map(String), ...rows.map((r) => r.map(cellValue))]);
    ws["!cols"] = headers.map((h) => ({ wch: Math.min(Math.max(String(h).length + 4, 12), 50) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
    return new Uint8Array(XLSX.write(wb, { bookType: "biff8", type: "array" }));
  }

  function createZip(files) {
    const fflate = lib("fflate", "fflate");
    const entries = {};
    for (const f of files) entries[f.name] = f.data;
    return fflate.zipSync(entries, { level: 6 });
  }

  const fmt = (n) => n.toLocaleString("pt-BR");

  // ===========================================================================
  // ORQUESTRADOR
  // ===========================================================================
  /**
   * opts = {
   *   freightFiles: [{name, data}],       // planilhas de frete base
   *   geojson: objeto GeoJSON,            // range da loja
   *   cepBase: {name, data} | null,       // base própria (.csv); null = IBGE automático
   *   ibge: async (polys, log) => [{cep, lat, lon}],
   *   columnConfig: objeto config.json | null,
   *   timecost: { retirada: dias, entrega: dias | null } (padrão 1 e 1; entrega null = prazo da planilha),
   *   progress: (pct, msg) => {}, log: (msg, level) => {}
   * }
   */
  async function run(opts) {
    const progress = opts.progress || (() => {});
    const log = opts.log || (() => {});
    const aliases = loadColumnConfig(opts.columnConfig);
    const n = opts.freightFiles.length;
    const tc = { retirada: DEFAULT_TIMECOST, entrega: DEFAULT_TIMECOST, ...opts.timecost };
    log(`TimeCost: Retirada ${tc.retirada} dia(s), Entrega ${tc.entrega === null ? "mantido da planilha" : `${tc.entrega} dia(s)`}`);
    const tick = () => new Promise((r) => setTimeout(r, 0)); // deixa a tela atualizar

    // 1) Polígono da loja
    progress(5, "Lendo o range da loja (GeoJSON)...");
    const polys = readGeojsonPolygons(opts.geojson);

    // 2) CEPs dentro do polígono
    let cepBase;
    if (opts.cepBase) {
      progress(10, `Carregando base de CEPs: ${opts.cepBase.name}...`);
      const matrix = parseCsv(decodeText(new Uint8Array(opts.cepBase.data)));
      cepBase = normalizeCepBase(matrix[0].map(String), matrix.slice(1));
    } else {
      progress(10, "Buscando CEPs da região no IBGE (Censo 2022)...");
      cepBase = await opts.ibge(polys, log);
    }
    log(`Base de CEPs: ${fmt(cepBase.length)} CEPs com coordenadas`);
    progress(25, "Cruzando CEPs com o polígono da loja...");
    const target = cepsInPolygon(cepBase, polys);
    if (!target.length) {
      throw new Error("Nenhum CEP da base caiu dentro do polígono.\n" +
        "Verifique se a base de CEPs cobre a região da loja e se o GeoJSON está correto.");
    }
    log(`CEPs dentro do range da loja: ${fmt(target.length)}`, "success");

    // 3) Cada planilha -> filtro por CEP -> Modelo Retirada + Modelo Entrega,
    //    juntando todas as planilhas numa só de cada modelo (colunas alinhadas por nome)
    const headers = [];
    const retirada = [], entrega = [];
    const align = (head, rows) => {
      const idx = head.map((h) => { let k = headers.indexOf(h); if (k < 0) { headers.push(h); k = headers.length - 1; } return k; });
      return rows.map((r) => { const out = []; idx.forEach((k, i) => { out[k] = r[i]; }); return out; });
    };
    let totalRows = 0;
    for (let i = 0; i < n; i++) {
      const { name, data } = opts.freightFiles[i];
      progress(30 + Math.floor((60 * i) / n), `Planilha ${i + 1}/${n}: ${name}`);
      await tick();

      const { headers: head, rows } = readFreightFile(name, data, aliases, log);
      const cols = resolveColumns(head, aliases);
      const { kept, invalid } = filterByCeps(rows, cols, target);
      if (invalid) log(`  ${name}: ${invalid} linha(s) com CEP inválido ignorada(s)`, "warning");
      if (!kept.length) { log(`  ${name}: nenhuma faixa de CEP dentro do range (não entra no resultado)`, "warning"); continue; }
      totalRows += kept.length;
      const missing = [...PRICE_COLUMNS, "time_cost"].filter((l) => cols[l] < 0);
      if (missing.length) log(`  ${name}: colunas não encontradas (ignoradas): ${missing.join(", ")}`, "warning");

      // Modelo 1 (Retirada) e Modelo 2 (Entrega) – regras nas funções buildModel*
      retirada.push(...align(head, buildModelRetirada(kept, cols, tc.retirada)));
      entrega.push(...align(head, buildModelEntrega(kept, cols, tc.entrega)));
      log(`  ${name}: ${fmt(kept.length)} de ${fmt(rows.length)} faixas mantidas`, "success");
    }
    if (!totalRows) throw new Error("Nenhuma planilha teve faixas de CEP dentro do range da loja. Nada foi gerado.");

    // Colunas que só existem em algumas planilhas ficam vazias nas demais
    for (const r of [...retirada, ...entrega]) for (let k = 0; k < headers.length; k++) if (r[k] === undefined) r[k] = null;
    progress(90, "Gerando planilhas de Retirada e Entrega...");
    await tick();
    const generated = [
      ...exportChunks(headers, retirada, "frete_retirada", "Retirada", log),
      ...exportChunks(headers, entrega, "frete_entrega", "Entrega", log),
    ];

    // 4) ZIP com todas as planilhas
    progress(95, "Compactando planilhas (ZIP)...");
    await tick();
    const zip = { name: ZIP_NAME, data: createZip(generated) };
    progress(100, "Concluído com sucesso!");
    return { files: generated, zip, cepsCount: target.length, rowsProcessed: totalRows };
  }

  /** Exporta em um .xls; se passar do limite do formato, divide em partes. */
  function exportChunks(headers, rows, stem, sheet, log) {
    if (rows.length <= XLS_MAX_ROWS) return [{ name: `${stem}.xls`, data: exportXls(headers, rows, sheet) }];
    const parts = [];
    for (let s = 0, p = 1; s < rows.length; s += XLS_MAX_ROWS, p++) {
      parts.push({ name: `${stem}_parte${p}.xls`, data: exportXls(headers, rows.slice(s, s + XLS_MAX_ROWS), sheet) });
    }
    log(`  ${stem}: mais de ${fmt(XLS_MAX_ROWS)} linhas – dividido em ${parts.length} arquivos`, "warning");
    return parts;
  }

  return {
    run, readGeojsonPolygons, pointInPolygons, bboxOf, cepsInPolygon, cepToInt, readFreightFile,
    resolveColumns, loadColumnConfig, filterByCeps, buildModelRetirada, buildModelEntrega,
    parseCsv, exportXls, ZIP_NAME,
  };
});
