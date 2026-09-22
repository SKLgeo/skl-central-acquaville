/* Simulador de financiamento — SKL (Base / Unificado). NÃO faz parte do app da Carmel.
 * Um único arquivo usado pelo App do Corretor e pela Central (mesmo código, copiado):
 *   - motor de cálculo (SAC / Price, taxa nominal ou efetiva, seguros MIP/DFI, tarifa, CET, renda mínima);
 *   - diálogo "Simulação de financiamento" (condição → entrada → prazo → resultado), ligado ao valor do lote/unidade;
 *   - bloco "Simulação escolhida" para o formulário de reserva (o snapshot segue junto do pedido: p_simulacao).
 * Condições e parâmetros vêm do banco (tabelas simulador_config / simulador_condicoes), configurados pela Central.
 * API: window.SKLSimulador = { init, ativo, abrir, escolhida, limparEscolhida, montarBlocoReserva, atualizarBloco, calcular, resumoHtml, resumoTexto, brl, parseValor }
 */
(function () {
    "use strict";

    const st = { sb: null, empId: null, papel: "corretor", toast: null, config: null, condicoes: [], ativo: false, escolhidas: {}, bloco: null, dlg: null, ctx: null };

    // ------------------------------------------------------------------ utilidades
    const fmtBRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
    const brl = (n) => fmtBRL.format(Number.isFinite(Number(n)) ? Number(n) : 0);
    const fmtNum = (n, casas = 2) => Number(n).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
    const pctTxt = (n) => `${fmtNum(n, Number.isInteger(Number(n)) ? 0 : 2)}%`;
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const $q = (sel, root) => (root || document).querySelector(sel);

    // "R$ 54.000,00" | "54000" | "54.000" | 54000  ->  54000
    function parseValor(v) {
        if (typeof v === "number") return Number.isFinite(v) ? v : 0;
        let s = String(v ?? "").replace(/[^\d.,-]/g, "");
        if (!s) return 0;
        if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
        else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : 0;
    }
    const arred = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const chaveAlvo = (alvo) => (alvo ? `${alvo.tipo}:${alvo.id || alvo.chave}` : "livre");
    const hoje = () => new Date().toISOString().slice(0, 10);
    function toast(msg) {
        if (typeof st.toast === "function") return st.toast(msg);
        if (window.SKLApp && typeof window.SKLApp.showToast === "function") return window.SKLApp.showToast(msg);
        let t = $q("#sklSimToast");
        if (!t) { t = document.createElement("div"); t.id = "sklSimToast"; t.className = "skl-sim-toast"; document.body.appendChild(t); }
        t.textContent = msg; t.classList.add("on");
        clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("on"), 3200);
    }

    // ------------------------------------------------------------------ motor de cálculo
    function taxaMensal(cond) {
        const aa = (Number(cond.taxa_aa) || 0) / 100;
        if (!(aa > 0)) return 0;
        return cond.tipo_taxa === "efetiva" ? Math.pow(1 + aa, 1 / 12) - 1 : aa / 12;
    }
    function entradaMinimaPct(cond) {
        return Math.max(Number(cond.entrada_min_pct) || 0, 100 - (Number(cond.financiavel_max_pct) || 100));
    }
    // p = { valor, entradaValor, prazo }; cond = linha de simulador_condicoes; cfg = simulador_config
    function calcular(p, cond, cfg) {
        const valor = Number(p.valor) || 0;
        const entradaValor = Math.max(0, Number(p.entradaValor) || 0);
        const prazo = Math.round(Number(p.prazo) || 0);
        const pv = valor - entradaValor;
        const entradaPct = valor > 0 ? (entradaValor / valor) * 100 : 0;
        const minPct = entradaMinimaPct(cond);
        const erros = [];
        if (valor <= 0) erros.push("Informe o valor do imóvel.");
        else if (entradaPct + 1e-9 < minPct) erros.push(`Entrada mínima desta condição: ${pctTxt(minPct)} (${brl((valor * minPct) / 100)}).`);
        if (valor > 0 && pv <= 0) erros.push("A entrada precisa ser menor que o valor do imóvel.");
        if (prazo < cond.prazo_min_meses || prazo > cond.prazo_max_meses) erros.push(`Prazo desta condição: de ${cond.prazo_min_meses} a ${cond.prazo_max_meses} meses.`);
        if (erros.length) return { ok: false, erros, entradaPct, entradaMinPct: minPct, valorFinanciado: Math.max(pv, 0) };

        const i = taxaMensal(cond);
        const mip = (Number(cond.seguro_mip_pct_mes) || 0) / 100;
        const dfi = (Number(cond.seguro_dfi_pct_mes) || 0) / 100;
        const tarifa = Number(cond.tarifa_mensal) || 0;
        const pmtPrice = cond.sistema === "price" ? (i > 0 ? (pv * i) / (1 - Math.pow(1 + i, -prazo)) : pv / prazo) : 0;
        const amortSac = pv / prazo;
        let saldo = pv, totalJuros = 0, totalSeguros = 0, totalTarifas = 0, totalParcelas = 0, primeira = 0, ultima = 0;
        const tabela = [], fluxo = [];
        for (let k = 1; k <= prazo; k++) {
            const juros = saldo * i;
            const amort = cond.sistema === "price" ? pmtPrice - juros : amortSac;
            const base = cond.sistema === "price" ? pmtPrice : amort + juros;
            const seguros = saldo * mip + valor * dfi;
            const parcela = base + seguros + tarifa;
            totalJuros += juros; totalSeguros += seguros; totalTarifas += tarifa; totalParcelas += parcela;
            if (k === 1) primeira = parcela;
            if (k === prazo) ultima = parcela;
            saldo = Math.max(0, saldo - amort);
            tabela.push({ k, juros, amort, seguros, tarifa, parcela, saldo });
            fluxo.push(parcela);
        }
        // CET: taxa mensal r que iguala o valor financiado ao fluxo de parcelas (bisseção)
        let cetAa = null;
        if (pv > 0) {
            const vp = (r) => { let s = 0; for (let k = 1; k <= prazo; k++) s += fluxo[k - 1] / Math.pow(1 + r, k); return s; };
            let lo = 0, hi = 1;
            if (vp(0) > pv) { for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (vp(mid) > pv) lo = mid; else hi = mid; } cetAa = Math.pow(1 + (lo + hi) / 2, 12) - 1; }
            else cetAa = 0;
        }
        const comprometimento = Number(cfg && cfg.renda_comprometimento_pct) || 30;
        return {
            ok: true, erros: [], valor, entradaValor, entradaPct, entradaMinPct: minPct, prazo, valorFinanciado: pv, taxaMensal: i,
            parcelaInicial: primeira, parcelaFinal: ultima, totalParcelas, totalJuros, totalSeguros, totalTarifas,
            totalPago: entradaValor + totalParcelas, cetAa: cetAa == null ? null : cetAa * 100, rendaMinima: primeira / (comprometimento / 100), comprometimento, tabela
        };
    }

    function montarSnapshot(res, cond, extra) {
        return {
            versao: 1, rotulo: (extra && extra.rotulo) || null, condicao_id: cond.id || null, condicao_nome: cond.nome, tipo: cond.tipo, banco: cond.banco || null,
            sistema: cond.sistema, taxa_aa: Number(cond.taxa_aa), tipo_taxa: cond.tipo_taxa, indexador: cond.indexador,
            valor_imovel: arred(res.valor), entrada_valor: arred(res.entradaValor), entrada_pct: arred(res.entradaPct), prazo_meses: res.prazo,
            valor_financiado: arred(res.valorFinanciado), parcela_inicial: arred(res.parcelaInicial), parcela_final: arred(res.parcelaFinal),
            total_parcelas: arred(res.totalParcelas), total_pago: arred(res.totalPago), total_juros: arred(res.totalJuros),
            total_seguros_tarifas: arred(res.totalSeguros + res.totalTarifas), cet_aa: res.cetAa == null ? null : arred(res.cetAa),
            renda_minima: arred(res.rendaMinima), fonte: cond.fonte || null, vigencia_ate: cond.vigencia_ate || null, calculado_em: new Date().toISOString()
        };
    }
    const IDX = { TR: "TR", IPCA: "IPCA", INCC: "INCC", IGPM: "IGP-M", nenhum: "" };
    function resumoTexto(s) {
        if (!s) return "";
        const taxa = s.taxa_aa > 0 ? ` · ${fmtNum(s.taxa_aa)}% a.a.${IDX[s.indexador] ? " + " + IDX[s.indexador] : ""}` : (IDX[s.indexador] ? ` · corrigido pelo ${IDX[s.indexador]}` : " · sem juros");
        const parc = s.sistema === "sac" && s.parcela_final < s.parcela_inicial - 0.005 ? `${s.prazo_meses}x de ${brl(s.parcela_inicial)} (decrescente)` : `${s.prazo_meses}x de ${brl(s.parcela_inicial)}`;
        return `${s.condicao_nome}${taxa} · Entrada ${brl(s.entrada_valor)} (${pctTxt(s.entrada_pct)}) · ${parc}`;
    }
    function resumoHtml(s) {
        if (!s) return "";
        garantirEstilo();
        const linhas = [
            ["Condição", `${esc(s.condicao_nome)}${s.banco ? ` <small>(${esc(s.banco)})</small>` : ""}`],
            ["Sistema / taxa", `${s.sistema === "sac" ? "SAC" : "Price"}${s.taxa_aa > 0 ? ` · ${fmtNum(s.taxa_aa)}% a.a.` : " · sem juros"}${IDX[s.indexador] ? ` · ${IDX[s.indexador]}` : ""}`],
            ["Valor do imóvel", brl(s.valor_imovel)],
            ["Entrada", `${brl(s.entrada_valor)} (${pctTxt(s.entrada_pct)})`],
            ["Financiado", brl(s.valor_financiado)],
            ["Prazo", `${s.prazo_meses} meses`],
            ["Parcela", s.sistema === "sac" && s.parcela_final < s.parcela_inicial - 0.005 ? `${brl(s.parcela_inicial)} → ${brl(s.parcela_final)}` : brl(s.parcela_inicial)],
            ["Total pago", brl(s.total_pago)]
        ];
        return `<dl class="skl-sim-dl">${linhas.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
    }
    function textoCompartilhar(s, rotulo) {
        const l = [];
        l.push(`Simulação de financiamento${rotulo ? " — " + rotulo : ""}`);
        l.push(`Valor do imóvel: ${brl(s.valor_imovel)}`);
        l.push(`Entrada: ${brl(s.entrada_valor)} (${pctTxt(s.entrada_pct)})`);
        l.push(`Valor financiado: ${brl(s.valor_financiado)}`);
        l.push(`Condição: ${s.condicao_nome}${s.banco ? " (" + s.banco + ")" : ""}`);
        l.push(`Sistema: ${s.sistema === "sac" ? "SAC (parcelas decrescentes)" : "Price (parcelas fixas)"}${s.taxa_aa > 0 ? " · " + fmtNum(s.taxa_aa) + "% a.a." : " · sem juros"}${IDX[s.indexador] ? " + " + IDX[s.indexador] : ""}`);
        l.push(`Prazo: ${s.prazo_meses} meses`);
        l.push(s.sistema === "sac" && s.parcela_final < s.parcela_inicial - 0.005 ? `Parcela: de ${brl(s.parcela_inicial)} até ${brl(s.parcela_final)}` : `Parcela: ${brl(s.parcela_inicial)}`);
        l.push(`Total pago (entrada + parcelas): ${brl(s.total_pago)}`);
        if (s.cet_aa != null && s.taxa_aa > 0) l.push(`CET aproximado: ${fmtNum(s.cet_aa)}% a.a.`);
        if (s.renda_minima) l.push(`Renda mínima sugerida: ${brl(s.renda_minima)}`);
        l.push("");
        l.push((st.config && st.config.aviso_texto) || "Simulação meramente ilustrativa, sem valor de proposta ou aprovação de crédito.");
        return l.join("\n");
    }

    // ------------------------------------------------------------------ dados
    async function carregar() {
        st.config = null; st.condicoes = []; st.ativo = false;
        if (!st.sb || !st.empId) return false;
        try {
            const [{ data: cfg }, { data: conds }] = await Promise.all([
                st.sb.from("simulador_config").select("*").eq("empreendimento_id", st.empId).maybeSingle(),
                st.sb.from("simulador_condicoes").select("*").eq("empreendimento_id", st.empId).eq("ativo", true).order("ordem", { ascending: true }).order("criado_em", { ascending: true })
            ]);
            st.config = cfg || null;
            const h = hoje();
            st.condicoes = (conds || []).filter((c) => !c.vigencia_ate || c.vigencia_ate >= h);
            st.ativo = !!(cfg && cfg.ativo);
        } catch (e) { st.ativo = false; }
        avisar();
        return st.ativo;
    }
    const ouvintes = [];
    function avisar() { ouvintes.slice().forEach((f) => { try { f(st.ativo); } catch (e) {} }); renderBloco(); }
    async function registrar(acao, alvo, snap) {
        try {
            await st.sb.rpc("simulador_registrar", { p_empreendimento_id: st.empId, p_lote_id: alvo && alvo.tipo === "lote" ? alvo.id || null : null, p_unidade_id: alvo && alvo.tipo === "unidade" ? alvo.id || null : null, p_acao: acao, p_simulacao: snap });
        } catch (e) { /* o registro é só estatística; não atrapalha o uso */ }
    }

    // ------------------------------------------------------------------ estilo + DOM
    const CSS = `
.skl-sim{border:0;padding:0;background:transparent;max-width:100vw;max-height:100vh;color:var(--ink,#19323a);font-family:inherit}
.skl-sim::backdrop{background:rgba(7,31,59,.66)}
.skl-sim-card{background:#fff;border-radius:18px;width:min(640px,calc(100vw - 20px));max-height:calc(100vh - 20px);overflow:auto;padding:20px 20px 22px;box-shadow:0 24px 60px rgba(0,0,0,.4);position:relative;-webkit-overflow-scrolling:touch}
.skl-sim-x{position:absolute;top:10px;right:12px;width:40px;height:40px;border:0;background:#eef2f4;border-radius:50%;font-size:22px;line-height:1;cursor:pointer;color:#45585e}
.skl-sim-eyebrow{display:block;font-size:11px;letter-spacing:.14em;font-weight:800;color:var(--sand,#c9962b);margin:0 44px 2px 0}
.skl-sim h2{margin:0 44px 12px 0;font-size:21px;color:var(--navy,#0B4F78);line-height:1.15}
.skl-sim h3{margin:16px 0 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#66777c)}
.skl-sim label.skl-l{display:block;font-size:12px;font-weight:700;color:var(--muted,#66777c);margin-bottom:4px}
.skl-sim input[type=text],.skl-sim input[type=number]{width:100%;padding:12px 12px;border:1px solid #cfd9dd;border-radius:10px;font-size:16px;background:#fff;color:inherit;box-sizing:border-box}
.skl-sim-valor input{font-size:20px;font-weight:800;color:var(--navy,#0B4F78)}
.skl-sim-conds{display:grid;gap:8px}
.skl-sim-cond{border:1.5px solid #d3dde1;border-radius:12px;padding:10px 12px;background:#fff;text-align:left;cursor:pointer;font:inherit;color:inherit;display:block;width:100%}
.skl-sim-cond b{display:block;font-size:14px;color:var(--navy,#0B4F78)}
.skl-sim-cond small{display:block;color:var(--muted,#66777c);font-size:12px;margin-top:2px}
.skl-sim-cond.on{border-color:var(--navy,#0B4F78);background:#eaf4fa;box-shadow:0 0 0 2px rgba(11,79,120,.15)}
.skl-sim-chips{display:flex;flex-wrap:wrap;gap:8px}
.skl-sim-chip{border:1.5px solid #cfd9dd;background:#fff;border-radius:999px;padding:9px 14px;min-height:42px;font-weight:700;font-size:14px;cursor:pointer;color:var(--navy,#0B4F78)}
.skl-sim-chip.on{background:var(--navy,#0B4F78);border-color:var(--navy,#0B4F78);color:#fff}
.skl-sim-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
.skl-sim input[type=range]{width:100%;margin:10px 0 0}
.skl-sim-hint{font-size:12px;color:var(--muted,#66777c);margin:6px 0 0}
.skl-sim-res{margin-top:16px;border-radius:14px;background:linear-gradient(160deg,#0B4F78,#071F3B);color:#fff;padding:16px}
.skl-sim-res .big{font-size:30px;font-weight:800;line-height:1.05}
.skl-sim-res .sub{font-size:13px;opacity:.85;margin-top:3px}
.skl-sim-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}
.skl-sim-grid div{background:rgba(255,255,255,.1);border-radius:10px;padding:8px 10px}
.skl-sim-grid span{display:block;font-size:11px;opacity:.8;letter-spacing:.03em}
.skl-sim-grid b{font-size:15px}
.skl-sim-err{margin-top:16px;border-radius:12px;background:#fbeceb;color:#8d3d35;padding:12px 14px;font-size:14px;font-weight:600}
.skl-sim details{margin-top:12px;border:1px solid #dbe4e8;border-radius:10px;padding:8px 10px}
.skl-sim summary{cursor:pointer;font-weight:700;font-size:13px;color:var(--navy,#0B4F78)}
.skl-sim table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
.skl-sim th,.skl-sim td{padding:5px 4px;border-bottom:1px solid #edf1f3;text-align:right;white-space:nowrap}
.skl-sim th:first-child,.skl-sim td:first-child{text-align:left}
.skl-sim-aviso{font-size:11.5px;color:var(--muted,#66777c);margin:12px 0 0;line-height:1.4}
.skl-sim-fonte{font-size:11.5px;color:var(--muted,#66777c);margin:4px 0 0}
.skl-sim-foot{position:sticky;bottom:-22px;background:#fff;margin:16px -20px -22px;padding:10px 20px 14px;border-top:1px solid #dfe8ec;box-shadow:0 -8px 16px rgba(7,31,59,.10);z-index:2}
.skl-sim-mini{font-size:14px;color:var(--muted,#66777c);margin-bottom:8px}.skl-sim-mini b{font-size:20px;color:var(--navy,#0B4F78)}
.skl-sim-acoes{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.skl-sim-btn{border:0;border-radius:12px;padding:14px 12px;font-weight:800;font-size:15px;cursor:pointer;min-height:48px}
.skl-sim-btn.sec{background:#e9f0f3;color:var(--navy,#0B4F78)}
.skl-sim-btn.pri{background:var(--sand,#E6B857);color:#3a2a00}
.skl-sim-btn[disabled]{opacity:.45;cursor:not-allowed}
.skl-sim-dl{margin:6px 0 0;display:grid;gap:4px}
.skl-sim-dl div{display:flex;justify-content:space-between;gap:10px;font-size:13px;border-bottom:1px dashed #dbe4e8;padding:3px 0}
.skl-sim-dl dt{color:var(--muted,#66777c)}.skl-sim-dl dd{margin:0;font-weight:700;text-align:right}
.skl-simbox{border:1.5px dashed #b9cbd3;border-radius:12px;padding:12px 14px;background:#f5f9fb;margin:6px 0 4px}
.skl-simbox.ok{border-style:solid;border-color:#9ed5b6;background:#f2fbf6}
.skl-simbox b{display:block;color:var(--navy,#0B4F78);font-size:14px}
.skl-simbox p{margin:3px 0 8px;font-size:12.5px;color:var(--muted,#66777c)}
.skl-simbox button{border:0;border-radius:10px;padding:10px 14px;font-weight:800;font-size:14px;cursor:pointer;background:var(--navy,#0B4F78);color:#fff;margin:0 8px 4px 0;min-height:42px}
.skl-simbox button.sec{background:#e3ecf0;color:var(--navy,#0B4F78)}
.skl-sim-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);background:#0d2a3a;color:#fff;padding:11px 16px;border-radius:12px;font-size:14px;opacity:0;pointer-events:none;transition:.25s;z-index:99999;max-width:90vw}
.skl-sim-toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:420px){.skl-sim-card{padding:16px 14px 18px}.skl-sim-foot{margin:16px -14px -18px;padding:10px 14px 14px;bottom:-18px}.skl-sim-res .big{font-size:26px}}`;

    function garantirEstilo() {
        if (!$q("#sklSimStyle")) { const s = document.createElement("style"); s.id = "sklSimStyle"; s.textContent = CSS; document.head.appendChild(s); }
    }
    function garantirDialogo() {
        if (st.dlg) return st.dlg;
        garantirEstilo();
        const d = document.createElement("dialog");
        d.className = "skl-sim"; d.id = "sklSimDialog";
        d.innerHTML = `<div class="skl-sim-card">
  <button class="skl-sim-x" type="button" aria-label="Fechar" data-a="fechar">×</button>
  <span class="skl-sim-eyebrow">SIMULAÇÃO DE FINANCIAMENTO</span>
  <h2 id="sklSimTitulo">Simulação</h2>
  <div class="skl-sim-valor"><label class="skl-l" for="sklSimValor">Valor do imóvel</label><input type="text" id="sklSimValor" inputmode="decimal" autocomplete="off" placeholder="R$ 0,00"></div>
  <h3>1 · Condição</h3><div class="skl-sim-conds" id="sklSimConds"></div>
  <h3>2 · Entrada</h3>
  <div class="skl-sim-chips" id="sklSimEntradaChips"></div>
  <input type="range" id="sklSimEntradaRange" min="10" max="90" step="1">
  <div class="skl-sim-row"><div><label class="skl-l" for="sklSimEntradaValor">Valor da entrada</label><input type="text" id="sklSimEntradaValor" inputmode="decimal" autocomplete="off"></div>
  <div><label class="skl-l" for="sklSimEntradaPct">Entrada (%)</label><input type="text" id="sklSimEntradaPct" inputmode="decimal" autocomplete="off"></div></div>
  <p class="skl-sim-hint" id="sklSimEntradaHint"></p>
  <h3>3 · Número de parcelas</h3>
  <div class="skl-sim-chips" id="sklSimPrazoChips"></div>
  <div class="skl-sim-row"><div><label class="skl-l" for="sklSimPrazo">Outro prazo (meses)</label><input type="number" id="sklSimPrazo" inputmode="numeric" min="1" max="600"></div><div></div></div>
  <div id="sklSimResultado"></div>
  <details id="sklSimTabelaBox" hidden><summary>Ver quadro de parcelas</summary><div id="sklSimTabela"></div></details>
  <p class="skl-sim-fonte" id="sklSimFonte"></p>
  <p class="skl-sim-aviso" id="sklSimAviso"></p>
  <div class="skl-sim-foot"><div class="skl-sim-mini" id="sklSimMini"></div>
  <div class="skl-sim-acoes"><button class="skl-sim-btn sec" type="button" data-a="compartilhar" id="sklSimCompartilhar">Compartilhar</button><button class="skl-sim-btn pri" type="button" data-a="usar" id="sklSimUsar">Usar na reserva</button></div></div>
</div>`;
        document.body.appendChild(d);
        d.addEventListener("click", (ev) => {
            const a = ev.target.closest && ev.target.closest("[data-a]");
            if (ev.target === d) return d.close();
            if (!a) return;
            const acao = a.dataset.a;
            if (acao === "fechar") d.close();
            else if (acao === "compartilhar") acaoCompartilhar();
            else if (acao === "usar") acaoUsar();
        });
        d.addEventListener("cancel", () => {});
        $q("#sklSimValor", d).addEventListener("input", () => { const c = st.ctx; if (!c) return; c.valor = parseValor($q("#sklSimValor", d).value); ajustarEntradaAoValor(); pintarEntrada(); pintar(); });
        $q("#sklSimValor", d).addEventListener("blur", (e) => { if (st.ctx && st.ctx.valor > 0) e.target.value = brl(st.ctx.valor); });
        $q("#sklSimEntradaRange", d).addEventListener("input", (e) => definirEntradaPct(Number(e.target.value)));
        $q("#sklSimEntradaValor", d).addEventListener("input", (e) => { const c = st.ctx; if (!c) return; c.entradaValor = parseValor(e.target.value); c.entradaPct = c.valor > 0 ? (c.entradaValor / c.valor) * 100 : 0; pintarEntrada(true); pintar(); });
        $q("#sklSimEntradaValor", d).addEventListener("blur", (e) => { if (st.ctx) e.target.value = fmtNum(st.ctx.entradaValor); });
        $q("#sklSimEntradaPct", d).addEventListener("input", (e) => { const v = parseValor(e.target.value); const c = st.ctx; if (!c) return; c.entradaPct = v; c.entradaValor = arred((c.valor * v) / 100); pintarEntrada(true, true); pintar(); });
        $q("#sklSimPrazo", d).addEventListener("input", (e) => { const c = st.ctx; if (!c) return; c.prazo = Math.round(Number(e.target.value) || 0); pintarPrazo(true); pintar(); });
        st.dlg = d;
        return d;
    }

    // ------------------------------------------------------------------ lógica do diálogo
    const condAtual = () => st.ctx && st.condicoes.find((c) => String(c.id) === String(st.ctx.condId));
    function opcoesPrazo(cond) {
        const base = Array.isArray(cond.opcoes_prazo) && cond.opcoes_prazo.length ? cond.opcoes_prazo : (st.config && st.config.parcelas_opcoes) || [60, 120, 180, 240, 300, 360, 420];
        return base.map(Number).filter((n) => n >= cond.prazo_min_meses && n <= cond.prazo_max_meses).sort((a, b) => a - b);
    }
    function escolherCondicao(id, manter) {
        const c = st.ctx, cond = st.condicoes.find((x) => String(x.id) === String(id));
        if (!cond) return;
        c.condId = cond.id;
        const minPct = entradaMinimaPct(cond);
        if (!manter) {
            const alvoPct = Math.max(Number(st.config && st.config.entrada_padrao_pct) || 20, minPct);
            c.entradaPct = alvoPct; c.entradaValor = arred((c.valor * alvoPct) / 100);
            const ops = opcoesPrazo(cond);
            c.prazo = ops.length ? ops.reduce((m, n) => (Math.abs(n - 240) < Math.abs(m - 240) ? n : m), ops[0]) : cond.prazo_max_meses;
        } else {
            if (c.entradaPct < minPct) { c.entradaPct = minPct; c.entradaValor = arred((c.valor * minPct) / 100); }
            if (c.prazo < cond.prazo_min_meses) c.prazo = cond.prazo_min_meses;
            if (c.prazo > cond.prazo_max_meses) c.prazo = cond.prazo_max_meses;
        }
        pintarConds(); pintarEntrada(); pintarPrazo(); pintar();
    }
    function ajustarEntradaAoValor() {
        const c = st.ctx, cond = condAtual();
        if (!c || !cond) return;
        c.entradaValor = arred((c.valor * (c.entradaPct || 0)) / 100);
    }
    function definirEntradaPct(pct) {
        const c = st.ctx; if (!c) return;
        c.entradaPct = pct; c.entradaValor = arred((c.valor * pct) / 100);
        pintarEntrada(); pintar();
    }
    function tipoTxt(cond) {
        const taxa = cond.taxa_aa > 0 ? `${fmtNum(cond.taxa_aa)}% a.a.${cond.tipo_taxa === "efetiva" ? " (efetiva)" : ""}${IDX[cond.indexador] ? " + " + IDX[cond.indexador] : ""}` : (IDX[cond.indexador] ? `sem juros · corrigido pelo ${IDX[cond.indexador]}` : "sem juros");
        return `${cond.banco ? cond.banco + " · " : ""}${cond.sistema === "sac" ? "SAC" : "Price"} · ${taxa}`;
    }
    function pintarConds() {
        const box = $q("#sklSimConds", st.dlg), c = st.ctx;
        box.innerHTML = st.condicoes.map((x) => `<button type="button" class="skl-sim-cond${String(x.id) === String(c.condId) ? " on" : ""}" data-cond="${esc(x.id)}"><b>${esc(x.nome)}</b><small>${esc(tipoTxt(x))}</small>${x.vigencia_ate ? `<small>Válida até ${esc(x.vigencia_ate.split("-").reverse().join("/"))}</small>` : ""}</button>`).join("");
        box.querySelectorAll("[data-cond]").forEach((b) => b.addEventListener("click", () => escolherCondicao(b.dataset.cond, true)));
    }
    function pintarEntrada(semCampoValor, semCampoPct) {
        const d = st.dlg, c = st.ctx, cond = condAtual();
        if (!cond) return;
        const minPct = entradaMinimaPct(cond);
        const pcts = [10, 20, 30, 40, 50].filter((p) => p >= Math.ceil(minPct));
        if (!pcts.includes(Math.ceil(minPct))) pcts.unshift(Math.ceil(minPct));
        const chips = $q("#sklSimEntradaChips", d);
        chips.innerHTML = [...new Set(pcts)].slice(0, 6).map((p) => `<button type="button" class="skl-sim-chip${Math.abs(c.entradaPct - p) < 0.05 ? " on" : ""}" data-pct="${p}">${p}%</button>`).join("");
        chips.querySelectorAll("[data-pct]").forEach((b) => b.addEventListener("click", () => definirEntradaPct(Number(b.dataset.pct))));
        const r = $q("#sklSimEntradaRange", d);
        r.min = String(Math.max(0, Math.ceil(minPct))); r.max = "90"; r.value = String(Math.min(90, Math.max(Number(r.min), Math.round(c.entradaPct))));
        if (!semCampoValor) $q("#sklSimEntradaValor", d).value = c.valor > 0 ? fmtNum(c.entradaValor) : "";
        if (!semCampoPct) $q("#sklSimEntradaPct", d).value = c.valor > 0 ? fmtNum(c.entradaPct, Number.isInteger(c.entradaPct) ? 0 : 2) : "";
        $q("#sklSimEntradaHint", d).textContent = `Entrada mínima desta condição: ${pctTxt(minPct)}${c.valor > 0 ? ` (${brl((c.valor * minPct) / 100)})` : ""} · financia até ${pctTxt(cond.financiavel_max_pct)} do imóvel.`;
    }
    function pintarPrazo(semCampo) {
        const d = st.dlg, c = st.ctx, cond = condAtual();
        if (!cond) return;
        const ops = opcoesPrazo(cond);
        const chips = $q("#sklSimPrazoChips", d);
        chips.innerHTML = ops.map((n) => `<button type="button" class="skl-sim-chip${c.prazo === n ? " on" : ""}" data-prazo="${n}">${n}x${n % 12 === 0 ? ` <small>(${n / 12} anos)</small>` : ""}</button>`).join("");
        chips.querySelectorAll("[data-prazo]").forEach((b) => b.addEventListener("click", () => { c.prazo = Number(b.dataset.prazo); pintarPrazo(); pintar(); }));
        if (!semCampo) $q("#sklSimPrazo", d).value = c.prazo || "";
        $q("#sklSimPrazo", d).min = String(cond.prazo_min_meses); $q("#sklSimPrazo", d).max = String(cond.prazo_max_meses);
    }
    function pintar() {
        const d = st.dlg, c = st.ctx, cond = condAtual();
        if (!cond) return;
        const res = calcular({ valor: c.valor, entradaValor: c.entradaValor, prazo: c.prazo }, cond, st.config);
        c.res = res;
        const box = $q("#sklSimResultado", d);
        const usar = $q("#sklSimUsar", d), comp = $q("#sklSimCompartilhar", d);
        if (!res.ok) {
            box.innerHTML = `<div class="skl-sim-err">${res.erros.map(esc).join("<br>")}</div>`;
            usar.disabled = true; comp.disabled = true;
            $q("#sklSimTabelaBox", d).hidden = true;
            $q("#sklSimMini", d).textContent = "Ajuste a entrada ou o prazo para ver a parcela.";
        } else {
            const decresc = cond.sistema === "sac" && res.parcelaFinal < res.parcelaInicial - 0.005;
            box.innerHTML = `<div class="skl-sim-res">
  <div class="sub">${decresc ? "Primeira parcela" : "Parcela mensal"}</div>
  <div class="big">${brl(res.parcelaInicial)}</div>
  <div class="sub">${decresc ? `decrescendo até ${brl(res.parcelaFinal)} · ${res.prazo} parcelas` : `${res.prazo} parcelas fixas`}</div>
  <div class="skl-sim-grid">
    <div><span>Valor financiado</span><b>${brl(res.valorFinanciado)}</b></div>
    <div><span>Entrada</span><b>${brl(res.entradaValor)} (${pctTxt(res.entradaPct)})</b></div>
    <div><span>Total pago (entrada + parcelas)</span><b>${brl(res.totalPago)}</b></div>
    <div><span>Total de juros</span><b>${brl(res.totalJuros)}</b></div>
    ${res.totalSeguros + res.totalTarifas > 0 ? `<div><span>Seguros e tarifas</span><b>${brl(res.totalSeguros + res.totalTarifas)}</b></div>` : ""}
    ${res.cetAa != null && cond.taxa_aa > 0 ? `<div><span>CET aproximado</span><b>${fmtNum(res.cetAa)}% a.a.</b></div>` : ""}
    <div><span>Renda mínima sugerida</span><b>${brl(res.rendaMinima)}</b></div>
  </div></div>`;
            usar.disabled = false; comp.disabled = false;
            $q("#sklSimMini", d).innerHTML = `<b>${brl(res.parcelaInicial)}</b> ${decresc ? "1ª parcela" : "por mês"} · ${res.prazo}x`;
            // quadro: 12 primeiras e a última
            const linhas = res.tabela.filter((r) => r.k <= 12 || r.k === res.prazo);
            $q("#sklSimTabela", d).innerHTML = `<table><thead><tr><th>Mês</th><th>Parcela</th><th>Juros</th><th>Amort.</th><th>Saldo</th></tr></thead><tbody>${linhas.map((r, i) => `${i > 0 && r.k === res.prazo && res.prazo > 13 ? `<tr><td colspan="5" style="text-align:center">…</td></tr>` : ""}<tr><td>${r.k}</td><td>${brl(r.parcela)}</td><td>${brl(r.juros)}</td><td>${brl(r.amort)}</td><td>${brl(r.saldo)}</td></tr>`).join("")}</tbody></table>`;
            $q("#sklSimTabelaBox", d).hidden = false;
        }
        $q("#sklSimFonte", d).textContent = cond.fonte ? `Fonte das condições: ${cond.fonte}${cond.atualizado_em ? " · atualizado em " + new Date(cond.atualizado_em).toLocaleDateString("pt-BR") : ""}` : "";
        $q("#sklSimAviso", d).textContent = (st.config && st.config.aviso_texto) || "";
        $q("#sklSimUsar", d).hidden = !st.ctx.permiteUsar;
        $q("#sklSimCompartilhar", d).parentNode.style.gridTemplateColumns = st.ctx.permiteUsar ? "1fr 1fr" : "1fr";
    }

    // ------------------------------------------------------------------ ações
    function snapAtual() {
        const c = st.ctx, cond = condAtual();
        if (!c || !cond || !c.res || !c.res.ok) return null;
        return montarSnapshot(c.res, cond, { rotulo: c.rotulo });
    }
    async function copiar(texto) {
        try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(texto); return true; } } catch (e) {}
        try { const ta = document.createElement("textarea"); ta.value = texto; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok; } catch (e) { return false; }
    }
    async function acaoCompartilhar() {
        const snap = snapAtual(); if (!snap) return;
        const texto = textoCompartilhar(snap, st.ctx.rotulo);
        registrar("compartilhou", st.ctx.alvo, snap);
        try {
            if (navigator.share) { await navigator.share({ title: "Simulação de financiamento", text: texto }); return; }
        } catch (e) { if (e && e.name === "AbortError") return; }
        toast((await copiar(texto)) ? "Simulação copiada — é só colar na conversa." : "Não foi possível compartilhar neste aparelho.");
    }
    function acaoUsar() {
        const snap = snapAtual(); if (!snap) return;
        const c = st.ctx;
        st.escolhidas[chaveAlvo(c.alvo)] = snap;
        registrar("usou_na_reserva", c.alvo, snap);
        const cb = c.aoUsar;
        st.dlg.close();
        toast("Simulação anexada ao pedido de reserva.");
        renderBloco();
        if (typeof cb === "function") { try { cb(snap); } catch (e) {} }
    }

    // opts: { valor, rotulo, alvo:{tipo:'lote'|'unidade', id, chave}, permiteUsar, aoUsar, editar }
    async function abrir(opts) {
        opts = opts || {};
        if (!st.sb || !st.empId) return toast("Entre em um empreendimento para simular.");
        await carregar();
        if (!st.ativo) return toast(st.papel === "central" ? "Ative o simulador em Configurações → Simulação de financiamento." : "O simulador de financiamento ainda não foi ativado pela Central.");
        if (!st.condicoes.length) return toast(st.papel === "central" ? "Cadastre pelo menos uma condição em Configurações → Simulação de financiamento." : "A Central ainda não cadastrou as condições de financiamento.");
        const d = garantirDialogo();
        const anterior = opts.editar ? st.escolhidas[chaveAlvo(opts.alvo)] : null;
        st.ctx = { valor: parseValor(opts.valor), rotulo: opts.rotulo || "Simulação livre", alvo: opts.alvo || null, permiteUsar: opts.permiteUsar !== false && st.papel !== "central", aoUsar: opts.aoUsar, condId: null, entradaPct: 20, entradaValor: 0, prazo: 240, res: null };
        $q("#sklSimTitulo", d).textContent = st.ctx.rotulo;
        $q("#sklSimValor", d).value = st.ctx.valor > 0 ? brl(st.ctx.valor) : "";
        const inicial = (anterior && st.condicoes.find((x) => String(x.id) === String(anterior.condicao_id))) || st.condicoes[0];
        escolherCondicao(inicial.id, false);
        if (anterior && String(inicial.id) === String(anterior.condicao_id)) {
            st.ctx.entradaPct = anterior.entrada_pct; st.ctx.entradaValor = anterior.entrada_valor; st.ctx.prazo = anterior.prazo_meses;
            pintarEntrada(); pintarPrazo(); pintar();
        }
        if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", "");
        d.querySelector(".skl-sim-card").scrollTop = 0;
    }

    // ------------------------------------------------------------------ bloco no formulário de reserva
    function renderBloco() {
        const b = st.bloco; if (!b || !b.container) return;
        const box = b.container;
        if (!st.ativo || !st.condicoes.length) { box.hidden = true; box.innerHTML = ""; return; }
        box.hidden = false;
        let alvo = null; try { alvo = b.getAlvo(); } catch (e) {}
        const snap = alvo ? st.escolhidas[chaveAlvo(alvo.alvo)] : null;
        if (snap) {
            box.innerHTML = `<div class="skl-simbox ok"><b>Simulação escolhida pelo cliente</b>${resumoHtml(snap)}<div style="margin-top:8px"><button type="button" class="sec" data-a="alterar">Alterar</button><button type="button" class="sec" data-a="remover">Remover</button></div></div>`;
        } else {
            box.innerHTML = `<div class="skl-simbox"><b>Simulação de financiamento</b><p>Quer levar a simulação escolhida pelo cliente junto com o pedido? Simule agora e anexe.</p><button type="button" data-a="simular">Simular financiamento</button></div>`;
        }
        box.querySelectorAll("[data-a]").forEach((btn) => btn.addEventListener("click", () => {
            const a = btn.dataset.a; let al = null; try { al = b.getAlvo(); } catch (e) {}
            if (!al) return;
            if (a === "remover") { delete st.escolhidas[chaveAlvo(al.alvo)]; renderBloco(); return; }
            abrir({ valor: al.valor, rotulo: al.rotulo, alvo: al.alvo, editar: a === "alterar", aoUsar: () => renderBloco() });
        }));
    }
    function montarBlocoReserva(container, getAlvo) { st.bloco = { container, getAlvo }; renderBloco(); }

    // ------------------------------------------------------------------ inicialização
    async function init(opts) {
        opts = opts || {};
        garantirEstilo();
        st.sb = opts.sb || st.sb; st.papel = opts.papel || st.papel; if (opts.toast) st.toast = opts.toast;
        const mudou = opts.empreendimentoId && opts.empreendimentoId !== st.empId;
        if (opts.empreendimentoId) st.empId = opts.empreendimentoId;
        if (mudou) st.escolhidas = {};
        return carregar();
    }
    window.SKLSimulador = {
        init, abrir, montarBlocoReserva, atualizarBloco: renderBloco, recarregar: carregar,
        ativo: () => st.ativo, condicoes: () => st.condicoes.slice(), config: () => st.config,
        onEstado: (f) => { if (typeof f === "function") ouvintes.push(f); },
        escolhida: (alvo) => st.escolhidas[chaveAlvo(alvo)] || null,
        limparEscolhida: (alvo) => { delete st.escolhidas[chaveAlvo(alvo)]; renderBloco(); },
        calcular, resumoHtml, resumoTexto, brl, parseValor, taxaMensal, entradaMinimaPct
    };
})();
