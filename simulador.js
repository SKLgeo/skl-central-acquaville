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
    // condições com faixas_prazo (ex.: até 12x sem juros, 13 a 60x só IPCA, 61 a 192x Price 0,8% a.m. + IPCA) usam
    // a primeira faixa cujo prazo_max_meses cobre o prazo escolhido; sem faixas, usa taxa_aa normal.
    // Cada faixa pode trazer indexador, cet_aa e rotulo próprios (configurados pela empresa no painel).
    function faixasOrdenadas(cond) {
        return Array.isArray(cond && cond.faixas_prazo) && cond.faixas_prazo.length ? cond.faixas_prazo.slice().sort((a, b) => a.prazo_max_meses - b.prazo_max_meses) : null;
    }
    function faixaDoPrazo(cond, prazo) {
        const ord = faixasOrdenadas(cond);
        return ord ? ord.find((f) => prazo <= f.prazo_max_meses) || ord[ord.length - 1] : null;
    }
    function taxaMensalPorPrazo(cond, prazo) {
        const faixa = faixaDoPrazo(cond, prazo);
        return faixa ? (Number(faixa.taxa_mensal_pct) || 0) / 100 : taxaMensal(cond);
    }
    // CET informado: o da faixa (se a faixa define cet_aa); senão o da condição, mas nunca numa faixa sem juros
    function cetInformado(cond, prazo) {
        const faixa = faixaDoPrazo(cond, prazo);
        const v = faixa && Object.prototype.hasOwnProperty.call(faixa, "cet_aa") ? faixa.cet_aa : (faixa && !(Number(faixa.taxa_mensal_pct) > 0) ? null : cond.cet_fixo_aa);
        return v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
    }
    function entradaMinimaPct(cond) {
        return Math.max(Number(cond.entrada_min_pct) || 0, 100 - (Number(cond.financiavel_max_pct) || 100));
    }
    // baloes: [{mes, valor}] — parcelas extras que abatem o valor a financiar antes da Price/SAC
    // (o corretor escolhe quantidade e intervalo; cada balão cai no mês = intervalo * k).
    function somaBaloes(baloes) { return (Array.isArray(baloes) ? baloes : []).reduce((s, b) => s + (Number(b.valor) || 0), 0); }
    function maiorMesBalao(baloes) { return (Array.isArray(baloes) ? baloes : []).reduce((m, b) => Math.max(m, Number(b.mes) || 0), 0); }
    // p = { valor, entradaValor, prazo, baloes }; cond = linha de simulador_condicoes; cfg = simulador_config
    function calcular(p, cond, cfg) {
        const valor = Number(p.valor) || 0;
        const entradaValor = Math.max(0, Number(p.entradaValor) || 0);
        const prazo = Math.round(Number(p.prazo) || 0);
        const baloes = cond.permite_balao ? (Array.isArray(p.baloes) ? p.baloes : []) : [];
        const totalBaloes = somaBaloes(baloes);
        const pv = valor - entradaValor - totalBaloes;
        const entradaPct = valor > 0 ? (entradaValor / valor) * 100 : 0;
        const minPct = entradaMinimaPct(cond);
        const erros = [];
        if (valor <= 0) erros.push("Informe o valor do imóvel.");
        else if (entradaPct + 1e-9 < minPct) erros.push(`Entrada mínima desta condição: ${pctTxt(minPct)} (${brl((valor * minPct) / 100)}).`);
        if (valor > 0 && pv <= 0) erros.push(totalBaloes > 0 ? "A entrada mais os balões não pode ultrapassar o valor do imóvel." : "A entrada precisa ser menor que o valor do imóvel.");
        if (prazo < cond.prazo_min_meses || prazo > cond.prazo_max_meses) erros.push(`Prazo desta condição: de ${cond.prazo_min_meses} a ${cond.prazo_max_meses} meses.`);
        if (baloes.length) {
            const maiorMes = maiorMesBalao(baloes);
            if (maiorMes > cond.balao_max_meses) erros.push(`Os balões desta condição podem ir até ${cond.balao_max_meses} meses.`);
            else if (maiorMes > prazo) erros.push(`Os balões vão até o mês ${maiorMes}, mas o prazo escolhido é de ${prazo} meses — aumente o prazo ou reduza os balões.`);
        }
        if (erros.length) return { ok: false, erros, entradaPct, entradaMinPct: minPct, valorFinanciado: Math.max(pv, 0), baloes, totalBaloes };

        const i = taxaMensalPorPrazo(cond, prazo);
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
        // CET informado pela empresa (na faixa ou na condição) tem prioridade sobre o calculado.
        const cetFixo = cetInformado(cond, prazo);
        const faixa = faixaDoPrazo(cond, prazo);
        // entrada dividida em até N vezes sem juros: só divide o pagamento da entrada, não muda o financiado.
        const entradaParcelas = Math.min(entradaParcelasMax(cond), Math.max(1, Math.round(Number(p.entradaParcelas) || 1)));
        return {
            ok: true, erros: [], valor, entradaValor, entradaPct, entradaMinPct: minPct, prazo, valorFinanciado: pv, taxaMensal: i,
            parcelaInicial: primeira, parcelaFinal: ultima, totalParcelas, totalJuros, totalSeguros, totalTarifas, baloes, totalBaloes,
            totalPago: entradaValor + totalBaloes + totalParcelas, cetAa: cetFixo != null ? cetFixo : (cetAa == null ? null : cetAa * 100), cetFixo: cetFixo != null,
            indexador: indexadorAplicavel(cond, prazo), faixaRotulo: (faixa && faixa.rotulo) || null, entradaParcelas, entradaParcelaValor: entradaValor / entradaParcelas,
            rendaMinima: primeira / (comprometimento / 100), comprometimento, tabela
        };
    }
    function entradaParcelasMax(cond) { return Math.max(1, Math.min(12, Math.round(Number(cond && cond.entrada_parcelas_max) || 1))); }
    // indexador: o da faixa do prazo, se a faixa define; senão o da condição, que só vale a partir de
    // indexador_desde_parcela quando a condição define isso
    function indexadorAplicavel(cond, prazo) {
        const faixa = faixaDoPrazo(cond, prazo);
        if (faixa && faixa.indexador) return faixa.indexador;
        if (!cond || !cond.indexador || cond.indexador === "nenhum") return "nenhum";
        const desde = Math.round(Number(cond.indexador_desde_parcela) || 0);
        return desde > 0 && prazo < desde ? "nenhum" : cond.indexador;
    }
    // simulador_config.exibir_totais = false → sem total pago, total de juros e renda mínima
    const mostraTotais = () => !(st.config && st.config.exibir_totais === false);

    function montarSnapshot(res, cond, extra) {
        // com faixas_prazo, a taxa realmente aplicada depende do prazo escolhido (ex.: 0% até 60x,
        // 0,8% a.m. de 61 a 192x) — mostra a taxa EFETIVA usada no cálculo, não a taxa "base" da condição.
        const temFaixas = Array.isArray(cond.faixas_prazo) && cond.faixas_prazo.length;
        const taxaAaExibida = temFaixas ? arred((Number(res.taxaMensal) || 0) * 12 * 100) : Number(cond.taxa_aa);
        const tipoTaxaExibida = temFaixas ? "nominal" : cond.tipo_taxa;
        return {
            versao: 1, rotulo: (extra && extra.rotulo) || null, condicao_id: cond.id || null, condicao_nome: cond.nome, tipo: cond.tipo, banco: cond.banco || null,
            sistema: cond.sistema, taxa_aa: taxaAaExibida, tipo_taxa: tipoTaxaExibida, indexador: res.indexador || cond.indexador, cet_fixo: !!res.cetFixo, faixa_rotulo: res.faixaRotulo || null,
            valor_imovel: arred(res.valor), entrada_valor: arred(res.entradaValor), entrada_pct: arred(res.entradaPct), prazo_meses: res.prazo,
            entrada_parcelas: res.entradaParcelas || 1, entrada_parcela_valor: arred(res.entradaParcelaValor || res.entradaValor),
            baloes: (res.baloes || []).map((b) => ({ mes: b.mes, valor: arred(b.valor) })), balao_total: arred(res.totalBaloes || 0),
            valor_financiado: arred(res.valorFinanciado), parcela_inicial: arred(res.parcelaInicial), parcela_final: arred(res.parcelaFinal),
            total_parcelas: arred(res.totalParcelas), total_pago: arred(res.totalPago), total_juros: arred(res.totalJuros),
            total_seguros_tarifas: arred(res.totalSeguros + res.totalTarifas), cet_aa: res.cetAa == null ? null : arred(res.cetAa),
            renda_minima: arred(res.rendaMinima), fonte: cond.fonte || null, vigencia_ate: cond.vigencia_ate || null, calculado_em: new Date().toISOString()
        };
    }
    const IDX = { TR: "TR", IPCA: "IPCA", INCC: "INCC", IGPM: "IGP-M", nenhum: "" };
    function balaoTexto(s) {
        if (!s || !Array.isArray(s.baloes) || !s.baloes.length) return "";
        const intervalo = s.baloes.length > 1 ? s.baloes[1].mes - s.baloes[0].mes : s.baloes[0].mes;
        return ` · Balão ${s.baloes.length}x de ${brl(s.baloes[0].valor)} a cada ${intervalo} meses (total ${brl(s.balao_total)})`;
    }
    // "R$ 10.000,00 (10%)" ou "R$ 10.000,00 (10%) em 5x de R$ 2.000,00 sem juros"
    function entradaTxt(s) {
        const n = Math.max(1, Number(s.entrada_parcelas) || 1);
        return `${brl(s.entrada_valor)} (${pctTxt(s.entrada_pct)})${n > 1 ? ` em ${n}x de ${brl(s.entrada_parcela_valor || s.entrada_valor / n)} sem juros` : ""}`;
    }
    // "Sem juros" / "Só IPCA" / "Price + IPCA · 9,6% a.a." — usa o texto da faixa quando a empresa definiu
    function jurosTxt(s) {
        const idx = IDX[s.indexador];
        if (Number(s.taxa_aa) > 0) {
            const taxa = `${fmtNum(s.taxa_aa)}% a.a.`;
            return s.faixa_rotulo ? `${s.faixa_rotulo} · ${taxa}` : `${s.sistema === "sac" ? "SAC" : "Price"} · ${taxa}${idx ? " + " + idx : ""}`;
        }
        return s.faixa_rotulo || (idx ? `sem juros · corrigido pelo ${idx}` : "sem juros");
    }
    const temCet = (s) => s && s.cet_aa != null && (s.taxa_aa > 0 || s.cet_fixo);
    const cetTxt = (s) => `${fmtNum(s.cet_aa)}% a.a.${IDX[s.indexador] ? " + " + IDX[s.indexador] : ""}`;
    function resumoTexto(s) {
        if (!s) return "";
        const taxa = ` · ${jurosTxt(s)}`;
        const parc = s.sistema === "sac" && s.parcela_final < s.parcela_inicial - 0.005 ? `${s.prazo_meses}x de ${brl(s.parcela_inicial)} (decrescente)` : `${s.prazo_meses}x de ${brl(s.parcela_inicial)}`;
        return `${s.condicao_nome}${taxa} · Entrada ${entradaTxt(s)}${balaoTexto(s)} · ${parc}`;
    }
    function resumoHtml(s) {
        if (!s) return "";
        garantirEstilo();
        const linhas = [
            ["Condição", `${esc(s.condicao_nome)}${s.banco ? ` <small>(${esc(s.banco)})</small>` : ""}`],
            ["Juros / correção", esc(jurosTxt(s))],
            ["Valor do imóvel", brl(s.valor_imovel)],
            ["Entrada", entradaTxt(s)]
        ];
        if (Array.isArray(s.baloes) && s.baloes.length) {
            const intervalo = s.baloes.length > 1 ? s.baloes[1].mes - s.baloes[0].mes : s.baloes[0].mes;
            linhas.push(["Balão", `${s.baloes.length}x de ${brl(s.baloes[0].valor)} a cada ${intervalo} meses (total ${brl(s.balao_total)})`]);
        }
        linhas.push(
            ["Financiado", brl(s.valor_financiado)],
            ["Prazo", `${s.prazo_meses} meses`],
            ["Parcela", s.sistema === "sac" && s.parcela_final < s.parcela_inicial - 0.005 ? `${brl(s.parcela_inicial)} → ${brl(s.parcela_final)}` : brl(s.parcela_inicial)]
        );
        if (temCet(s)) linhas.push(["CET", cetTxt(s)]);
        if (mostraTotais()) linhas.push(["Total pago", brl(s.total_pago)]);
        return `<dl class="skl-sim-dl">${linhas.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
    }
    function textoCompartilhar(s, rotulo) {
        const l = [];
        l.push(`Simulação de financiamento${rotulo ? " — " + rotulo : ""}`);
        l.push(`Valor do imóvel: ${brl(s.valor_imovel)}`);
        l.push(`Entrada: ${entradaTxt(s)}`);
        if (Array.isArray(s.baloes) && s.baloes.length) {
            const intervalo = s.baloes.length > 1 ? s.baloes[1].mes - s.baloes[0].mes : s.baloes[0].mes;
            l.push(`Balão: ${s.baloes.length}x de ${brl(s.baloes[0].valor)} a cada ${intervalo} meses (total ${brl(s.balao_total)})`);
        }
        l.push(`Valor financiado: ${brl(s.valor_financiado)}`);
        l.push(`Condição: ${s.condicao_nome}${s.banco ? " (" + s.banco + ")" : ""}`);
        l.push(`Juros / correção: ${jurosTxt(s)}`);
        l.push(`Prazo: ${s.prazo_meses} meses`);
        l.push(s.sistema === "sac" && s.parcela_final < s.parcela_inicial - 0.005 ? `Parcela: de ${brl(s.parcela_inicial)} até ${brl(s.parcela_final)}` : `Parcela: ${brl(s.parcela_inicial)}`);
        if (mostraTotais()) l.push(`Total pago (entrada + parcelas): ${brl(s.total_pago)}`);
        if (temCet(s)) l.push(`${s.cet_fixo ? "CET" : "CET aproximado"}: ${cetTxt(s)}`);
        if (s.renda_minima && mostraTotais()) l.push(`Renda mínima sugerida: ${brl(s.renda_minima)}`);
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
.skl-sim details{margin-top:12px;border:1px solid #dbe4e8;border-radius:10px;padding:8px 10px;max-width:100%;box-sizing:border-box}
.skl-sim summary{cursor:pointer;font-weight:700;font-size:13px;color:var(--navy,#0B4F78)}
#sklSimTabela{overflow:auto;-webkit-overflow-scrolling:touch;max-width:100%;max-height:340px}
.skl-sim table{width:100%;min-width:440px;border-collapse:collapse;font-size:12px;margin-top:8px}
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
#sklSimBalaoSec{border:1.5px solid #d3dde1;border-radius:12px;padding:12px 14px;margin-top:14px;background:#f8fafb}
#sklSimBalaoSec h3{margin-top:0}
#sklSimBalaoCampos{margin-top:10px}
#sklSimBalaoIntervaloChips{margin-top:8px}
.skl-simbox{border:1.5px dashed #b9cbd3;border-radius:12px;padding:12px 14px;background:#f5f9fb;margin:6px 0 4px}
.skl-simbox.ok{border-style:solid;border-color:#9ed5b6;background:#f2fbf6}
.skl-simbox b{display:block;color:var(--navy,#0B4F78);font-size:14px}
.skl-simbox p{margin:3px 0 8px;font-size:12.5px;color:var(--muted,#66777c)}
.skl-simbox button{border:0;border-radius:10px;padding:10px 14px;font-weight:800;font-size:14px;cursor:pointer;background:var(--navy,#0B4F78);color:#fff;margin:0 8px 4px 0;min-height:42px}
.skl-simbox button.sec{background:#e3ecf0;color:var(--navy,#0B4F78)}
.skl-sim-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);background:#0d2a3a;color:#fff;padding:11px 16px;border-radius:12px;font-size:14px;opacity:0;pointer-events:none;transition:.25s;z-index:99999;max-width:90vw}
.skl-sim-toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:420px){.skl-sim-card{padding:16px 14px 18px}.skl-sim-foot{margin:16px -14px -18px;padding:10px 14px 14px;bottom:-18px}.skl-sim-res .big{font-size:26px}.skl-sim table{min-width:0;font-size:11px}.skl-sim th,.skl-sim td{padding:4px 3px}}`;

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
  <div class="skl-sim-row" id="sklSimEntradaEditRow"><div><label class="skl-l" for="sklSimEntradaValor">Valor da entrada</label><input type="text" id="sklSimEntradaValor" inputmode="decimal" autocomplete="off"></div>
  <div><label class="skl-l" for="sklSimEntradaPct">Entrada (%)</label><input type="text" id="sklSimEntradaPct" inputmode="decimal" autocomplete="off"></div></div>
  <p class="skl-sim-hint" id="sklSimEntradaFixaTxt" hidden></p>
  <p class="skl-sim-hint" id="sklSimEntradaHint"></p>
  <div id="sklSimEntradaParcSec" hidden>
    <label class="skl-l" style="margin-top:12px">Pagamento da entrada (sem juros)</label>
    <div class="skl-sim-chips" id="sklSimEntradaParcChips"></div>
    <p class="skl-sim-hint" id="sklSimEntradaParcHint"></p>
  </div>
  <div id="sklSimBalaoSec" hidden>
    <h3>Balão (opcional)</h3>
    <label style="display:flex;gap:8px;align-items:center;font-size:13px;font-weight:700;color:var(--muted,#66777c);cursor:pointer"><input type="checkbox" id="sklSimBalaoToggle" style="width:auto"> Incluir balão</label>
    <div id="sklSimBalaoCampos" hidden>
      <div class="skl-sim-row">
        <div><label class="skl-l" for="sklSimBalaoQtd">Quantas parcelas de balão</label><input type="number" id="sklSimBalaoQtd" inputmode="numeric" min="1" max="12" value="1"></div>
        <div><label class="skl-l" for="sklSimBalaoIntervalo">Intervalo entre balões (meses)</label><input type="number" id="sklSimBalaoIntervalo" inputmode="numeric" min="1" max="48" value="12"></div>
      </div>
      <div class="skl-sim-chips" id="sklSimBalaoIntervaloChips">
        <button type="button" class="skl-sim-chip" data-intervalo="4">A cada 4 meses</button>
        <button type="button" class="skl-sim-chip" data-intervalo="6">Semestral</button>
        <button type="button" class="skl-sim-chip on" data-intervalo="12">Anual</button>
      </div>
      <div class="skl-sim-row">
        <div><label class="skl-l" for="sklSimBalaoValor">Valor de cada balão</label><input type="text" id="sklSimBalaoValor" inputmode="decimal" autocomplete="off" placeholder="R$ 0,00"></div>
        <div><label class="skl-l">Total dos balões</label><input type="text" id="sklSimBalaoTotal" disabled></div>
      </div>
      <p class="skl-sim-hint" id="sklSimBalaoHint"></p>
    </div>
  </div>
  <h3>3 · Número de parcelas</h3>
  <div class="skl-sim-chips" id="sklSimPrazoChips"></div>
  <div class="skl-sim-row"><div><label class="skl-l" for="sklSimPrazo">Outro prazo (meses)</label><input type="number" id="sklSimPrazo" inputmode="numeric" min="1" max="600"></div><div></div></div>
  <div id="sklSimResultado"></div>
  <details id="sklSimTabelaBox" hidden><summary>Ver quadro de parcelas</summary><div id="sklSimTabela"></div></details>
  <p class="skl-sim-fonte" id="sklSimFonte"></p>
  <p class="skl-sim-aviso" id="sklSimAviso"></p>
  <div class="skl-sim-foot"><div class="skl-sim-mini" id="sklSimMini"></div>
  <div class="skl-sim-acoes"><button class="skl-sim-btn sec" type="button" data-a="compartilhar" id="sklSimCompartilhar">Compartilhar</button><button class="skl-sim-btn sec" type="button" data-a="imprimir" id="sklSimImprimir" hidden>Imprimir proposta</button><button class="skl-sim-btn pri" type="button" data-a="usar" id="sklSimUsar">Usar na reserva</button></div></div>
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
            else if (acao === "imprimir") { const snap = snapAtual(); if (snap) imprimirProposta(snap, st.ctx.infoProposta || { rotulo: st.ctx.rotulo }); }
        });
        d.addEventListener("cancel", () => {});
        $q("#sklSimValor", d).addEventListener("input", () => { const c = st.ctx; if (!c) return; c.valor = parseValor($q("#sklSimValor", d).value); ajustarEntradaAoValor(); pintarEntrada(); pintar(); });
        $q("#sklSimValor", d).addEventListener("blur", (e) => { if (st.ctx && st.ctx.valor > 0) e.target.value = brl(st.ctx.valor); });
        $q("#sklSimEntradaRange", d).addEventListener("input", (e) => definirEntradaPct(Number(e.target.value)));
        $q("#sklSimEntradaValor", d).addEventListener("input", (e) => { const c = st.ctx; if (!c) return; c.entradaValor = parseValor(e.target.value); c.entradaPct = c.valor > 0 ? (c.entradaValor / c.valor) * 100 : 0; pintarEntrada(true); pintar(); });
        $q("#sklSimEntradaValor", d).addEventListener("blur", (e) => { if (st.ctx) e.target.value = fmtNum(st.ctx.entradaValor); });
        $q("#sklSimEntradaPct", d).addEventListener("input", (e) => { const v = parseValor(e.target.value); const c = st.ctx; if (!c) return; c.entradaPct = v; c.entradaValor = arred((c.valor * v) / 100); pintarEntrada(true, true); pintar(); });
        $q("#sklSimPrazo", d).addEventListener("input", (e) => { const c = st.ctx; if (!c) return; c.prazo = Math.round(Number(e.target.value) || 0); pintarPrazo(true); pintar(); });
        $q("#sklSimBalaoToggle", d).addEventListener("change", (e) => { $q("#sklSimBalaoCampos", d).hidden = !e.target.checked; atualizarBalaoTotal(); pintar(); });
        $q("#sklSimBalaoQtd", d).addEventListener("input", () => { atualizarBalaoTotal(); pintar(); });
        $q("#sklSimBalaoIntervalo", d).addEventListener("input", () => { marcarChipIntervalo(); atualizarBalaoTotal(); pintar(); });
        $q("#sklSimBalaoIntervaloChips", d).querySelectorAll("[data-intervalo]").forEach((b) => b.addEventListener("click", () => { $q("#sklSimBalaoIntervalo", d).value = b.dataset.intervalo; marcarChipIntervalo(); atualizarBalaoTotal(); pintar(); }));
        $q("#sklSimBalaoValor", d).addEventListener("input", (e) => { atualizarBalaoTotal(); pintar(); });
        $q("#sklSimBalaoValor", d).addEventListener("blur", (e) => { const v = parseValor(e.target.value); e.target.value = v > 0 ? fmtNum(v) : ""; });
        st.dlg = d;
        return d;
    }
    function marcarChipIntervalo() {
        const d = st.dlg, v = String(Math.round(Number($q("#sklSimBalaoIntervalo", d).value) || 0));
        $q("#sklSimBalaoIntervaloChips", d).querySelectorAll("[data-intervalo]").forEach((b) => b.classList.toggle("on", b.dataset.intervalo === v));
    }
    function balaoParams() {
        const d = st.dlg, cond = condAtual();
        if (!cond || !cond.permite_balao) return [];
        const toggle = $q("#sklSimBalaoToggle", d);
        if (!toggle || !toggle.checked) return [];
        const qtd = Math.max(1, Math.round(Number($q("#sklSimBalaoQtd", d).value) || 0));
        const intervalo = Math.max(1, Math.round(Number($q("#sklSimBalaoIntervalo", d).value) || 0));
        const valor = parseValor($q("#sklSimBalaoValor", d).value);
        const lista = [];
        for (let k = 1; k <= qtd; k++) lista.push({ mes: intervalo * k, valor });
        return lista;
    }
    function atualizarBalaoTotal() {
        const d = st.dlg, cond = condAtual();
        if (!cond || !cond.permite_balao) return;
        const lista = balaoParams();
        const total = lista.reduce((s, b) => s + b.valor, 0);
        $q("#sklSimBalaoTotal", d).value = lista.length ? brl(total) : "";
        const maiorMes = lista.length ? Math.max(...lista.map((b) => b.mes)) : 0;
        $q("#sklSimBalaoHint", d).textContent = lista.length ? `Balões até o mês ${maiorMes} de ${lista.length} parcela(s) (máximo desta condição: ${cond.balao_max_meses} meses).` : `Até ${cond.balao_max_meses} meses de balão nesta condição.`;
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
        if (!manter) c.entradaParcelas = 1;
        c.entradaParcelas = Math.min(entradaParcelasMax(cond), Math.max(1, Number(c.entradaParcelas) || 1));
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
        pintarBalaoSecao(cond, manter);
        pintarConds(); pintarEntrada(); pintarPrazo(); pintar();
    }
    // mostra/esconde a seção de balão conforme a condição escolhida; ao trocar de condição
    // (manter=true vindo de um clique, não da abertura inicial) reseta o balão, já que o
    // limite de meses pode ser diferente entre condições.
    function pintarBalaoSecao(cond, manter) {
        const d = st.dlg;
        const sec = $q("#sklSimBalaoSec", d);
        sec.hidden = !cond.permite_balao;
        if (!cond.permite_balao) { $q("#sklSimBalaoToggle", d).checked = false; $q("#sklSimBalaoCampos", d).hidden = true; return; }
        if (manter) return;
        const pre = st.ctx && st.ctx._balaoPreenchido;
        if (pre && pre.length) {
            $q("#sklSimBalaoToggle", d).checked = true; $q("#sklSimBalaoCampos", d).hidden = false;
            const intervalo = pre.length > 1 ? pre[1].mes - pre[0].mes : pre[0].mes;
            $q("#sklSimBalaoQtd", d).value = pre.length; $q("#sklSimBalaoIntervalo", d).value = intervalo;
            $q("#sklSimBalaoValor", d).value = pre[0].valor > 0 ? fmtNum(pre[0].valor) : "";
            marcarChipIntervalo();
        } else {
            $q("#sklSimBalaoToggle", d).checked = false; $q("#sklSimBalaoCampos", d).hidden = true;
            $q("#sklSimBalaoQtd", d).value = "1"; $q("#sklSimBalaoIntervalo", d).value = "12"; $q("#sklSimBalaoValor", d).value = "";
            marcarChipIntervalo();
        }
        atualizarBalaoTotal();
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
        const ord = faixasOrdenadas(cond);
        if (ord) {
            let de = 1;
            const partes = ord.map((f) => {
                const faixa = de > 1 ? `${de} a ${f.prazo_max_meses}x` : `até ${f.prazo_max_meses}x`;
                const idx = IDX[indexadorAplicavel(cond, f.prazo_max_meses)];
                const taxa = Number(f.taxa_mensal_pct) || 0;
                const desc = f.rotulo ? `${f.rotulo}${taxa > 0 ? ` (${fmtNum(taxa)}% a.m.)` : ""}` : (taxa > 0 ? `${cond.sistema === "sac" ? "SAC" : "Price"} ${fmtNum(taxa)}% a.m.${idx ? " + " + idx : ""}` : (idx ? `só ${idx}` : "sem juros"));
                de = f.prazo_max_meses + 1;
                return `${faixa} ${desc}`;
            });
            const entParc = entradaParcelasMax(cond) > 1 ? ` · entrada em até ${entradaParcelasMax(cond)}x` : "";
            return `${cond.banco ? cond.banco + " · " : ""}${partes.join(" · ")}${entParc}${cond.permite_balao ? " · balão opcional" : ""}`;
        }
        const taxa = cond.taxa_aa > 0 ? `${fmtNum(cond.taxa_aa)}% a.a.${cond.tipo_taxa === "efetiva" ? " (efetiva)" : ""}${IDX[cond.indexador] ? " + " + IDX[cond.indexador] : ""}` : (IDX[cond.indexador] ? `sem juros · corrigido pelo ${IDX[cond.indexador]}` : "sem juros");
        return `${cond.banco ? cond.banco + " · " : ""}${cond.sistema === "sac" ? "SAC" : "Price"} · ${taxa}${cond.permite_balao ? " · balão opcional" : ""}`;
    }
    function pintarConds() {
        const box = $q("#sklSimConds", st.dlg), c = st.ctx;
        box.innerHTML = st.condicoes.map((x) => `<button type="button" class="skl-sim-cond${String(x.id) === String(c.condId) ? " on" : ""}" data-cond="${esc(x.id)}"><b>${esc(x.nome)}</b><small>${esc(tipoTxt(x))}</small>${x.vigencia_ate ? `<small>Válida até ${esc(x.vigencia_ate.split("-").reverse().join("/"))}</small>` : ""}</button>`).join("");
        box.querySelectorAll("[data-cond]").forEach((b) => b.addEventListener("click", () => escolherCondicao(b.dataset.cond, true)));
    }
    // Chips "À vista / 2x / … / Nx" para dividir a entrada sem juros (condição com entrada_parcelas_max > 1).
    function pintarEntradaParcelas() {
        const d = st.dlg, c = st.ctx, cond = condAtual();
        const sec = $q("#sklSimEntradaParcSec", d);
        const max = cond ? entradaParcelasMax(cond) : 1;
        sec.hidden = max <= 1;
        if (max <= 1) { c.entradaParcelas = 1; return; }
        const n = Math.min(max, Math.max(1, Number(c.entradaParcelas) || 1));
        c.entradaParcelas = n;
        const chips = $q("#sklSimEntradaParcChips", d);
        chips.innerHTML = Array.from({ length: max }, (_, k) => k + 1).map((k) => `<button type="button" class="skl-sim-chip${k === n ? " on" : ""}" data-eparc="${k}">${k === 1 ? "À vista" : `${k}x`}</button>`).join("");
        chips.querySelectorAll("[data-eparc]").forEach((b) => b.addEventListener("click", () => { c.entradaParcelas = Number(b.dataset.eparc); pintarEntradaParcelas(); pintar(); }));
        $q("#sklSimEntradaParcHint", d).textContent = n > 1 && c.entradaValor > 0 ? `${n}x de ${brl(c.entradaValor / n)} sem juros (até ${max}x).` : `Pode ser dividida em até ${max}x sem juros.`;
    }
    function pintarEntrada(semCampoValor, semCampoPct) {
        const d = st.dlg, c = st.ctx, cond = condAtual();
        if (!cond) return;
        pintarEntradaParcelas();
        const minPct = entradaMinimaPct(cond);
        const fixa = !!cond.entrada_fixa;
        if (fixa) { c.entradaPct = minPct; c.entradaValor = arred((c.valor * minPct) / 100); }
        $q("#sklSimEntradaChips", d).hidden = fixa;
        $q("#sklSimEntradaRange", d).hidden = fixa;
        $q("#sklSimEntradaEditRow", d).hidden = fixa;
        $q("#sklSimEntradaFixaTxt", d).hidden = !fixa;
        if (fixa) {
            $q("#sklSimEntradaFixaTxt", d).textContent = `Entrada fixa desta condição: ${pctTxt(minPct)}${c.valor > 0 ? ` (${brl(c.entradaValor)})` : ""} — não é possível alterar.`;
            $q("#sklSimEntradaHint", d).textContent = `Financia até ${pctTxt(cond.financiavel_max_pct)} do imóvel.`;
            return;
        }
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
        const res = calcular({ valor: c.valor, entradaValor: c.entradaValor, prazo: c.prazo, baloes: balaoParams(), entradaParcelas: c.entradaParcelas }, cond, st.config);
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
  <div class="sub">${decresc ? `decrescendo até ${brl(res.parcelaFinal)} · ${res.prazo} parcelas` : `${res.prazo} parcelas fixas`} · ${esc(jurosTxt({ taxa_aa: arred(res.taxaMensal * 12 * 100), indexador: res.indexador, faixa_rotulo: res.faixaRotulo, sistema: cond.sistema }))}</div>
  <div class="skl-sim-grid">
    <div><span>Valor financiado</span><b>${brl(res.valorFinanciado)}</b></div>
    <div><span>Entrada${res.entradaParcelas > 1 ? ` (${res.entradaParcelas}x sem juros)` : ""}</span><b>${brl(res.entradaValor)} (${pctTxt(res.entradaPct)})${res.entradaParcelas > 1 ? `<br><small>${res.entradaParcelas}x de ${brl(res.entradaParcelaValor)}</small>` : ""}</b></div>
    ${res.baloes && res.baloes.length ? `<div><span>Balão (${res.baloes.length}x a cada ${res.baloes.length > 1 ? res.baloes[1].mes - res.baloes[0].mes : res.baloes[0].mes} meses)</span><b>${brl(res.totalBaloes)}</b></div>` : ""}
    ${mostraTotais() ? `<div><span>Total pago (entrada${res.baloes && res.baloes.length ? " + balão" : ""} + parcelas)</span><b>${brl(res.totalPago)}</b></div>
    <div><span>Total de juros</span><b>${brl(res.totalJuros)}</b></div>` : ""}
    ${res.totalSeguros + res.totalTarifas > 0 ? `<div><span>Seguros e tarifas</span><b>${brl(res.totalSeguros + res.totalTarifas)}</b></div>` : ""}
    ${res.cetAa != null && (res.taxaMensal > 0 || res.cetFixo) ? `<div><span>${res.cetFixo ? "CET" : "CET aproximado"}</span><b>${fmtNum(res.cetAa)}% a.a.${IDX[res.indexador] ? " + " + IDX[res.indexador] : ""}</b></div>` : ""}
    ${mostraTotais() ? `<div><span>Renda mínima sugerida</span><b>${brl(res.rendaMinima)}</b></div>` : ""}
  </div></div>`;
            usar.disabled = false; comp.disabled = false;
            $q("#sklSimMini", d).innerHTML = `<b>${brl(res.parcelaInicial)}</b> ${decresc ? "1ª parcela" : "por mês"} · ${res.prazo}x`;
            // quadro completo (é só da Central): todas as parcelas, com rolagem
            const linhas = res.tabela;
            $q("#sklSimTabela", d).innerHTML = `<table><thead><tr><th>Mês</th><th>Parcela</th><th>Juros</th><th>Amort.</th><th>Saldo</th></tr></thead><tbody>${linhas.map((r) => `<tr><td>${r.k}</td><td>${brl(r.parcela)}</td><td>${brl(r.juros)}</td><td>${brl(r.amort)}</td><td>${brl(r.saldo)}</td></tr>`).join("")}</tbody></table>`;
            // quadro de parcelas: só a Central vê (o corretor fica com a parcela e o resumo)
            $q("#sklSimTabelaBox", d).hidden = st.papel !== "central";
        }
        $q("#sklSimFonte", d).textContent = cond.fonte ? `Fonte das condições: ${cond.fonte}${cond.atualizado_em ? " · atualizado em " + new Date(cond.atualizado_em).toLocaleDateString("pt-BR") : ""}` : "";
        $q("#sklSimAviso", d).textContent = (st.config && st.config.aviso_texto) || "";
        const imp = $q("#sklSimImprimir", d);
        usar.hidden = !st.ctx.permiteUsar;
        usar.textContent = st.ctx.textoUsar || "Usar na reserva";
        imp.hidden = st.papel !== "central";
        imp.disabled = !res.ok;
        const visiveis = [ $q("#sklSimCompartilhar", d), imp, usar ].filter((b) => !b.hidden).length;
        usar.parentNode.style.gridTemplateColumns = `repeat(${visiveis}, 1fr)`;
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
        if (typeof c.aoSalvar === "function") {
            // Central: "Salvar na proposta" (fechamento da venda) — não mexe no bloco de reserva do corretor
            st.dlg.close();
            try { c.aoSalvar(snap); } catch (e) {}
            return;
        }
        st.escolhidas[chaveAlvo(c.alvo)] = snap;
        registrar("usou_na_reserva", c.alvo, snap);
        const cb = c.aoUsar;
        st.dlg.close();
        toast("Simulação anexada ao pedido de reserva.");
        renderBloco();
        if (typeof cb === "function") { try { cb(snap); } catch (e) {} }
    }

    // opts: { valor, rotulo, alvo:{tipo:'lote'|'unidade', id, chave}, permiteUsar, aoUsar, editar,
    //         snapshot (abre a partir de uma simulação salva), aoSalvar + textoUsar (Central: "Salvar na proposta"),
    //         infoProposta ({rotulo, cliente, corretor, empreendimento} para imprimir) }
    async function abrir(opts) {
        opts = opts || {};
        if (!st.sb || !st.empId) return toast("Entre em um empreendimento para simular.");
        await carregar();
        if (!st.ativo) return toast(st.papel === "central" ? "Ative o simulador em Configurações → Simulação de financiamento." : "O simulador de financiamento ainda não foi ativado pela Central.");
        if (!st.condicoes.length) return toast(st.papel === "central" ? "Cadastre pelo menos uma condição em Configurações → Simulação de financiamento." : "A Central ainda não cadastrou as condições de financiamento.");
        const d = garantirDialogo();
        const anterior = opts.snapshot || (opts.editar ? st.escolhidas[chaveAlvo(opts.alvo)] : null);
        const podeSalvar = typeof opts.aoSalvar === "function";
        st.ctx = { valor: parseValor(opts.valor), rotulo: opts.rotulo || "Simulação livre", alvo: opts.alvo || null, permiteUsar: podeSalvar || (opts.permiteUsar !== false && st.papel !== "central"), aoUsar: opts.aoUsar, aoSalvar: podeSalvar ? opts.aoSalvar : null, textoUsar: opts.textoUsar || (podeSalvar ? "Salvar na proposta" : null), infoProposta: opts.infoProposta || null, condId: null, entradaPct: 20, entradaValor: 0, entradaParcelas: 1, prazo: 240, res: null, _balaoPreenchido: null };
        $q("#sklSimTitulo", d).textContent = st.ctx.rotulo;
        $q("#sklSimValor", d).value = st.ctx.valor > 0 ? brl(st.ctx.valor) : "";
        // o preço do lote/unidade só a Central altera — no Corretor o valor vem da Central e fica travado
        const campoValor = $q("#sklSimValor", d);
        campoValor.readOnly = st.papel !== "central";
        campoValor.title = campoValor.readOnly ? "Valor definido pela Central" : "";
        campoValor.style.background = campoValor.readOnly ? "#f1f4f5" : "";
        const inicial = (anterior && st.condicoes.find((x) => String(x.id) === String(anterior.condicao_id))) || st.condicoes[0];
        if (anterior && String(inicial.id) === String(anterior.condicao_id) && Array.isArray(anterior.baloes) && anterior.baloes.length) {
            st.ctx._balaoPreenchido = anterior.baloes;
        }
        escolherCondicao(inicial.id, false);
        if (anterior && String(inicial.id) === String(anterior.condicao_id)) {
            st.ctx.entradaPct = anterior.entrada_pct; st.ctx.entradaValor = anterior.entrada_valor; st.ctx.prazo = anterior.prazo_meses;
            st.ctx.entradaParcelas = Number(anterior.entrada_parcelas) || 1;
            pintarEntrada(); pintarPrazo(); pintar();
        }
        if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", "");
        d.querySelector(".skl-sim-card").scrollTop = 0;
    }

    // ------------------------------------------------------------------ proposta impressa (Central)
    // Tela cheia com a proposta (resumo + quadro completo de parcelas) e o botão "Imprimir / Salvar PDF".
    // Fecha os diálogos abertos enquanto a proposta está na tela (senão o <dialog> modal fica por cima
    // e a impressão sai só com uma página) e reabre os mesmos ao voltar.
    const PRINT_CSS = `
#sklSimPrintArea{position:fixed;inset:0;z-index:2147483000;overflow:auto;background:#d5dee6;-webkit-overflow-scrolling:touch}
#sklSimPrintArea .pp-barra{position:sticky;top:0;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;padding:10px;background:#0d2a3a;z-index:2}
#sklSimPrintArea .pp-barra button{border:0;border-radius:10px;padding:11px 16px;font-weight:800;font-size:14px;cursor:pointer;min-height:44px}
#sklSimPrintArea .pp-barra .pri{background:#E6B857;color:#3a2a00}
#sklSimPrintArea .pp-barra .sec{background:#e9f0f3;color:#0d2a3a}
#sklSimPrintArea .pp-doc{background:#fff;color:#1d2b30;max-width:820px;margin:18px auto 40px;padding:34px 38px;border-radius:6px;box-shadow:0 10px 40px rgba(0,0,0,.18);font-family:Inter,"Segoe UI",Arial,sans-serif;font-size:13px}
#sklSimPrintArea h1{font-size:21px;margin:0 0 2px;color:#163D26}
#sklSimPrintArea .pp-sub{color:#66777c;margin:0 0 16px}
#sklSimPrintArea .pp-info{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;margin:0 0 16px;padding:12px 14px;border:1px solid #dfe6e9;border-radius:8px}
#sklSimPrintArea .pp-info span{display:block;font-size:11px;color:#66777c}
#sklSimPrintArea h2{font-size:14px;margin:18px 0 8px;color:#163D26;text-transform:uppercase;letter-spacing:.05em}
#sklSimPrintArea table{width:100%!important;min-width:0!important;max-width:100%;border-collapse:collapse;font-size:12px;table-layout:auto}
#sklSimPrintArea th,#sklSimPrintArea td{padding:5px 6px;border-bottom:1px solid #e6ecee;text-align:right;white-space:nowrap;position:static!important}
#sklSimPrintArea th:first-child,#sklSimPrintArea td:first-child{text-align:left}
#sklSimPrintArea th{background:#f3f6f7;font-size:11px}
#sklSimPrintArea .pp-dl{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}
#sklSimPrintArea .pp-dl div{display:flex;justify-content:space-between;gap:10px;border-bottom:1px dashed #dbe4e8;padding:4px 0}
#sklSimPrintArea .pp-dl dt{color:#66777c}#sklSimPrintArea .pp-dl dd{margin:0;font-weight:700;text-align:right}
#sklSimPrintArea .pp-minis{display:flex;flex-wrap:wrap;gap:0 28px}#sklSimPrintArea .pp-mini{flex:1 1 260px;max-width:380px}
#sklSimPrintArea .pp-aviso{margin-top:18px;font-size:11px;color:#66777c}
#sklSimPrintArea .pp-ass{display:flex;gap:40px;margin-top:60px}#sklSimPrintArea .pp-ass div{flex:1;border-top:1px solid #333;padding-top:6px;text-align:center;font-size:11px}
#sklSimPrintArea .pp-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
@media(max-width:600px){#sklSimPrintArea .pp-doc{padding:20px 16px;margin:10px 6px 30px}#sklSimPrintArea table{font-size:11px}#sklSimPrintArea th,#sklSimPrintArea td{padding:4px 4px}#sklSimPrintArea .pp-dl,#sklSimPrintArea .pp-info{grid-template-columns:1fr}}
@media print{
  body.sklsim-imprimindo>*:not(#sklSimPrintArea){display:none!important}
  body.sklsim-imprimindo #sklSimPrintArea{position:static!important;overflow:visible!important;background:#fff!important}
  #sklSimPrintArea .pp-barra{display:none!important}
  #sklSimPrintArea .pp-doc{box-shadow:none!important;margin:0!important;max-width:none!important;padding:0!important}
  #sklSimPrintArea tr{break-inside:avoid}
  #sklSimPrintArea .pp-scroll{overflow:visible!important}
}`;
    let printReabrir = [];
    function fecharProposta() {
        const area = $q("#sklSimPrintArea");
        if (area) area.remove();
        document.body.classList.remove("sklsim-imprimindo");
        const reabrir = printReabrir; printReabrir = [];
        reabrir.forEach((dlg) => { try { if (!dlg.open) dlg.showModal(); } catch (e) {} });
    }
    async function imprimirProposta(snap, info) {
        if (!snap) return;
        info = info || {};
        if (!$q("#sklSimPrintCss")) { const s = document.createElement("style"); s.id = "sklSimPrintCss"; s.textContent = PRINT_CSS; document.head.appendChild(s); }
        if (!st.condicoes.length) await carregar();
        // refaz o quadro completo a partir da condição (se ela ainda existir) e dos números salvos
        const cond = st.condicoes.find((x) => String(x.id) === String(snap.condicao_id));
        const res = cond ? calcular({ valor: snap.valor_imovel, entradaValor: snap.entrada_valor, prazo: snap.prazo_meses, baloes: snap.baloes || [], entradaParcelas: snap.entrada_parcelas || 1 }, cond, st.config) : null;
        const hojeTxt = new Date().toLocaleDateString("pt-BR");
        const dl = (pares) => `<dl class="pp-dl">${pares.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
        const resumo = [
            ["Condição", esc(snap.condicao_nome)],
            ["Valor do imóvel", brl(snap.valor_imovel)],
            ["Entrada", entradaTxt(snap)],
            ["Valor financiado", brl(snap.valor_financiado)],
            ["Prazo", `${snap.prazo_meses} meses`],
            ["Parcela", snap.sistema === "sac" && snap.parcela_final < snap.parcela_inicial - 0.005 ? `${brl(snap.parcela_inicial)} → ${brl(snap.parcela_final)}` : brl(snap.parcela_inicial)],
            ["Juros / correção", esc(jurosTxt(snap))]
        ];
        if (Array.isArray(snap.baloes) && snap.baloes.length) resumo.push(["Balão", balaoTexto(snap).replace(/^ · Balão /, "")]);
        if (temCet(snap)) resumo.push(["CET", cetTxt(snap)]);
        if (mostraTotais()) resumo.push(["Total pago", brl(snap.total_pago)]);
        let entradaTabela = "";
        const nEnt = Math.max(1, Number(snap.entrada_parcelas) || 1);
        if (nEnt > 1) {
            const vEnt = Number(snap.entrada_parcela_valor) || snap.entrada_valor / nEnt;
            entradaTabela = `<div class="pp-mini"><h2>Entrada (${nEnt}x sem juros)</h2><table><thead><tr><th>Parcela da entrada</th><th>Valor</th></tr></thead><tbody>${Array.from({ length: nEnt }, (_, k) => `<tr><td>${k + 1}ª</td><td>${brl(vEnt)}</td></tr>`).join("")}</tbody></table></div>`;
        }
        const baloesTabela = Array.isArray(snap.baloes) && snap.baloes.length ? `<div class="pp-mini"><h2>Balões</h2><table><thead><tr><th>Mês</th><th>Valor</th></tr></thead><tbody>${snap.baloes.map((b) => `<tr><td>${b.mes}</td><td>${brl(b.valor)}</td></tr>`).join("")}</tbody></table></div>` : "";
        const quadro = res && res.ok
            ? `<h2>Quadro de parcelas</h2><div class="pp-scroll"><table><thead><tr><th>Mês</th><th>Parcela</th><th>Juros</th><th>Amortização</th><th>Saldo</th></tr></thead><tbody>${res.tabela.map((r) => `<tr><td>${r.k}</td><td>${brl(r.parcela)}</td><td>${brl(r.juros)}</td><td>${brl(r.amort)}</td><td>${brl(r.saldo)}</td></tr>`).join("")}</tbody></table></div>`
            : `<p class="pp-aviso">A condição usada nesta simulação não está mais cadastrada — o quadro de parcelas não pôde ser refeito.</p>`;
        printReabrir = Array.from(document.querySelectorAll("dialog[open]"));
        printReabrir.forEach((dlg) => { try { dlg.close(); } catch (e) {} });
        const area = document.createElement("div");
        area.id = "sklSimPrintArea";
        area.innerHTML = `<div class="pp-barra"><button type="button" class="pri" data-pp="imprimir">Imprimir / Salvar PDF</button><button type="button" class="sec" data-pp="voltar">Voltar</button></div>
<div class="pp-doc">
  <h1>Proposta — ${esc(info.rotulo || snap.rotulo || "Simulação de financiamento")}</h1>
  <p class="pp-sub">${esc(info.empreendimento || "")}${info.empreendimento ? " · " : ""}emitida em ${hojeTxt}</p>
  <div class="pp-info"><div><span>Cliente</span><b>${esc(info.cliente || "—")}</b></div><div><span>Corretor</span><b>${esc(info.corretor || "—")}</b></div></div>
  <h2>Resumo</h2>${dl(resumo)}
  <div class="pp-minis">${entradaTabela}${baloesTabela}</div>${quadro}
  <p class="pp-aviso">${esc((st.config && st.config.aviso_texto) || "Simulação meramente ilustrativa, sem valor de proposta ou aprovação de crédito.")}</p>
  <div class="pp-ass"><div>Cliente</div><div>Empresa</div></div>
</div>`;
        document.body.appendChild(area);
        area.querySelector('[data-pp="voltar"]').addEventListener("click", fecharProposta);
        area.querySelector('[data-pp="imprimir"]').addEventListener("click", () => {
            document.body.classList.add("sklsim-imprimindo");
            if (window.NativeBridge && window.NativeBridge.printPage) { window.NativeBridge.printPage(); return; }
            const limpar = () => { document.body.classList.remove("sklsim-imprimindo"); window.removeEventListener("afterprint", limpar); };
            window.addEventListener("afterprint", limpar);
            window.print();
        });
        area.scrollTop = 0;
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
        calcular, resumoHtml, resumoTexto, brl, parseValor, taxaMensal, entradaMinimaPct, imprimirProposta
    };
})();
