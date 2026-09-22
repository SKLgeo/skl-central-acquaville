/* Painel "Simulação de financiamento" da Central (Configurações) — SKL (Base / Unificado). NÃO faz parte do app da Carmel.
 * A Central (administrador ou controle de vendas) configura aqui o que o corretor vê no simulador:
 *   - ativar/desativar, parâmetros gerais (opções de parcelas, entrada padrão, renda comprometida, aviso legal);
 *   - condições de financiamento (banco, SAC/Price, taxa, entrada mínima, prazos, seguros...), com "modelo pronto";
 *   - IMPORTAÇÃO POR PLANILHA (.xlsx / .csv): o sistema lê, valida, mostra a prévia e implementa;
 *   - chave de integração (API) para um banco/parceiro enviar as mesmas condições automaticamente (administrador).
 * Depende de: window.XLSX (vendor/xlsx/xlsx.mini.min.js) e window.SKLSimulador (simulador.js).
 * Uso: SKLSimuladorAdmin.montar(container, { sb, getEmpreendimentoId, getPapel, toast, modeloUrl })
 */
(function () {
    "use strict";

    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const $ = (sel, root) => (root || document).querySelector(sel);
    const A = { sb: null, opts: null, box: null, empId: null, config: null, conds: [], tokenInfo: null, prev: null, editandoId: null };

    const TIPOS = { financiamento_bancario: "Financiamento bancário", parcelamento_direto: "Parcelamento direto", outro: "Outro" };
    const IDX = { TR: "TR", IPCA: "IPCA", INCC: "INCC", IGPM: "IGP-M", nenhum: "Nenhum" };
    const AVISO_PADRAO = "Simulação meramente ilustrativa, sem valor de proposta ou aprovação de crédito. Taxas, seguros e prazos podem variar conforme análise da instituição financeira.";
    const fmtNum = (n, c = 2) => Number(n).toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c });
    const toast = (m) => { if (A.opts && typeof A.opts.toast === "function") A.opts.toast(m); else alert(m); };
    const limpaErro = (msg) => String(msg || "").replace(/^.*SIM_INVALID:\s*/, "").replace(/^FORBIDDEN.*/, "Sem permissão para esta ação.");
    const papel = () => (A.opts && typeof A.opts.getPapel === "function" ? A.opts.getPapel() : "");

    const CSS = `
.sa-panel{grid-column:1/-1}
.sa-sec{border-top:1px solid #e2eaee;margin-top:16px;padding-top:14px}
.sa-sec h3{margin:0 0 6px;font-size:15px;color:var(--navy,#0c3b57)}
.sa-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.sa-row .row-button{border:0;background:#e9eff1;color:var(--navy,#0B4F78);border-radius:8px;padding:8px 12px;font-weight:800;cursor:pointer}.sa-row .row-button.danger-button{background:#f7e4e1;color:#a3352b}
.sa-toggle{display:flex;align-items:center;gap:12px;background:#f4f8fa;border:1px solid #dce7ec;border-radius:12px;padding:10px 14px;margin:8px 0}
.sa-toggle input{width:22px;height:22px}
.sa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.sa-grid label{display:block;font-size:12px;font-weight:700;color:#5b6f78}
.sa-grid input,.sa-grid select,.sa-grid textarea,.sa-cond input,.sa-cond select,.sa-cond textarea{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #cdd9df;border-radius:8px;font-size:14px;font-family:inherit;margin-top:3px}
.sa-cond-item{display:flex;justify-content:space-between;gap:10px;align-items:center;border:1px solid #dce7ec;border-radius:12px;padding:10px 12px;margin:8px 0;background:#fff}
.sa-cond-item.off{opacity:.55}
.sa-cond-item b{display:block;color:var(--navy,#0c3b57)}
.sa-cond-item small{display:block;color:#6a7d86;font-size:12px}
.sa-tag{display:inline-block;font-size:10.5px;font-weight:800;border-radius:6px;padding:1px 6px;margin-left:6px;background:#e6eef3;color:#45606c;vertical-align:middle}
.sa-tag.mod{background:#fbeec2;color:#7a5200}.sa-tag.pl{background:#d6efe0;color:#1f6a44}.sa-tag.api{background:#e1dcf5;color:#4a3a92}
.sa-sec{min-width:0}
.sa-prev{overflow:auto;margin-top:10px;border:1px solid #dce7ec;border-radius:10px;max-height:320px}
.sa-prev table{border-collapse:collapse;width:100%;font-size:12.5px}
.sa-prev th,.sa-prev td{padding:6px 8px;border-bottom:1px solid #edf2f4;text-align:left;white-space:nowrap}
.sa-prev th{background:#f4f8fa;position:sticky;top:0}
.sa-prev tr.bad td{background:#fdf1f0;color:#8d3d35}
.sa-ok{color:#1f6a44;font-weight:700}
.sa-token{font-family:Consolas,monospace;background:#0d2a3a;color:#c8f0ff;border-radius:8px;padding:10px 12px;word-break:break-all;font-size:13px;margin:8px 0}
.sa-code{font-family:Consolas,monospace;background:#f1f5f7;border-radius:8px;padding:10px 12px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:8px 0}
.sa-hint{font-size:12.5px;color:#5b6f78;margin:4px 0 8px}
dialog.sa-dlg{border:0;border-radius:16px;padding:0;max-width:min(680px,96vw);width:100%;background:#fff;box-shadow:0 28px 80px rgba(0,0,0,.35)}
dialog.sa-dlg::backdrop{background:rgba(7,31,59,.6)}
.sa-cond{padding:20px;max-height:90vh;overflow:auto;background:#fff;border-radius:16px}
.sa-cond h2{margin:0 0 10px;color:var(--navy,#0c3b57)}
.sa-cond .sa-grid label{margin-bottom:2px}`;

    // ------------------------------------------------------------------ leitura de planilha
    const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    // ordem importa: o primeiro padrão que casar (e cuja chave ainda não foi usada) vence
    const MAPA = [
        ["nome", /^nome|condicao/], ["banco", /banco|instituicao/], ["sistema", /sistema|amortiza/], ["indexador", /indexador|correcao/],
        ["tipo_taxa", /tipo (da )?taxa|nominal ou efetiva/], ["taxa_aa", /^taxa|juros/], ["entrada_min_pct", /entrada/],
        ["financiavel_max_pct", /financiamento maximo|financiavel|ltv/], ["opcoes_prazo", /opcoes/], ["prazo_min_meses", /prazo min/],
        ["prazo_max_meses", /prazo max/], ["seguro_mip_pct_mes", /mip/], ["seguro_dfi_pct_mes", /dfi/], ["tarifa_mensal", /tarifa/],
        ["vigencia_ate", /valid|vigenc/], ["fonte", /fonte/], ["observacao", /observ/], ["ativo", /^ativ/], ["tipo", /^tipo/]
    ];
    const PERCENTUAIS = new Set(["taxa_aa", "entrada_min_pct", "financiavel_max_pct", "seguro_mip_pct_mes", "seguro_dfi_pct_mes"]);
    const NUMEROS = new Set([...PERCENTUAIS, "prazo_min_meses", "prazo_max_meses", "tarifa_mensal"]);
    const ROTULO = { nome: "Nome", tipo: "Tipo", banco: "Banco", sistema: "Sistema", taxa_aa: "Taxa a.a.", tipo_taxa: "Tipo da taxa", indexador: "Indexador", entrada_min_pct: "Entrada mín.", financiavel_max_pct: "Financiamento máx.", prazo_min_meses: "Prazo mín.", prazo_max_meses: "Prazo máx.", opcoes_prazo: "Opções de prazo", seguro_mip_pct_mes: "MIP", seguro_dfi_pct_mes: "DFI", tarifa_mensal: "Tarifa", vigencia_ate: "Válida até" };

    function num(v) {
        if (v == null || v === "") return null;
        if (typeof v === "number") return v;
        let s = String(v).trim().replace(/%/g, "").replace(/\s/g, "").replace(/^R\$/i, "");
        if (!s) return null;
        if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
        const n = parseFloat(s);
        return Number.isFinite(n) && /^-?[\d.]+$/.test(s) ? n : NaN;
    }
    function dataIso(v) {
        if (v == null || v === "") return null;
        if (v instanceof Date && !isNaN(v)) { const d = new Date(v.getTime() + 12 * 3600e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
        if (typeof v === "number" && v > 20000) return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
        const s = String(v).trim();
        let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
        m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[1]}-${m[2]}-${m[3]}` : NaN;
    }
    function parseCsv(texto) {
        const t = texto.replace(/^﻿/, "");
        const primeira = t.split(/\r?\n/, 1)[0] || "";
        const delim = [";", "\t", ","].map((d) => [d, primeira.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
        const rows = []; let row = [], cur = "", q = false;
        for (let i = 0; i < t.length; i++) {
            const c = t[i];
            if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
            else if (c === '"') q = true;
            else if (c === delim) { row.push(cur); cur = ""; }
            else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
            else cur += c;
        }
        if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
        return rows;
    }
    // rows: matriz de células; fmtPct(r,c): true se a célula tem formato de porcentagem (só xlsx)
    function extrairLinhas(rows, fmtPct) {
        let h = rows.findIndex((r) => { const n = r.map(norm); return n.some((x) => /^nome|condicao/.test(x)) && n.some((x) => /taxa|juros/.test(x)); });
        if (h < 0) throw new Error("Não encontrei a linha de títulos (precisa ter “Nome da condição” e “Taxa de juros”). Use a planilha modelo.");
        const usados = new Set(), col = {};
        rows[h].forEach((cel, c) => {
            const t = norm(cel); if (!t) return;
            for (const [chave, re] of MAPA) if (!usados.has(chave) && re.test(t)) { col[chave] = c; usados.add(chave); break; }
        });
        if (col.nome == null || col.taxa_aa == null) throw new Error("A planilha precisa das colunas “Nome da condição” e “Taxa de juros ao ano (%)”.");
        const linhas = []; let exemplos = 0;
        for (let i = h + 1; i < rows.length; i++) {
            const r = rows[i] || [];
            if (!r.some((x) => x != null && String(x).trim() !== "")) continue;
            const nomeBruto = String(r[col.nome] ?? "").trim();
            if (/^\(?\s*exemplo/i.test(nomeBruto)) { exemplos++; continue; }
            const item = { _linha: i + 1, _erros: [] };
            for (const chave of Object.keys(col)) {
                let v = r[col[chave]];
                if (v == null || (typeof v === "string" && v.trim() === "")) continue;
                if (NUMEROS.has(chave)) {
                    let n = num(v);
                    if (typeof n === "number" && !isNaN(n) && PERCENTUAIS.has(chave) && typeof v === "number" && fmtPct && fmtPct(i, col[chave]) && n <= 1) n = n * 100;
                    if (Number.isNaN(n)) { item._erros.push(`valor inválido em “${ROTULO[chave]}”`); continue; }
                    item[chave] = n;
                } else if (chave === "vigencia_ate") {
                    const d = dataIso(v); if (Number.isNaN(d)) item._erros.push("data inválida em “Válida até” (use dd/mm/aaaa)"); else item[chave] = d;
                } else if (chave === "ativo") {
                    item.ativo = !/^(nao|não|n|0|false|inativ)/i.test(String(v).trim());
                } else item[chave] = String(v).trim();
            }
            if (!item.nome || item.nome.length < 2) item._erros.push("informe o nome da condição");
            if (item.taxa_aa == null) item._erros.push("informe a taxa de juros ao ano (use 0 se não houver juros)");
            else if (item.taxa_aa < 0 || item.taxa_aa > 100) item._erros.push("taxa ao ano deve ficar entre 0 e 100");
            if (item.prazo_min_meses != null && item.prazo_max_meses != null && item.prazo_max_meses < item.prazo_min_meses) item._erros.push("prazo máximo menor que o mínimo");
            if (item.sistema && !/^(sac|price|tabela price)$/i.test(item.sistema)) item._erros.push("sistema deve ser SAC ou PRICE");
            if (item.entrada_min_pct != null && (item.entrada_min_pct < 0 || item.entrada_min_pct >= 100)) item._erros.push("entrada mínima deve ficar entre 0 e 99");
            linhas.push(item);
        }
        return { linhas, exemplos };
    }
    async function lerArquivo(file) {
        const nome = file.name || "planilha";
        if (/\.csv$/i.test(nome) || /^text\//.test(file.type || "")) {
            const texto = await file.text();
            return { ...extrairLinhas(parseCsv(texto), null), nome };
        }
        if (!window.XLSX) throw new Error("Leitor de planilhas indisponível neste aparelho. Salve a planilha como .csv e tente de novo.");
        const buf = await file.arrayBuffer();
        const wb = window.XLSX.read(buf, { type: "array", cellDates: true, cellNF: true });
        const nomeAba = wb.SheetNames.find((n) => /condi|financ|simul/i.test(n)) || wb.SheetNames.find((n) => !/como|instru|lista/i.test(n)) || wb.SheetNames[0];
        const ws = wb.Sheets[nomeAba];
        const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
        const r0 = ws["!ref"] ? window.XLSX.utils.decode_range(ws["!ref"]).s.r : 0;
        const c0 = ws["!ref"] ? window.XLSX.utils.decode_range(ws["!ref"]).s.c : 0;
        const fmtPct = (r, c) => { const cel = ws[window.XLSX.utils.encode_cell({ r: r0 + r, c: c0 + c })]; return !!(cel && cel.z && /%/.test(String(cel.z))); };
        return { ...extrairLinhas(rows, fmtPct), nome };
    }

    // ------------------------------------------------------------------ dados
    async function carregar() {
        const [{ data: cfg }, { data: conds }] = await Promise.all([
            A.sb.from("simulador_config").select("*").eq("empreendimento_id", A.empId).maybeSingle(),
            A.sb.from("simulador_condicoes").select("*").eq("empreendimento_id", A.empId).order("ordem", { ascending: true }).order("criado_em", { ascending: true })
        ]);
        A.config = cfg || null; A.conds = conds || [];
        try { const { data } = await A.sb.rpc("simulador_token_info", { p_empreendimento_id: A.empId }); A.tokenInfo = data || { existe: false }; } catch (e) { A.tokenInfo = { existe: false }; }
    }
    async function recarregarTudo() {
        try { await carregar(); } catch (e) { toast("Não foi possível carregar o simulador: " + limpaErro(e.message)); }
        render();
        if (window.SKLSimulador) window.SKLSimulador.recarregar();
    }
    async function rpc(nome, args) {
        const { data, error } = await A.sb.rpc(nome, args);
        if (error) throw new Error(limpaErro(error.message));
        return data;
    }

    // ------------------------------------------------------------------ render
    function condResumo(c) {
        const taxa = c.taxa_aa > 0 ? `${fmtNum(c.taxa_aa)}% a.a.${c.tipo_taxa === "efetiva" ? " (efetiva)" : ""}${c.indexador !== "nenhum" ? " + " + IDX[c.indexador] : ""}` : `sem juros${c.indexador !== "nenhum" ? " · " + IDX[c.indexador] : ""}`;
        return `${TIPOS[c.tipo] || c.tipo}${c.banco ? " · " + esc(c.banco) : ""} · ${c.sistema === "sac" ? "SAC" : "Price"} · ${taxa} · entrada mín. ${fmtNum(Math.max(c.entrada_min_pct, 100 - c.financiavel_max_pct), 0)}% · ${c.prazo_min_meses}–${c.prazo_max_meses} meses`;
    }
    function render() {
        const box = A.box; if (!box) return;
        const cfg = A.config || { ativo: false, parcelas_opcoes: [60, 120, 180, 240, 300, 360, 420], entrada_padrao_pct: 20, renda_comprometimento_pct: 30, aviso_texto: AVISO_PADRAO };
        const ehAdmin = papel() === "administrador";
        const tag = (o) => o === "modelo" ? `<span class="sa-tag mod">MODELO</span>` : o === "planilha" ? `<span class="sa-tag pl">PLANILHA</span>` : o === "api" ? `<span class="sa-tag api">API</span>` : "";
        box.innerHTML = `
<span class="eyebrow">SIMULADOR</span>
<h2>Simulação de financiamento</h2>
<p class="muted-text">Defina as condições que o corretor usa para simular parcelas no app — na ficha do lote/unidade e no pedido de reserva. O corretor só vê o que estiver ativo aqui.</p>
<label class="sa-toggle"><input type="checkbox" id="saAtivo" ${cfg.ativo ? "checked" : ""}><span><b>Ativar o simulador para os corretores</b><br><small id="saAtivoHint">${cfg.ativo ? "Ativo: os corretores já veem o botão “Simular financiamento”." : "Desativado: os corretores não veem o simulador."}</small></span></label>
<div id="saMsg" class="form-message" hidden></div>

<div class="sa-sec"><h3>1 · Condições de financiamento</h3>
  <p class="sa-hint">Cada condição é uma opção que o corretor pode escolher (ex.: financiamento do banco parceiro em SAC ou Price, parcelamento direto com a construtora).</p>
  <div id="saLista">${A.conds.length ? A.conds.map((c) => `<div class="sa-cond-item${c.ativo ? "" : " off"}"><div><b>${esc(c.nome)}${tag(c.origem)}</b><small>${condResumo(c)}</small>${c.fonte ? `<small>Fonte: ${esc(c.fonte)}</small>` : ""}${c.vigencia_ate ? `<small>Válida até ${esc(c.vigencia_ate.split("-").reverse().join("/"))}</small>` : ""}</div>
    <div class="sa-row"><button type="button" class="row-button" data-a="editar" data-id="${esc(c.id)}">Editar</button><button type="button" class="row-button" data-a="ativar" data-id="${esc(c.id)}" data-v="${c.ativo ? 0 : 1}">${c.ativo ? "Desativar" : "Ativar"}</button><button type="button" class="row-button danger-button" data-a="excluir" data-id="${esc(c.id)}">Excluir</button></div></div>`).join("") : `<div class="empty-state">Nenhuma condição cadastrada ainda. Comece pelo modelo pronto ou importe uma planilha.</div>`}</div>
  <div class="sa-row"><button type="button" class="primary-button" data-a="nova">+ Nova condição</button><button type="button" class="secondary-button" data-a="modelo">Aplicar modelo pronto</button><button type="button" class="secondary-button" data-a="testar">Testar simulação</button></div>
</div>

<div class="sa-sec"><h3>2 · Parâmetros gerais</h3>
  <div class="sa-grid">
    <label>Opções de parcelas sugeridas (meses, separadas por vírgula)<input id="saOpcoes" value="${esc((cfg.parcelas_opcoes || []).join(", "))}"></label>
    <label>Entrada sugerida ao abrir (%)<input id="saEntradaPadrao" inputmode="decimal" value="${esc(fmtNum(cfg.entrada_padrao_pct, 0))}"></label>
    <label>Comprometimento de renda para a renda mínima (%)<input id="saRenda" inputmode="decimal" value="${esc(fmtNum(cfg.renda_comprometimento_pct, 0))}"></label>
  </div>
  <label class="sa-grid" style="display:block;margin-top:10px"><span style="font-size:12px;font-weight:700;color:#5b6f78">Aviso mostrado ao corretor e ao cliente</span><textarea id="saAviso" rows="3" style="width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #cdd9df;border-radius:8px;font-family:inherit;font-size:14px;margin-top:3px">${esc(cfg.aviso_texto || AVISO_PADRAO)}</textarea></label>
  <div class="sa-row" style="margin-top:10px"><button type="button" class="primary-button" data-a="salvarparams">Salvar parâmetros</button></div>
</div>

<div class="sa-sec"><h3>3 · Importar por planilha</h3>
  <p class="sa-hint">Baixe a planilha modelo, preencha as condições (uma por linha) e anexe aqui. O sistema lê, mostra uma prévia e só grava se estiver tudo certo. Aceita .xlsx e .csv.</p>
  <div class="sa-row"><button type="button" class="secondary-button" data-a="baixarmodelo">Baixar planilha modelo (.xlsx)</button>
    <label class="secondary-button" style="cursor:pointer;margin:0">Anexar planilha preenchida<input type="file" id="saArquivo" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></label></div>
  <div id="saPreview"></div>
</div>

<div class="sa-sec"><h3>4 · Integração automática (banco ou parceiro)</h3>
  <p class="sa-hint">Para quem quer que um banco, correspondente ou sistema envie as taxas sozinho: gere uma chave e entregue ao parceiro junto com o endereço abaixo. Ele envia as mesmas colunas da planilha (em JSON). Nenhum dado de cliente trafega nessa integração.</p>
  ${ehAdmin ? `<div class="sa-row"><button type="button" class="secondary-button" data-a="gerartoken">${A.tokenInfo && A.tokenInfo.existe ? "Gerar nova chave (invalida a atual)" : "Gerar chave de integração"}</button>${A.tokenInfo && A.tokenInfo.existe ? `<button type="button" class="row-button danger-button" data-a="revogartoken">Revogar chave</button>` : ""}</div>
  <p class="sa-hint">${A.tokenInfo && A.tokenInfo.existe ? `Chave ativa desde ${new Date(A.tokenInfo.criado_em).toLocaleString("pt-BR")}${A.tokenInfo.ultimo_uso ? ` · último uso ${new Date(A.tokenInfo.ultimo_uso).toLocaleString("pt-BR")}` : " · ainda não usada"}.` : "Nenhuma chave gerada."}</p><div id="saTokenBox"></div>` : `<p class="sa-hint">Somente o administrador gera a chave de integração.</p>`}
  <div class="sa-code">POST https://xigwlofqkmiibzbongkn.supabase.co/functions/v1/simulador-condicoes
Authorization: Bearer &lt;chave&gt;
Content-Type: application/json

{ "modo": "substituir", "fonte": "Banco X — tabela de 19/09/2026",
  "condicoes": [ { "nome": "Financiamento SAC", "tipo": "financiamento_bancario", "sistema": "SAC",
    "taxa_aa": 11.49, "tipo_taxa": "nominal", "indexador": "TR", "entrada_min_pct": 20, "financiavel_max_pct": 80,
    "prazo_min_meses": 60, "prazo_max_meses": 420, "opcoes_prazo": [120,240,360],
    "seguro_mip_pct_mes": 0.03, "seguro_dfi_pct_mes": 0.01, "tarifa_mensal": 25 } ] }</div>
</div>`;
        wire();
    }

    // ------------------------------------------------------------------ ações
    function mostrarMsg(texto, ok) {
        const m = $("#saMsg", A.box); if (!m) return;
        m.textContent = texto; m.hidden = !texto;
        m.style.background = ok ? "#e6f5ec" : ""; m.style.color = ok ? "#1f6a44" : "";
    }
    function lerNumero(id, padrao) { const n = num($(id, A.box).value); return Number.isFinite(n) ? n : padrao; }
    async function salvarConfig(extra) {
        const cfg = A.config || {};
        const opcoes = ($("#saOpcoes", A.box) ? $("#saOpcoes", A.box).value : (cfg.parcelas_opcoes || []).join(",")).split(/[^\d]+/).filter(Boolean).map(Number);
        await rpc("simulador_salvar_config", {
            p_empreendimento_id: A.empId,
            p_ativo: extra && typeof extra.ativo === "boolean" ? extra.ativo : !!$("#saAtivo", A.box).checked,
            p_parcelas_opcoes: opcoes.length ? opcoes : null,
            p_entrada_padrao_pct: $("#saEntradaPadrao", A.box) ? lerNumero("#saEntradaPadrao", 20) : cfg.entrada_padrao_pct || 20,
            p_renda_pct: $("#saRenda", A.box) ? lerNumero("#saRenda", 30) : cfg.renda_comprometimento_pct || 30,
            p_aviso: $("#saAviso", A.box) ? $("#saAviso", A.box).value : cfg.aviso_texto
        });
    }
    function abrirEditor(cond) {
        A.editandoId = cond ? cond.id : null;
        let d = $("#saCondDialog");
        if (!d) { d = document.createElement("dialog"); d.id = "saCondDialog"; d.className = "sa-dlg"; document.body.appendChild(d); }
        const c = cond || { nome: "", tipo: "financiamento_bancario", banco: "", sistema: "price", taxa_aa: 11.49, tipo_taxa: "nominal", indexador: "TR", entrada_min_pct: 20, financiavel_max_pct: 80, prazo_min_meses: 60, prazo_max_meses: 420, opcoes_prazo: [120, 180, 240, 300, 360, 420], seguro_mip_pct_mes: 0.03, seguro_dfi_pct_mes: 0.01, tarifa_mensal: 25, vigencia_ate: "", fonte: "", observacao: "", ativo: true };
        const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, t]) => `<option value="${k}"${k === v ? " selected" : ""}>${t}</option>`).join("")}</select>`;
        d.innerHTML = `<div class="sa-cond"><button type="button" class="dialog-close" data-x="1" style="float:right">×</button><span class="eyebrow">SIMULADOR</span><h2>${cond ? "Editar condição" : "Nova condição"}</h2>
<div class="sa-grid">
 <label style="grid-column:1/-1">Nome da condição *<input id="scNome" value="${esc(c.nome)}" placeholder="Ex.: Financiamento Banco X — SAC"></label>
 <label>Tipo${sel("scTipo", [["financiamento_bancario", "Financiamento bancário"], ["parcelamento_direto", "Parcelamento direto"], ["outro", "Outro"]], c.tipo)}</label>
 <label>Banco ou instituição<input id="scBanco" value="${esc(c.banco || "")}"></label>
 <label>Sistema de amortização${sel("scSistema", [["price", "Price (parcelas fixas)"], ["sac", "SAC (parcelas decrescentes)"]], c.sistema)}</label>
 <label>Taxa de juros ao ano (%)<input id="scTaxa" inputmode="decimal" value="${esc(fmtNum(c.taxa_aa))}"></label>
 <label>Tipo da taxa${sel("scTipoTaxa", [["nominal", "Nominal"], ["efetiva", "Efetiva"]], c.tipo_taxa)}</label>
 <label>Indexador${sel("scIdx", [["nenhum", "Nenhum"], ["TR", "TR"], ["IPCA", "IPCA"], ["INCC", "INCC"], ["IGPM", "IGP-M"]], c.indexador)}</label>
 <label>Entrada mínima (%)<input id="scEntrada" inputmode="decimal" value="${esc(fmtNum(c.entrada_min_pct, 0))}"></label>
 <label>Financiamento máximo (% do imóvel)<input id="scFin" inputmode="decimal" value="${esc(fmtNum(c.financiavel_max_pct, 0))}"></label>
 <label>Prazo mínimo (meses)<input id="scPmin" inputmode="numeric" value="${esc(c.prazo_min_meses)}"></label>
 <label>Prazo máximo (meses)<input id="scPmax" inputmode="numeric" value="${esc(c.prazo_max_meses)}"></label>
 <label style="grid-column:1/-1">Opções de prazo mostradas ao corretor (meses, separadas por vírgula)<input id="scOpcoes" value="${esc((c.opcoes_prazo || []).join(", "))}"></label>
 <label>Seguro MIP (% ao mês sobre o saldo)<input id="scMip" inputmode="decimal" value="${esc(fmtNum(c.seguro_mip_pct_mes, 3))}"></label>
 <label>Seguro DFI (% ao mês sobre o imóvel)<input id="scDfi" inputmode="decimal" value="${esc(fmtNum(c.seguro_dfi_pct_mes, 3))}"></label>
 <label>Tarifa mensal (R$)<input id="scTarifa" inputmode="decimal" value="${esc(fmtNum(c.tarifa_mensal))}"></label>
 <label>Válida até<input id="scVig" type="date" value="${esc(c.vigencia_ate || "")}"></label>
 <label style="grid-column:1/-1">Fonte das informações<input id="scFonte" value="${esc(c.fonte || "")}" placeholder="Ex.: Tabela do Banco X de 19/09/2026"></label>
 <label style="grid-column:1/-1">Observação (aparece só para a Central)<textarea id="scObs" rows="2">${esc(c.observacao || "")}</textarea></label>
 <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="scAtivo" ${c.ativo ? "checked" : ""} style="width:auto;margin:0"> Condição ativa (visível ao corretor)</label>
</div>
<div id="scMsg" class="form-message" hidden></div>
<div class="sa-row" style="margin-top:14px"><button type="button" class="primary-button" data-x="salvar">Salvar condição</button><button type="button" class="secondary-button" data-x="fechar">Cancelar</button></div></div>`;
        d.onclick = async (ev) => {
            const a = ev.target.closest && ev.target.closest("[data-x]"); if (!a) return;
            if (a.dataset.x === "1" || a.dataset.x === "fechar") return d.close();
            if (a.dataset.x === "salvar") {
                const g = (id) => $(id, d).value;
                const dados = { nome: g("#scNome"), tipo: g("#scTipo"), banco: g("#scBanco"), sistema: g("#scSistema"), taxa_aa: num(g("#scTaxa")), tipo_taxa: g("#scTipoTaxa"), indexador: g("#scIdx"), entrada_min_pct: num(g("#scEntrada")), financiavel_max_pct: num(g("#scFin")), prazo_min_meses: num(g("#scPmin")), prazo_max_meses: num(g("#scPmax")), opcoes_prazo: g("#scOpcoes").split(/[^\d]+/).filter(Boolean).map(Number), seguro_mip_pct_mes: num(g("#scMip")), seguro_dfi_pct_mes: num(g("#scDfi")), tarifa_mensal: num(g("#scTarifa")), vigencia_ate: g("#scVig") || null, fonte: g("#scFonte"), observacao: g("#scObs"), ativo: $("#scAtivo", d).checked };
                Object.keys(dados).forEach((k) => { if (typeof dados[k] === "number" && Number.isNaN(dados[k])) dados[k] = null; });
                try { await rpc("simulador_salvar_condicao", { p_empreendimento_id: A.empId, p_id: A.editandoId, p_dados: dados }); d.close(); toast("Condição salva."); await recarregarTudo(); }
                catch (e) { const m = $("#scMsg", d); m.textContent = e.message; m.hidden = false; }
            }
        };
        d.showModal();
    }

    async function baixarModelo() {
        try {
            const url = (A.opts && A.opts.modeloUrl) || "modelo-simulacao-financiamento.xlsx";
            const resp = await fetch(url); if (!resp.ok) throw new Error("arquivo do modelo não encontrado");
            const buf = await resp.arrayBuffer();
            const nome = "Modelo_Condicoes_Financiamento.xlsx";
            if (window.NativeBridge && window.NativeBridge.saveTextFile) {
                let bin = ""; const u8 = new Uint8Array(buf); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
                window.NativeBridge.saveTextFile(btoa(bin), nome, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
                return;
            }
            const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })); a.download = nome;
            document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            toast(nome + " salvo na pasta de downloads.");
        } catch (e) { toast("Não foi possível baixar o modelo: " + e.message); }
    }

    function pintarPrevia() {
        const box = $("#saPreview", A.box); if (!box) return;
        const p = A.prev; if (!p) { box.innerHTML = ""; return; }
        const bons = p.linhas.filter((l) => !l._erros.length).length, ruins = p.linhas.length - bons;
        box.innerHTML = `<p class="sa-hint" style="margin-top:12px"><b>${esc(p.nome)}</b> · ${p.linhas.length} condição(ões) encontrada(s)${p.exemplos ? ` · ${p.exemplos} linha(s) de exemplo ignorada(s)` : ""}${ruins ? ` · <span style="color:#8d3d35;font-weight:700">${ruins} com problema</span>` : ` · <span class="sa-ok">tudo certo</span>`}</p>
<div class="sa-prev"><table><thead><tr><th>Linha</th><th>Nome</th><th>Tipo</th><th>Sistema</th><th>Taxa a.a.</th><th>Entrada mín.</th><th>Prazo</th><th>Situação</th></tr></thead><tbody>${p.linhas.map((l) => `<tr class="${l._erros.length ? "bad" : ""}"><td>${l._linha}</td><td>${esc(l.nome || "—")}</td><td>${esc(l.tipo || "—")}</td><td>${esc(l.sistema || "—")}</td><td>${l.taxa_aa != null ? fmtNum(l.taxa_aa) + "%" : "—"}</td><td>${l.entrada_min_pct != null ? fmtNum(l.entrada_min_pct, 0) + "%" : "—"}</td><td>${l.prazo_min_meses != null || l.prazo_max_meses != null ? (l.prazo_min_meses ?? "?") + "–" + (l.prazo_max_meses ?? "?") : "—"}</td><td>${l._erros.length ? esc(l._erros.join("; ")) : `<span class="sa-ok">OK</span>`}</td></tr>`).join("")}</tbody></table></div>
<div class="sa-row" style="margin-top:10px"><label><input type="radio" name="saModo" value="adicionar" checked> Adicionar às condições existentes</label><label><input type="radio" name="saModo" value="substituir"> Substituir todas as condições</label></div>
<div class="sa-row" style="margin-top:8px"><button type="button" class="primary-button" data-a="importar" ${ruins || !bons ? "disabled" : ""}>Importar ${bons} condição(ões)</button><button type="button" class="secondary-button" data-a="cancelarimp">Cancelar</button></div>`;
        box.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", () => acao(b)));
    }

    async function acao(el) {
        const a = el.dataset.a, id = el.dataset.id;
        try {
            if (a === "nova") return abrirEditor(null);
            if (a === "editar") return abrirEditor(A.conds.find((c) => String(c.id) === String(id)));
            if (a === "ativar") { await rpc("simulador_ativar_condicao", { p_id: id, p_ativo: el.dataset.v === "1" }); return recarregarTudo(); }
            if (a === "excluir") { if (!confirm("Excluir esta condição? O corretor deixa de vê-la.")) return; await rpc("simulador_excluir_condicao", { p_id: id }); return recarregarTudo(); }
            if (a === "modelo") { const r = await rpc("simulador_aplicar_modelo", { p_empreendimento_id: A.empId }); toast(`Modelo aplicado: ${r.importadas} condições de exemplo. Ajuste às condições reais.`); return recarregarTudo(); }
            if (a === "testar") { if (!window.SKLSimulador) return; return window.SKLSimulador.abrir({ valor: "", rotulo: "Teste do simulador", permiteUsar: false }); }
            if (a === "salvarparams") { await salvarConfig(); toast("Parâmetros salvos."); return recarregarTudo(); }
            if (a === "baixarmodelo") return baixarModelo();
            if (a === "cancelarimp") { A.prev = null; $("#saArquivo", A.box).value = ""; return pintarPrevia(); }
            if (a === "importar") {
                const modo = (A.box.querySelector("input[name=saModo]:checked") || {}).value || "adicionar";
                if (modo === "substituir" && !confirm("Substituir TODAS as condições atuais pelas da planilha?")) return;
                const limpas = A.prev.linhas.map((l) => { const o = { ...l }; delete o._linha; delete o._erros; return o; });
                const r = await rpc("simulador_importar_condicoes", { p_empreendimento_id: A.empId, p_condicoes: limpas, p_modo: modo, p_fonte: `Planilha ${A.prev.nome} (${new Date().toLocaleDateString("pt-BR")})` });
                A.prev = null; toast(`${r.importadas} condição(ões) importada(s) com sucesso.`); return recarregarTudo();
            }
            if (a === "gerartoken") {
                if (A.tokenInfo && A.tokenInfo.existe && !confirm("Gerar uma nova chave invalida a anterior. Continuar?")) return;
                const t = await rpc("simulador_gerar_token", { p_empreendimento_id: A.empId });
                await carregar(); render();
                const b = $("#saTokenBox", A.box);
                b.innerHTML = `<p class="sa-hint"><b>Copie agora:</b> esta chave só aparece uma vez.</p><div class="sa-token" id="saTokenTxt">${esc(t)}</div><button type="button" class="secondary-button" id="saCopiar">Copiar chave</button>`;
                $("#saCopiar", b).onclick = async () => { try { await navigator.clipboard.writeText(t); toast("Chave copiada."); } catch (e) { toast("Selecione e copie a chave manualmente."); } };
                return;
            }
            if (a === "revogartoken") { if (!confirm("Revogar a chave? O parceiro deixa de conseguir enviar dados.")) return; await rpc("simulador_revogar_token", { p_empreendimento_id: A.empId }); toast("Chave revogada."); return recarregarTudo(); }
        } catch (e) { mostrarMsg(e.message); toast(e.message); }
    }
    function wire() {
        A.box.querySelectorAll("[data-a]").forEach((b) => { if (!b.closest("#saPreview")) b.addEventListener("click", () => acao(b)); });
        const at = $("#saAtivo", A.box);
        at.addEventListener("change", async () => {
            try { await salvarConfig({ ativo: at.checked }); toast(at.checked ? "Simulador ativado para os corretores." : "Simulador desativado."); await recarregarTudo(); }
            catch (e) { at.checked = !at.checked; mostrarMsg(e.message); }
        });
        $("#saArquivo", A.box).addEventListener("change", async (ev) => {
            const f = ev.target.files && ev.target.files[0]; if (!f) return;
            try { A.prev = await lerArquivo(f); if (!A.prev.linhas.length) throw new Error("Não encontrei nenhuma condição preenchida na planilha."); mostrarMsg(""); }
            catch (e) { A.prev = null; mostrarMsg(e.message); }
            pintarPrevia();
        });
        pintarPrevia();
    }

    // ------------------------------------------------------------------ entrada
    async function montar(container, opts) {
        A.opts = opts || {}; A.sb = A.opts.sb; A.box = container;
        if (!$("#saStyle")) { const s = document.createElement("style"); s.id = "saStyle"; s.textContent = CSS; document.head.appendChild(s); }
        A.empId = await A.opts.getEmpreendimentoId();
        container.hidden = false;
        await recarregarTudo();
    }
    window.SKLSimuladorAdmin = { montar, recarregar: recarregarTudo, lerArquivo, extrairLinhas, parseCsv };
})();
