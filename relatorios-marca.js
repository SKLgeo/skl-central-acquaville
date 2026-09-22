/* Relatórios comerciais com marca (Vendas, Ranking e Comissões) — SKL (Base / Unificado). NÃO faz parte do app da Carmel.
 *
 * FONTE ÚNICA do visual: este arquivo é usado
 *   (1) dentro da Central (botões em Relatórios → "Relatórios comerciais"): PDF (pré-visualização + Imprimir / Salvar PDF)
 *       e planilha CSV para Excel; e
 *   (2) pelo gerador de exemplos em Node: Codigo_Fonte/Modelo_Relatorios/gerar.js  (require deste arquivo).
 *
 * Marca: por empreendimento em  empreendimentos.config.marca_relatorio  =
 *   { "nome": "Nome da empresa", "slogan": "...", "logo": "<data:image/png;base64,... ou https://...>",
 *     "cor_primaria": "#0a2a4a", "cor_secundaria": "#0b4f78", "cor_destaque": "#29abe2", "cor_ouro": "#c9a227",
 *     "rodape": "texto do rodapé", "mostrar_selo_skl": false }
 * Sem esse campo, sai com a marca SKL Soluções Digitais.
 *
 * Formato dos dados (D): { vendas:[{tipo_imovel:"Lote"|"Apartamento", empreendimento, imovel, valor, corretor, cliente, origem, data,
 *   comissao_valor, comissao_pct, comissao_status}], ranking?:[...] (se ausente, é calculado das vendas),
 *   pedidos?:{total, por_status}, periodo?:{inicio, fim, rotulo}, empreendimentos?:[nomes], aviso?, regras?:{pedido_min, validade_min} }
 */
