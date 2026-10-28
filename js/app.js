/* Interface do Frete Regional (web) */
(function () {
  "use strict";

  const EXPECTED_FREIGHT_FILES = 8;
  const $ = (id) => document.getElementById(id);

  const state = { freight: [], geojson: null, cepBase: null, config: null, running: false, urls: [] };
  const ibge = FreteIBGE.createIbge({
    loadMalha: async () => {
      const resp = await fetch("data/malha_municipios.geojson");
      if (!resp.ok) throw new Error("Não foi possível carregar a malha de municípios do site.");
      return resp.json();
    },
  });

  // ------------------------------------------------------------------ tema
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  function applyTheme(mode) {
    if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
  }
  $("theme").value = store.get("theme") || "system";
  applyTheme($("theme").value);
  $("theme").addEventListener("change", (e) => { applyTheme(e.target.value); store.set("theme", e.target.value); });

  // ------------------------------------------------------------------ log
  function log(msg, level = "info") {
    const line = document.createElement("span");
    line.className = level;
    const time = new Date().toLocaleTimeString("pt-BR");
    line.textContent = `[${time}] ${msg}\n`;
    $("log").appendChild(line);
    $("log").scrollTop = $("log").scrollHeight;
  }
  function setStatus(text, kind = "") { $("status").textContent = text; $("status").className = kind || "muted"; }
  function setProgress(pct) { $("bar").style.width = `${pct}%`; }

  // ------------------------------------------------------------------ planilhas
  function addFreight(files) {
    for (const f of files) {
      if (!/\.(xls|xlsx|csv)$/i.test(f.name)) { log(`Ignorado (formato não suportado): ${f.name}`, "warning"); continue; }
      if (state.freight.some((x) => x.name === f.name && x.size === f.size)) continue;
      state.freight.push(f);
    }
    renderFreight();
  }
  function renderFreight() {
    const list = $("freight-list");
    list.replaceChildren(...state.freight.map((f, i) => {
      const li = document.createElement("li");
      li.textContent = f.name;
      const rm = document.createElement("button");
      rm.type = "button"; rm.textContent = "✕"; rm.title = "Remover"; rm.setAttribute("aria-label", `Remover ${f.name}`);
      rm.onclick = () => { state.freight.splice(i, 1); renderFreight(); };
      li.appendChild(rm);
      return li;
    }));
    const n = state.freight.length;
    $("freight-count").textContent = `${n}/${EXPECTED_FREIGHT_FILES}`;
    $("freight-count").classList.toggle("ok", n === EXPECTED_FREIGHT_FILES);
    $("freight-clear").hidden = !n;
    checkReady();
  }
  $("freight-input").addEventListener("change", (e) => { addFreight(e.target.files); e.target.value = ""; });
  $("freight-clear").addEventListener("click", () => { state.freight = []; renderFreight(); });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFreight(e.dataTransfer.files));

  // ------------------------------------------------------------------ range da loja
  $("geo-input").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const gj = JSON.parse(await f.text());
      const polys = FreteProcessor.readGeojsonPolygons(gj);
      state.geojson = { name: f.name, data: gj };
      $("geo-name").textContent = `✔ ${f.name}`;
      $("geo-name").className = "ok";
      drawPreview(polys);
    } catch (err) {
      state.geojson = null;
      $("geo-name").textContent = `Arquivo inválido: ${err.message}`;
      $("geo-name").className = "muted";
      $("geo-preview").hidden = true;
    }
    checkReady();
  });

  function drawPreview(polys) {
    const [x0, y0, x1, y1] = FreteProcessor.bboxOf(polys);
    const w = 100, h = 60, pad = 6;
    const s = Math.min((w - 2 * pad) / (x1 - x0 || 1), (h - 2 * pad) / (y1 - y0 || 1));
    const ox = (w - (x1 - x0) * s) / 2, oy = (h - (y1 - y0) * s) / 2;
    const d = polys.map((rings) => rings.map((r) =>
      "M" + r.map(([x, y]) => `${(ox + (x - x0) * s).toFixed(2)},${(oy + (y1 - y) * s).toFixed(2)}`).join("L") + "Z").join("")).join("");
    const svg = $("geo-preview");
    svg.innerHTML = "";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill-rule", "evenodd");
    svg.appendChild(path);
    svg.hidden = false;
  }

  // ------------------------------------------------------------------ opcionais
  function optionalFile(inputId, nameId, clearId, key, emptyText, parse) {
    $(inputId).addEventListener("change", async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        state[key] = await parse(f);
        $(nameId).textContent = `✔ ${f.name}`;
        $(nameId).className = "ok";
        $(clearId).hidden = false;
      } catch (err) {
        state[key] = null;
        $(nameId).textContent = `Arquivo inválido: ${err.message}`;
      }
    });
    $(clearId).addEventListener("click", () => {
      state[key] = null;
      $(nameId).textContent = emptyText;
      $(nameId).className = "muted";
      $(clearId).hidden = true;
    });
  }
  optionalFile("cep-input", "cep-name", "cep-clear", "cepBase", "Automática (IBGE, Censo 2022)",
    async (f) => ({ name: f.name, data: await f.arrayBuffer() }));
  optionalFile("cfg-input", "cfg-name", "cfg-clear", "config", "Não usar (colunas VTEX reconhecidas sozinhas)",
    async (f) => JSON.parse(await f.text()));

  $("cache-clear").addEventListener("click", async () => {
    await FreteIBGE.clearCache();
    log("CEPs salvos no navegador apagados. A próxima geração baixa de novo do IBGE.", "info");
  });

  // ------------------------------------------------------------------ gerar
  function checkReady() {
    const ok = state.freight.length > 0 && state.geojson && !state.running;
    $("run").disabled = !ok;
    if (state.running) return;
    if (!state.freight.length) setStatus("Escolha as planilhas de frete.");
    else if (!state.geojson) setStatus("Escolha o range da loja (.geojson).");
    else if (state.freight.length !== EXPECTED_FREIGHT_FILES)
      setStatus(`Pronto para gerar (${state.freight.length} planilha(s); o normal são ${EXPECTED_FREIGHT_FILES}).`);
    else setStatus("Pronto para gerar.");
  }

  $("run").addEventListener("click", async () => {
    state.running = true;
    $("run").disabled = true;
    $("result").hidden = true;
    state.urls.forEach(URL.revokeObjectURL);
    state.urls = [];
    setProgress(0);
    log(`Iniciando: ${state.freight.length} planilha(s), range ${state.geojson.name}`);
    try {
      const freightFiles = await Promise.all(state.freight.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
      const res = await FreteProcessor.run({
        freightFiles,
        geojson: state.geojson.data,
        cepBase: state.cepBase,
        columnConfig: state.config,
        ibge: (polys, lg) => ibge.cepsForPolygon(polys, lg),
        progress: (pct, msg) => { setProgress(pct); setStatus(msg); },
        log,
      });
      showResult(res);
      setStatus(`Concluído! ${res.files.length} planilhas + ${res.zip.name}`, "success");
      log("Concluído com sucesso!", "success");
    } catch (err) {
      console.error(err);
      const msg = /fetch|network/i.test(err.message)
        ? "Erro de conexão com o IBGE. A 1ª vez numa cidade precisa de internet; tente de novo."
        : err.message;
      setStatus(msg, "error");
      log(msg, "error");
      setProgress(0);
    } finally {
      state.running = false;
      $("run").disabled = false;
    }
  });

  function blobUrl(file) {
    const type = file.name.endsWith(".zip") ? "application/zip" : "application/vnd.ms-excel";
    const url = URL.createObjectURL(new Blob([file.data], { type }));
    state.urls.push(url);
    return url;
  }

  function showResult(res) {
    $("result-summary").textContent =
      `${res.cepsCount.toLocaleString("pt-BR")} CEPs no range · ${res.rowsProcessed.toLocaleString("pt-BR")} faixas mantidas · ${res.files.length} planilhas`;
    $("zip-link").href = blobUrl(res.zip);
    $("zip-link").download = res.zip.name;
    $("result-list").replaceChildren(...res.files.map((f) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = blobUrl(f);
      a.download = f.name;
      a.textContent = f.name;
      li.appendChild(a);
      return li;
    }));
    $("result").hidden = false;
  }

  renderFreight();
})();