(function (root) {
    "use strict";

    const MARCA_SKL = {
        nome: "SKL Soluções Digitais",
        slogan: "Mapeamento · Gestão · Conexão comercial",
        logo: "logo.png",
        cor_primaria: "#0a2a4a", cor_secundaria: "#0b4f78", cor_destaque: "#29abe2", cor_ouro: "#c9a227",
        rodape: "SKL Soluções Digitais · contato@sklgeosolucoes.com.br · (66) 9.9612-1567",
        mostrar_selo_skl: false
    };

    // ---------- utilidades
    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const brl = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    const brlK = (n) => { n = Number(n || 0); return n >= 1e6 ? "R$ " + (n / 1e6).toFixed(2).replace(".", ",") + " mi" : n >= 1e3 ? "R$ " + (n / 1e3).toFixed(0) + " mil" : brl(n); };
    const num = (n) => Number(n || 0).toLocaleString("pt-BR");
    const fmtData = (d) => (d ? new Date(d).toLocaleString("pt-BR", { timeZone: "America/Cuiaba", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(", ", " ") : "—");
    const fmtDia = (d) => (d ? new Date(d).toLocaleDateString("pt-BR", { timeZone: "America/Cuiaba", day: "2-digit", month: "long", year: "numeric" }) : "—");
    const soma = (a, f) => a.reduce((t, x) => t + Number(f(x) || 0), 0);
    const SIT = { pendente: "Pendente", aprovada: "Aprovada", paga: "Paga", cancelada: "Cancelada" };
    const dec = (n) => String(Number(n || 0).toFixed(2)).replace(".", ",");

    function marcaFinal(m) { return Object.assign({}, MARCA_SKL, m || {}); }

    // ---------- ranking calculado das vendas (quando o dado não traz pronto)
    function calcularRanking(vendas) {
        const por = new Map();
        vendas.forEach((v) => {
            const nome = v.corretor; if (!nome || nome === "—") return;
            const r = por.get(nome) || { corretor: nome, vendas: 0, lotes: 0, apartamentos: 0, pcts: [], valor_vendido: 0, comissao: 0, pendente: 0, aprovada: 0, paga: 0 };
            r.vendas++; if (v.tipo_imovel === "Lote") r.lotes++; else r.apartamentos++;
            r.valor_vendido += Number(v.valor || 0);
            if (v.comissao_status !== "cancelada") {
                const c = Number(v.comissao_valor || 0); r.comissao += c;
                r[v.comissao_status === "paga" ? "paga" : v.comissao_status === "aprovada" ? "aprovada" : "pendente"] += c;
            }
            if (v.comissao_pct) r.pcts.push(Number(v.comissao_pct));
            por.set(nome, r);
        });
        return [...por.values()].map((r) => ({ ...r, percentual: r.pcts.length ? Math.round((r.pcts.reduce((a, b) => a + b, 0) / r.pcts.length) * 100) / 100 : 0 }))
            .sort((a, b) => b.comissao - a.comissao || b.valor_vendido - a.valor_vendido)
            .map((r, i) => { delete r.pcts; return { posicao: i + 1, ...r }; });
    }

    // ---------- CSV (Excel PT-BR: ";" como separador, vírgula decimal, BOM UTF-8)
    const csvCel = (x) => { const s = String(x ?? ""); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = (cab, linhas) => "\uFEFF" + [cab, ...linhas].map((l) => l.map(csvCel).join(";")).join("\r\n") + "\r\n";
    function montarCsv(D) {
        const V = D.vendas || [], R = D.ranking || calcularRanking(V);
        return {
            vendas: csv(["Data", "Empreendimento", "Tipo", "Imóvel", "Cliente", "Corretor(a)", "Origem", "Valor da venda (R$)", "% Comissão", "Comissão (R$)", "Situação da comissão"],
                V.map((v) => [fmtData(v.data), v.empreendimento, v.tipo_imovel, v.imovel, v.cliente, v.corretor, v.origem, dec(v.valor), dec(v.comissao_pct), dec(v.comissao_valor), SIT[v.comissao_status] || v.comissao_status || "—"])),
            ranking: csv(["Posição", "Corretor(a)", "Vendas", "Lotes", "Apartamentos", "% Comissão", "Valor vendido (R$)", "Comissão total (R$)", "Pendente (R$)", "Aprovada (R$)", "Paga (R$)"],
                R.map((r) => [r.posicao, r.corretor, r.vendas, r.lotes, r.apartamentos, dec(r.percentual), dec(r.valor_vendido), dec(r.comissao), dec(r.pendente), dec(r.aprovada), dec(r.paga)]))
        };
    }

    // ---------- estilo (as cores vêm da marca). escopo "" = página inteira (Node); "#rm-doc" = embutido na Central
    function cssBase(M) {
        return `
:root{--p:${M.cor_primaria};--s:${M.cor_secundaria};--d:${M.cor_destaque};--o:${M.cor_ouro};--tx:#12263a;--mut:#5b6f82;--bg:#eef4fa;--ln:#d6e2ee}
@page{size:A4;margin:22mm 14mm 18mm 14mm}
*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:"Segoe UI",Arial,sans-serif;color:var(--tx);font-size:9.6pt;line-height:1.42;margin:0}
.cab{position:fixed;top:-16mm;left:0;right:0;height:11mm;display:flex;justify-content:space-between;align-items:center;border-bottom:.5mm solid var(--d)}
.cab img{height:9mm}.cab span{font-size:8pt;color:var(--mut);text-transform:uppercase;letter-spacing:.12em}
.rod{position:fixed;bottom:-13mm;left:0;right:0;font-size:7.6pt;color:var(--mut);display:flex;justify-content:space-between;border-top:.25mm solid var(--ln);padding-top:1.5mm}
h1{font-size:22pt;color:var(--p);margin:0 0 1mm;font-weight:700}
h2{font-size:14pt;color:var(--p);margin:7mm 0 2.5mm;padding-left:3mm;border-left:1.6mm solid var(--d);break-after:avoid}
h3{font-size:10.5pt;color:var(--s);margin:4mm 0 1.5mm;break-after:avoid}
.sub{color:var(--mut);margin-bottom:4mm}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:3mm;margin:3mm 0}
.kpi{background:var(--bg);border-radius:2.5mm;padding:3.5mm 3mm;border-top:1.2mm solid var(--d)}
.kpi.ouro{border-top-color:var(--o)}.kpi b{display:block;font-size:14.5pt;color:var(--p);line-height:1.15}.kpi span{font-size:7.8pt;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
table{border-collapse:collapse;width:100%;margin:2mm 0 3mm;font-size:8.3pt}
th{background:var(--p);color:#fff;text-align:left;padding:1.6mm 2mm;font-weight:600}td{border-bottom:.25mm solid var(--ln);padding:1.3mm 2mm;vertical-align:top}
tr:nth-child(even) td{background:#f5f9fd}td.r,th.r{text-align:right;white-space:nowrap}tr{break-inside:avoid}thead{display:table-header-group}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:5mm}.card{border:.3mm solid var(--ln);border-radius:2.5mm;padding:3.5mm;break-inside:avoid}
.card h3{margin-top:0}.nota{font-size:8pt;color:var(--mut)}.pb{break-before:page}
.barra{display:flex;align-items:center;gap:2mm;margin:1.1mm 0;font-size:8.2pt}.barra .n{width:41mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.barra .t{flex:1;background:#e6eef6;border-radius:1mm;height:4.4mm;overflow:hidden}.barra .t i{display:block;height:100%;background:linear-gradient(90deg,var(--s),var(--d));border-radius:1mm}.barra .v{width:24mm;text-align:right;color:var(--p);font-weight:600}
.pod{display:grid;grid-template-columns:1fr 1.15fr 1fr;gap:4mm;align-items:end;margin:4mm 0 5mm}
.pod div{border-radius:3mm;padding:4mm 3mm;text-align:center;color:#fff}.pod .p1{background:linear-gradient(160deg,var(--o),#8a6d12);padding-bottom:9mm}.pod .p2{background:linear-gradient(160deg,#7d93a8,#4a5f73);padding-bottom:6mm}.pod .p3{background:linear-gradient(160deg,#b98a5c,#7a5230);padding-bottom:4mm}
.pod .pos{font-size:20pt;font-weight:800;line-height:1}.pod .nm{font-size:10pt;font-weight:700;margin:1.5mm 0 .5mm}.pod .vl{font-size:12.5pt;font-weight:700}.pod small{display:block;opacity:.9;font-size:7.8pt}
.selo{display:inline-block;background:#fff3cd;color:#7a5c00;border:.3mm solid #e6cf7a;border-radius:5mm;padding:.8mm 3mm;font-size:8pt}
.capa{break-after:page;height:248mm;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(155deg,var(--p) 0%,var(--s) 62%,var(--d) 130%);color:#fff;border-radius:3mm;padding:16mm 14mm;margin-top:-4mm}
.capa img{width:118mm;max-width:100%;background:#fff;border-radius:3mm;padding:2mm}.capa h1{color:#fff;font-size:31pt;line-height:1.1;margin:0 0 4mm}.capa .fx{width:38mm;height:1.6mm;background:var(--o);margin:5mm 0}
.capa p{margin:0;font-size:11.5pt;opacity:.95}.capa .pill{display:inline-block;margin-top:6mm}
.capa .info{font-size:9pt;opacity:.9;border-top:.3mm solid rgba(255,255,255,.35);padding-top:4mm}
`;
    }

    // prefixa todos os seletores com um escopo (para embutir na Central sem afetar o resto da página)
    function escopar(css, S) {
        if (!S) return css;
        const out = [];
        css.replace(/\s+$/, "").split(/}\s*/).forEach((rule) => {
            if (!rule.trim()) return;
            const i = rule.indexOf("{"); if (i < 0) return;
            const sel = rule.slice(0, i).trim(), corpo = rule.slice(i + 1);
            if (sel.startsWith("@")) { out.push(rule + "}"); return; }
            const corpoFinal = sel === "body" ? corpo.replace(/;?margin:0/, "") : corpo;
            const novo = sel.split(",").map((s) => { s = s.trim(); return (s === ":root" || s === "html" || s === "body") ? S : (s === "*" ? S + ",\n" + S + " *" : S + " " + s); }).join(",");
            out.push(novo + "{" + corpoFinal + "}");
        });
        out.push(`@media screen{${S} .cab,${S} .rod{position:static;margin-bottom:4mm}${S} .rod{margin-top:6mm}${S} .capa{height:auto;min-height:150mm;margin-top:0}${S} .pb{margin-top:10mm}${S} table{display:block;overflow-x:auto}}`);
        return out.join("\n");
    }

    // ---------- blocos de HTML
    const kpi = (v, t, ouro) => `<div class="kpi${ouro ? " ouro" : ""}"><b>${v}</b><span>${t}</span></div>`;
    const tabela = (cab, linhas, dir) => { dir = dir || []; return `<table><thead><tr>${cab.map((c, i) => `<th class="${dir.includes(i) ? "r" : ""}">${c}</th>`).join("")}</tr></thead><tbody>${linhas.map((l) => `<tr>${l.map((c, i) => `<td class="${dir.includes(i) ? "r" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`; };
    const barras = (itens, fmt) => { const mx = Math.max(...itens.map((i) => i.v), 1); return itens.map((i) => `<div class="barra"><span class="n">${esc(i.n)}</span><span class="t"><i style="width:${Math.max(2, (i.v / mx) * 100)}%"></i></span><span class="v">${fmt(i.v)}</span></div>`).join(""); };
    const podio = (top) => { const c = ["p2", "p1", "p3"], ordem = [1, 0, 2]; if (!top.length) return ""; return `<div class="pod">${ordem.map((k) => top[k] ? `<div class="${c[ordem.indexOf(k)]}"><div class="pos">${k + 1}º</div><div class="nm">${esc(top[k].corretor)}</div><div class="vl">${brl(top[k].comissao)}</div><small>${top[k].vendas} ${top[k].vendas === 1 ? "venda" : "vendas"} · ${brlK(top[k].valor_vendido)} vendidos</small></div>` : "<div></div>").join("")}</div>`; };

    // ---------- monta os 3 relatórios (HTML do corpo) + CSVs.  opts: { escopo, logoSrc, documento:true|false }
    function montar(D, marca, opts) {
        opts = opts || {};
        const M = marcaFinal(marca), V = D.vendas || [], R = D.ranking || calcularRanking(V);
        const logo = opts.logoSrc || M.logo;
        const vLotes = V.filter((v) => v.tipo_imovel === "Lote"), vAptos = V.filter((v) => v.tipo_imovel !== "Lote");
        const totVend = soma(V, (v) => v.valor), totCom = soma(V.filter((v) => v.comissao_status !== "cancelada"), (v) => v.comissao_valor);
        const comPor = { pendente: 0, aprovada: 0, paga: 0 };
        V.forEach((v) => { if (comPor[v.comissao_status] != null) comPor[v.comissao_status] += Number(v.comissao_valor || 0); });
        const vendedores = R.filter((r) => r.vendas > 0);
        const rot = (D.periodo && D.periodo.rotulo) || (D.periodo && D.periodo.inicio ? fmtDia(D.periodo.inicio) : "Todo o período");
        const periodo = esc(rot);
        const emps = (D.empreendimentos || []).map(esc).join(" · ");
        const aviso = D.aviso ? `<span class="selo">${esc(D.aviso)}</span>` : "";
        const S = opts.escopo || "";

        const moldura = (titulo, corpo, capa) => `<div class="cab"><img src="${logo}"><span>${esc(titulo)}</span></div>
<div class="rod"><span>${esc(M.rodape)}</span><span>${M.mostrar_selo_skl ? "Tecnologia SKL Soluções Digitais" : ""}</span></div>
${capa || ""}${corpo}`;
        const capaHtml = (titulo, sub) => `<div class="capa"><div><img src="${logo}"></div><div><h1>${esc(titulo)}</h1><div class="fx"></div><p>${esc(sub)}</p>${D.aviso ? `<span class="selo pill">${esc(D.aviso)}</span>` : ""}</div><div class="info">${esc(M.nome)}${M.slogan ? " — " + esc(M.slogan) : ""}<br>Gerado em ${fmtDia(new Date().toISOString())} · Período: ${periodo}</div></div>`;

        const resumoKpis = () => `<div class="kpis">${kpi(brl(totVend), "Total vendido")}${kpi(num(V.length), `Vendas (${vLotes.length} lotes · ${vAptos.length} aptos)`)}${kpi(brl(totCom), "Comissões geradas", true)}${kpi(brl(V.length ? totVend / V.length : 0), "Ticket médio")}</div>`;
        const compStatus = () => barras(["paga", "aprovada", "pendente"].map((k) => ({ n: SIT[k], v: comPor[k] || 0 })), brl);
        const porEmp = () => { const m = {}; V.forEach((v) => (m[v.empreendimento] = (m[v.empreendimento] || 0) + Number(v.valor || 0))); const it = Object.entries(m).map(([n, v]) => ({ n, v })); return it.length ? barras(it, brlK) : '<div class="nota">Sem vendas no período.</div>'; };
        const topCorretores = (n) => R.length ? barras(R.slice(0, n).map((r) => ({ n: r.corretor, v: r.comissao })), brl) : '<div class="nota">Sem comissões no período.</div>';
        const ped = D.pedidos || { total: 0, por_status: {} }; const ps = ped.por_status || {};
        const conv = ped.total ? Math.min(100, Math.round((V.length / ped.total) * 100)) + "%" : "—";
        const regras = D.regras || { pedido_min: 20, validade_min: 120 };
        const hMin = (m) => (m % 60 === 0 && m >= 60 ? (m / 60) + " h" : m + " min");

        const executivo = moldura(`Relatório executivo — ${M.nome}`, `
<h2 style="margin-top:0">Resumo dos resultados</h2>
${resumoKpis()}
<div class="grid2"><div class="card"><h3>Valor vendido por empreendimento</h3>${porEmp()}</div><div class="card"><h3>Comissões por situação</h3>${compStatus()}<div class="nota" style="margin-top:2mm">Comissão = valor da venda × percentual cadastrado de cada corretor.</div></div></div>
<h2>Destaques do ranking</h2>${podio(R.slice(0, 3)) || '<div class="nota">Sem vendas no período.</div>'}
<div class="card"><h3>Top 10 — comissões por corretor(a)</h3>${topCorretores(10)}</div>
<h2 class="pb" style="margin-top:0">Funil comercial</h2>
<div class="kpis">${kpi(num(ped.total), "Pedidos de reserva / indicação")}${kpi(num(ps.aprovada || 0), "Aprovados pela Central")}${kpi(num((ps.rejeitada || 0) + (ps.expirada || 0)), "Recusados ou vencidos")}${kpi(conv, "Pedidos que viraram venda", true)}</div>
<div class="grid2"><div class="card"><h3>Lotes</h3>${kpi(num(vLotes.length), "lotes vendidos")}<div class="nota" style="margin:2mm 0">${brl(soma(vLotes, (v) => v.valor))} em vendas</div></div><div class="card"><h3>Apartamentos</h3>${kpi(num(vAptos.length), "apartamentos vendidos")}<div class="nota" style="margin:2mm 0">${brl(soma(vAptos, (v) => v.valor))} em vendas</div></div></div>
<h2>Como o processo funciona</h2>
<div class="card"><table><tbody><tr><td><b>1. Reserva</b></td><td>O corretor pede a reserva pelo aplicativo (limite de ${hMin(regras.pedido_min)} para a Central responder).</td></tr><tr><td><b>2. Aprovação</b></td><td>A Central aprova; o imóvel fica reservado por ${hMin(regras.validade_min)} para o corretor juntar a documentação.</td></tr><tr><td><b>3. Venda</b></td><td>A Central marca como vendido e registra a comissão do corretor.</td></tr><tr><td><b>4. Comissão</b></td><td>Pendente → aprovada → paga, com relatório por corretor a qualquer momento.</td></tr></tbody></table></div>`,
            capaHtml("Relatório executivo de vendas e comissões", "Vendas de lotes e apartamentos, ranking de corretores e comissões"));

        const linhasV = (a) => a.map((v) => [fmtData(v.data), esc(v.imovel), esc(v.cliente), esc(v.corretor), esc(v.origem), brl(v.valor), brl(v.comissao_valor)]);
        const cabV = ["Data", "Imóvel", "Cliente", "Corretor(a)", "Origem", "Valor", "Comissão"];
        const semVendas = '<div class="nota">Nenhuma venda registrada neste período.</div>';
        const vendas = moldura(`Relatório de vendas — ${M.nome}`, `
<h1>Relatório de vendas</h1><div class="sub">${periodo}${emps ? " · " + emps : ""}${aviso ? " · " + aviso : ""}</div>
${resumoKpis()}
${vLotes.length ? `<h2>Lotes vendidos — ${esc(vLotes[0].empreendimento)}</h2>${tabela(cabV, linhasV(vLotes), [5, 6])}<div class="nota"><b>${vLotes.length}</b> lotes · total <b>${brl(soma(vLotes, (v) => v.valor))}</b> · comissões <b>${brl(soma(vLotes, (v) => v.comissao_valor))}</b></div>` : ""}
${vAptos.length ? `<h2${vLotes.length ? ' class="pb" style="margin-top:0"' : ""}>Apartamentos vendidos — ${esc(vAptos[0].empreendimento)}</h2>${tabela(cabV, linhasV(vAptos), [5, 6])}<div class="nota"><b>${vAptos.length}</b> apartamentos · total <b>${brl(soma(vAptos, (v) => v.valor))}</b> · comissões <b>${brl(soma(vAptos, (v) => v.comissao_valor))}</b></div>` : ""}
${V.length ? "" : semVendas}`);

        const ranking = moldura(`Ranking e comissões — ${M.nome}`, `
<h1>Ranking de corretores e comissões</h1><div class="sub">${periodo} · ${vendedores.length} corretores com vendas${aviso ? " · " + aviso : ""}</div>
${podio(R.slice(0, 3))}
<div class="kpis">${kpi(brl(totCom), "Comissões geradas", true)}${kpi(brl(comPor.pendente), "Pendentes")}${kpi(brl(comPor.aprovada), "Aprovadas")}${kpi(brl(comPor.paga), "Pagas")}</div>
<h2>Classificação completa</h2>
${R.length ? tabela(["#", "Corretor(a)", "Vendas", "Lotes", "Aptos", "%", "Valor vendido", "Comissão", "Pendente", "Aprovada", "Paga"],
            R.map((r) => [r.posicao, esc(r.corretor), r.vendas, r.lotes, r.apartamentos, dec(r.percentual).replace(",00", "") + "%", brl(r.valor_vendido), `<b>${brl(r.comissao)}</b>`, brl(r.pendente), brl(r.aprovada), brl(r.paga)]), [2, 3, 4, 5, 6, 7, 8, 9, 10]) : semVendas}
<div class="nota">Comissão = valor da venda × percentual do corretor. Percentuais são definidos no cadastro de cada corretor e podem variar conforme o contrato de cada empresa.</div>`);

        const css = escopar(cssBase(M), S);
        return { css, executivo, vendas, ranking, csv: montarCsv(D), marca: M };
    }

    // documento HTML completo (Node / arquivo avulso)
    function documento(titulo, corpo, css) {
        return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title><style>${css}</style></head><body>${corpo}</body></html>`;
    }

    const API = { montar, documento, calcularRanking, montarCsv, MARCA_SKL, marcaFinal, util: { brl, fmtData, esc } };

    // =====================================================================================
    // Interface na Central (só no navegador)
    // =====================================================================================
    if (typeof document !== "undefined") {
        const $ = (sel, r) => (r || document).querySelector(sel);
        let opts = null, box = null, ocupado = false;
        const toast = (m) => { if (opts && typeof opts.toast === "function") opts.toast(m); else alert(m); };

        const CSS_UI = `
.rm-panel{grid-column:1/-1}.rm-panel p{margin:4px 0 10px;color:#5b6f78}
.rm-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:8px 0}
.rm-row label{font-weight:700;font-size:13px;color:#45606c}.rm-row select{padding:9px 10px;border:1px solid #cdd9df;border-radius:8px;font-size:14px;background:#fff}
.rm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;margin-top:8px}
.rm-grid button{text-align:left;padding:12px 14px;border-radius:12px;border:1px solid #cfe0ea;background:#f4f8fa;color:var(--navy,#0b4f78);font-weight:800;cursor:pointer;font-size:14px}
.rm-grid button small{display:block;font-weight:500;color:#6a7d86;margin-top:2px;font-size:12px}
.rm-grid button:disabled{opacity:.55;cursor:wait}
.rm-grid .pdf{border-left:5px solid #c0392b}.rm-grid .xls{border-left:5px solid #1e8449}
#rm-overlay{display:none;position:fixed;inset:0;z-index:99999;background:#d5dee6;overflow:auto}
#rm-overlay.aberto{display:block}
#rm-bar{position:sticky;top:0;z-index:3;display:flex;gap:10px;justify-content:space-between;align-items:center;padding:10px 14px;background:#0a2a4a;color:#fff;flex-wrap:wrap}
#rm-bar b{font-size:14px}#rm-bar .rm-acoes{display:flex;gap:8px}
#rm-bar button{border:0;border-radius:8px;padding:9px 14px;font-weight:800;cursor:pointer;font-size:14px}
#rm-bar .prim{background:#29abe2;color:#fff}#rm-bar .sec{background:#e9eff1;color:#0b4f78}
#rm-doc{max-width:210mm;margin:14px auto;background:#fff;padding:10mm 12mm;box-shadow:0 4px 24px rgba(0,0,0,.25)}
@media print{
  body.rm-imprimindo>*:not(#rm-overlay){display:none!important}
  body.rm-imprimindo #rm-overlay{display:block!important;position:static!important;background:#fff!important;overflow:visible!important}
  body.rm-imprimindo #rm-bar{display:none!important}
  body.rm-imprimindo #rm-doc{max-width:none;margin:0;padding:0;box-shadow:none}
  body.rm-imprimindo #rm-doc .cab,body.rm-imprimindo #rm-doc .rod{position:fixed}
}`;

        function garantirOverlay() {
            if ($("#rm-overlay")) return;
            const st = document.createElement("style"); st.id = "rm-estilo-ui"; st.textContent = CSS_UI; document.head.appendChild(st);
            const ov = document.createElement("div"); ov.id = "rm-overlay";
            ov.innerHTML = `<div id="rm-bar"><b id="rm-titulo">Relatório</b><div class="rm-acoes"><button class="prim" id="rm-imprimir" type="button">Imprimir / Salvar PDF</button><button class="sec" id="rm-fechar" type="button">Fechar</button></div></div><style id="rm-estilo-doc"></style><div id="rm-doc"></div>`;
            document.body.appendChild(ov);
            $("#rm-fechar").addEventListener("click", fechar);
            $("#rm-imprimir").addEventListener("click", imprimir);
            window.addEventListener("afterprint", () => document.body.classList.remove("rm-imprimindo"));
        }
        function fechar() { const ov = $("#rm-overlay"); if (ov) ov.classList.remove("aberto"); document.body.classList.remove("rm-imprimindo"); }
        function imprimir() {
            document.body.classList.add("rm-imprimindo");
            const fim = () => setTimeout(() => document.body.classList.remove("rm-imprimindo"), 1500);
            if (window.NativeBridge && window.NativeBridge.printPage) { window.NativeBridge.printPage(); setTimeout(() => document.body.classList.remove("rm-imprimindo"), 60000); return; }
            setTimeout(() => { try { window.print(); } finally { fim(); } }, 60);
        }
        function abrir(titulo, html, css) {
            garantirOverlay();
            $("#rm-titulo").textContent = titulo;
            $("#rm-estilo-doc").textContent = css;
            $("#rm-doc").innerHTML = html;
            const ov = $("#rm-overlay"); ov.classList.add("aberto"); ov.scrollTop = 0;
        }
        function baixarCsv(nome, conteudo) {
            if (window.NativeBridge && window.NativeBridge.saveTextFile) {
                window.NativeBridge.saveTextFile(btoa(unescape(encodeURIComponent(conteudo))), nome, "text/csv");
                return;
            }
            const blob = new Blob([conteudo], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob), a = document.createElement("a");
            a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            toast(`${nome} salvo na pasta de downloads.`);
        }

        // ---------- coleta dos dados (mesmas tabelas que a Central já lê)
        function limitesPeriodo(cod) {
            const agora = new Date(), fim = agora.toISOString();
            if (cod === "mes") { const i = new Date(agora.getFullYear(), agora.getMonth(), 1); return { inicio: i.toISOString(), fim, rotulo: "Este mês (" + i.toLocaleDateString("pt-BR") + " a " + agora.toLocaleDateString("pt-BR") + ")" }; }
            const dias = cod === "30" ? 30 : cod === "90" ? 90 : null;
            if (!dias) return { inicio: null, fim, rotulo: "Todo o período" };
            const i = new Date(agora.getTime() - dias * 864e5);
            return { inicio: i.toISOString(), fim, rotulo: `Últimos ${dias} dias (${i.toLocaleDateString("pt-BR")} a ${agora.toLocaleDateString("pt-BR")})` };
        }
        const parseValor = (v) => { if (v == null || v === "") return 0; if (typeof v === "number") return v; const s = String(v).replace(/[^\d,.-]/g, ""); return s.includes(",") ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s); };

        async function coletar(cod) {
            const sb = opts.sb, empId = await opts.getEmpreendimentoId();
            const per = limitesPeriodo(cod);
            const { data: emp } = await sb.from("empreendimentos").select("nome, tipo, config, reserva_pedido_min, reserva_validade_min").eq("id", empId).maybeSingle();
            const vertical = (emp && emp.tipo) === "vertical";
            const empNome = (emp && emp.nome) || opts.getEmpreendimentoNome && opts.getEmpreendimentoNome() || "Empreendimento";
            const marca = emp && emp.config && emp.config.marca_relatorio ? emp.config.marca_relatorio : null;

            const [imoveisRes, solRes, comRes, torRes] = await Promise.all([
                vertical
                    ? sb.from("unidades").select("id, numero, andar, torre_id, valor, cliente, updated_at").eq("empreendimento_id", empId).eq("status", "vendido")
                    : sb.from("lotes").select("id, quadra, lote, valor, cliente, updated_at").eq("empreendimento_id", empId).eq("status", "vendido"),
                sb.from("solicitacoes").select("id, tipo, status, cliente_nome, lote_id, unidade_id, revisado_em, created_at, criado_por_perfil:perfis!solicitacoes_criado_por_fkey(nome_exibicao)").eq("empreendimento_id", empId).order("created_at", { ascending: false }).limit(5000),
                sb.from("comissoes").select("*").eq("empreendimento_id", empId).order("criado_em", { ascending: false }).limit(5000),
                vertical ? sb.from("torres").select("id, nome").eq("empreendimento_id", empId) : Promise.resolve({ data: [] })
            ]);
            if (imoveisRes.error) throw imoveisRes.error; if (solRes.error) throw solRes.error; if (comRes.error) throw comRes.error;
            const torre = new Map((torRes.data || []).map((t) => [t.id, t.nome]));
            const sols = solRes.data || [], comis = comRes.data || [];
            const comPorSol = new Map(comis.filter((c) => c.solicitacao_id).map((c) => [c.solicitacao_id, c]));
            const usadas = new Set();
            const nomeImovel = (i) => vertical ? `${torre.get(i.torre_id) || "Torre"} · ${i.andar}º andar · Apto ${i.numero}` : `Quadra ${i.quadra} · Lote ${i.lote}`;

            const vendas = [];
            for (const i of imoveisRes.data || []) {
                const cands = sols.filter((s) => s.status === "aprovada" && (vertical ? s.unidade_id : s.lote_id) === i.id);
                const s = cands.find((x) => (x.cliente_nome || "").trim().toLowerCase() === (i.cliente || "").trim().toLowerCase()) || cands[0] || null;
                const c = s ? comPorSol.get(s.id) : null; if (c) usadas.add(c.id);
                const data = (c && c.criado_em) || i.updated_at;
                vendas.push({ tipo_imovel: vertical ? "Apartamento" : "Lote", empreendimento: empNome, imovel: nomeImovel(i), valor: c ? Number(c.valor_venda) : parseValor(i.valor), corretor: (c && c.corretor_nome) || (s && s.criado_por_perfil && s.criado_por_perfil.nome_exibicao) || "—", cliente: i.cliente || (s && s.cliente_nome) || "—", origem: !s ? "Venda direta (Central)" : s.tipo === "reserva" ? "Reserva → venda" : "Indicação de venda", data, comissao_valor: c ? Number(c.valor_comissao) : 0, comissao_pct: c ? Number(c.percentual) : 0, comissao_status: c ? c.status : "—" });
            }
            // comissões lançadas à mão (sem pedido/imóvel vinculado)
            for (const c of comis) {
                if (usadas.has(c.id)) continue;
                vendas.push({ tipo_imovel: vertical ? "Apartamento" : "Lote", empreendimento: empNome, imovel: c.observacao ? String(c.observacao).slice(0, 60) : "(comissão lançada manualmente)", valor: Number(c.valor_venda || 0), corretor: c.corretor_nome || "—", cliente: "—", origem: "Comissão lançada manualmente", data: c.criado_em, comissao_valor: Number(c.valor_comissao || 0), comissao_pct: Number(c.percentual || 0), comissao_status: c.status });
            }
            const ini = per.inicio ? Date.parse(per.inicio) : -Infinity;
            const noPeriodo = vendas.filter((v) => Date.parse(v.data) >= ini).sort((a, b) => Date.parse(a.data) - Date.parse(b.data));
            const solsPer = sols.filter((s) => Date.parse(s.created_at) >= ini);
            const porStatus = {}; solsPer.forEach((s) => { porStatus[s.status] = (porStatus[s.status] || 0) + 1; });
            const D = { vendas: noPeriodo, pedidos: { total: solsPer.length, por_status: porStatus }, periodo: per, empreendimentos: [empNome], regras: { pedido_min: (emp && emp.reserva_pedido_min) || 20, validade_min: (emp && emp.reserva_validade_min) || 120 } };
            return { D, marca, empNome };
        }

        async function acao(tipo, cod, botao) {
            if (ocupado) return; ocupado = true; botao.disabled = true;
            try {
                toast("Gerando relatório…");
                const { D, marca, empNome } = await coletar(cod);
                const nomeArq = (base) => `${base}_${empNome.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "")}_${new Date().toISOString().slice(0, 10)}`;
                const r = montar(D, marca, { escopo: "#rm-doc" });
                if (tipo === "csv_vendas") { baixarCsv(nomeArq("vendas") + ".csv", r.csv.vendas); toast(`Planilha de vendas gerada (${D.vendas.length} linhas).`); }
                else if (tipo === "csv_ranking") { baixarCsv(nomeArq("ranking_comissoes") + ".csv", r.csv.ranking); toast("Planilha de ranking e comissões gerada."); }
                else if (tipo === "pdf_exec") abrir("Relatório executivo", r.executivo, r.css);
                else if (tipo === "pdf_vendas") abrir("Relatório de vendas", r.vendas, r.css);
                else if (tipo === "pdf_rank") abrir("Ranking e comissões", r.ranking, r.css);
            } catch (e) {
                toast("Não foi possível gerar o relatório: " + (e && e.message ? e.message : e));
            } finally { ocupado = false; botao.disabled = false; }
        }

        API.montarPainel = function (container, o) {
            opts = o; box = container; garantirOverlay();
            container.innerHTML = `<span class="eyebrow">RELATÓRIOS COMERCIAIS</span><h2>Vendas, ranking e comissões</h2>
<p>Gere relatórios prontos, com a marca da empresa, para apresentar ou arquivar: PDF (abre uma pré-visualização com “Imprimir / Salvar PDF”) ou planilha CSV para o Excel.</p>
<div class="rm-row"><label for="rmPeriodo">Período</label><select id="rmPeriodo"><option value="todo">Todo o período</option><option value="mes">Este mês</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option></select></div>
<div class="rm-grid">
<button type="button" class="pdf" data-rm="pdf_exec">Relatório executivo (PDF)<small>Capa, resumo, gráficos, pódio e funil</small></button>
<button type="button" class="pdf" data-rm="pdf_vendas">Vendas (PDF)<small>Lotes/apartamentos vendidos, com comissão</small></button>
<button type="button" class="pdf" data-rm="pdf_rank">Ranking e comissões (PDF)<small>Pódio e classificação completa</small></button>
<button type="button" class="xls" data-rm="csv_vendas">Vendas (planilha Excel/CSV)<small>Todas as vendas do período</small></button>
<button type="button" class="xls" data-rm="csv_ranking">Ranking e comissões (planilha Excel/CSV)<small>Por corretor, com pendente/aprovada/paga</small></button>
</div>`;
            container.classList.add("rm-panel");
            container.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => acao(b.dataset.rm, $("#rmPeriodo", container).value, b)));
        };
    }

    if (typeof module !== "undefined" && module.exports) module.exports = API; else root.SKLRelatorios = API;
})(typeof window !== "undefined" ? window : globalThis);
