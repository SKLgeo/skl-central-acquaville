(() => {
    "use strict";
    const $ = id => document.getElementById(id);
    const STATUS = {
        disponivel: "Disponível",
        reservado: "Reservado",
        vendido: "Vendido",
        bloqueado: "Bloqueado",
        nao_informado: "Não informado"
    };
    const ROLE = {
        corretor: "Corretor",
        central_vendas: "Controle de vendas",
        administrador: "Administrador"
    };
    const ACTION = {
        "lot.updated": "alterou um lote",
        "request.created": "criou uma solicitação",
        "request.reviewed": "analisou uma solicitação",
        "user.invited": "gerou um convite",
        "user.updated": "alterou um usuário",
        "auth.login": "entrou no sistema",
        "auth.password_changed": "alterou a senha",
        "auth.activated": "ativou o acesso",
        "database.created": "criou a base inicial"
    };
    const SUPABASE_URL = "https://xigwlofqkmiibzbongkn.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_mqppAm9n79xl6rYafzXyNQ_mGVoX3Vd";
    const EMPREENDIMENTO_SLUG = "acquaville";
    const SLUGS_OCULTOS_NA_BASE = [ "skl-demo" ];
    // Cliente dedicado — este app só pode enxergar/gerenciar o empreendimento
    // dele, mesmo que a conta logada também tenha vínculo em outros
    // empreendimentos (Base, Aurora, etc.) por algum outro motivo. Sem isso,
    // uma conta com acesso múltiplo veria os empreendimentos de outro cliente
    // dentro do app com a marca da Acquaville.
    const SLUGS_PERMITIDOS = [ "acquaville" ];
    const APP_VERSION = "0.3.0";
    if ($("appVersionText")) $("appVersionText").textContent = `v${APP_VERSION}`;
    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            storageKey: "sklaqvc-auth"
        }
    });
    const EMP_ESCOLHIDO_KEY = "skl_empreendimento_escolhido";
    let empreendimentoId = null;
    let empreendimentoTipo = "loteamento";
    let empreendimentoNomeAtual = "";
    let empreendimentoSlugAtual = EMPREENDIMENTO_SLUG;
    let pendingUser = null;
    let currentUser = null;
    let lots = new Map;
    let unidades = new Map;
    let torres = [];
    let tiposPorId = new Map;
    let acabamentosPorId = new Map;
    let selectedUnit = null;
    let requests = [];
    let users = [];
    let invites = [];
    let auditItems = [];
    let selectedLot = null;
    let selectedRequest = null;
    let selectedLotKeys = new Set;
    let realtimeChannel = null;
    let lastSalesByWeek = [];
    let map = null;
    let geojson = null;
    let lotLayers = new Map;
    let satelliteLayer = null;
    let streetLayer = null;
    let activeBasemap = "satellite";
    let toastTimer = null;

    // Handoff de sessão vindo do app-casca "Central Unificada" (projeto de
    // integração Vendas+Aluguéis, Etapa 4) — só age quando este app está
    // carregado dentro do iframe da casca. Rodando sozinho, como hoje,
    // window.self === window.top e a função resolve na hora, sem nenhuma
    // mudança de comportamento nem atraso perceptível.
    function skl_aguardarSessaoDoShell(timeoutMs) {
        return new Promise(resolve => {
            if (window.self === window.top) return resolve(null);
            let done = false;
            function onMsg(ev) {
                if (ev.data && ev.data.type === "SKL_SESSION_HANDOFF") {
                    done = true;
                    window.removeEventListener("message", onMsg);
                    resolve(ev.data);
                }
            }
            window.addEventListener("message", onMsg);
            try { window.parent.postMessage({ type: "SKL_SESSION_REQUEST" }, "*"); } catch {}
            setTimeout(() => {
                if (!done) { window.removeEventListener("message", onMsg); resolve(null); }
            }, timeoutMs);
        });
    }

    bindEvents();
    skl_aguardarSessaoDoShell(1500).then(async sessao => {
        if (sessao) {
            try { await sb.auth.setSession({ access_token: sessao.access_token, refresh_token: sessao.refresh_token }); } catch {}
        }
        restoreSession();
    });
    function bindEvents() {
        $("loginForm").addEventListener("submit", login);
        $("activationForm").addEventListener("submit", activateAccount);
        $("showActivationButton").addEventListener("click", () => showAuthForm(true));
        $("backLoginButton").addEventListener("click", () => showAuthForm(false));
        $("logoutButton").addEventListener("click", logout);
        document.querySelectorAll(".nav-button").forEach(button => button.addEventListener("click", () => showPage(button.dataset.page)));
        document.querySelectorAll("[data-go]").forEach(button => button.addEventListener("click", () => showPage(button.dataset.go)));
        document.querySelectorAll(".metric-card").forEach(button => button.addEventListener("click", () => {
            if (empreendimentoTipo === "vertical") {
                $("unitStatusFilter").value = button.dataset.status === "nao_informado" ? "" : button.dataset.status;
                showPage("units");
                renderUnitsTable();
            } else {
                $("lotStatusFilter").value = button.dataset.status;
                showPage("lots");
                renderLots();
            }
        }));
        $("lotSearchInput").addEventListener("input", renderLots);
        $("lotStatusFilter").addEventListener("change", renderLots);
        $("toggleLotViewButton").addEventListener("click", () => {
            $("lotMapPanel").hidden = !$("lotMapPanel").hidden;
            if (!$("lotMapPanel").hidden) setTimeout(() => map && map.invalidateSize(), 80);
        });
        $("toggleBasemapButton").addEventListener("click", toggleBasemap);
        $("mapa3dButton").addEventListener("click", abrirMapa3D);
        $("mapa3dCloseButton").addEventListener("click", fecharMapa3D);
        $("newPaymentPlanButton").addEventListener("click", () => openPaymentPlanDialog(null));
        $("addSerieRowButton").addEventListener("click", () => addSerieRow());
        $("savePaymentPlanButton").addEventListener("click", savePaymentPlan);
        $("confirmDeletePaymentPlanButton").addEventListener("click", confirmDeletePaymentPlan);
        $("newBankingButton").addEventListener("click", () => openBankingDialog(null));
        $("saveBankingButton").addEventListener("click", saveBanking);
        $("confirmDeleteBankingButton").addEventListener("click", confirmDeleteBanking);
        $("newCommissionButton").addEventListener("click", openCommissionDialog);
        $("saveCommissionButton").addEventListener("click", saveCommission);
        $("saveLotButton").addEventListener("click", saveLot);
        $("requestFilter").addEventListener("change", renderRequests);
        $("refreshRequestsButton").addEventListener("click", loadRequests);
        $("approveRequestButton").addEventListener("click", () => reviewRequest("aprovada"));
        $("rejectRequestButton").addEventListener("click", () => reviewRequest("rejeitada"));
        $("newInviteButton").addEventListener("click", async () => {
            $("inviteResult").hidden = true;
            restrictRoleOptionsForCaller($("inviteRoleInput"));
            try {
                renderEmpreendimentoChecklist("inviteEmpList", "inviteEmpAllInput", await listarEmpreendimentosParaGestao());
            } catch (error) {
                toast(traduzErro(error.message));
            }
            $("inviteDialog").showModal();
        });
        $("newDirectUserButton").addEventListener("click", async () => {
            $("directUserMessage").hidden = true;
            restrictRoleOptionsForCaller($("directRoleInput"));
            try {
                renderEmpreendimentoChecklist("directEmpList", "directEmpAllInput", await listarEmpreendimentosParaGestao());
            } catch (error) {
                toast(traduzErro(error.message));
            }
            $("directUserDialog").showModal();
        });
        $("createDirectUserButton").addEventListener("click", createDirectUser);
        $("requestPlanButton").addEventListener("click", () => {
            $("planRequestMessage").hidden = true;
            $("planObservationInput").value = "";
            $("planRequestDialog").showModal();
        });
        $("submitPlanRequestButton").addEventListener("click", submitPlanRequest);
        $("createInviteButton").addEventListener("click", createInvite);
        $("refreshAuditButton").addEventListener("click", loadAudit);
        $("passwordForm").addEventListener("submit", changePassword);
        $("cvcrmSalvarButton").addEventListener("click", salvarCvcrmConfig);
        $("cvcrmTestarButton").addEventListener("click", testarCvcrmConexao);
        $("cvcrmSincronizarButton").addEventListener("click", sincronizarCvcrmDisponibilidade);
        $("cvcrmSincronizarPrecosButton").addEventListener("click", sincronizarCvcrmPrecos);
        $("selectAllLotsCheckbox").addEventListener("change", toggleSelectAllLots);
        $("bulkApplyButton").addEventListener("click", applyBulkStatus);
        $("bulkClearButton").addEventListener("click", clearLotSelection);
        $("refreshReportsButton").addEventListener("click", async () => {
            await Promise.all([ loadRequests(), loadAudit() ]);
            renderReports();
            toast("Dados dos relatórios atualizados.");
        });
        $("printReportButton").addEventListener("click", printReport);
        $("exportLotsCsvButton").addEventListener("click", exportLotsCsv);
        $("exportRankingCsvButton").addEventListener("click", exportRankingCsv);
        $("exportSalesCsvButton").addEventListener("click", exportSalesCsv);
        $("switchEmpreendimentoButton").addEventListener("click", trocarEmpreendimento);
        $("loadExampleTemplateButton").addEventListener("click", loadExampleTemplate);
        $("saveContractTemplateButton").addEventListener("click", saveContractTemplate);
        $("saveContractDataButton").addEventListener("click", saveContractData);
        $("generateContractButton").addEventListener("click", generateContract);
        $("saveUnitButton").addEventListener("click", saveUnitAdmin);
        $("unitSearchInput").addEventListener("input", renderUnitsTable);
        $("unitStatusFilter").addEventListener("change", renderUnitsTable);
        $("unitTorreFilter").addEventListener("change", renderUnitsTable);
        $("unitFloorFilter").addEventListener("change", renderUnitsTable);
        document.querySelectorAll(".unit-metric-card").forEach(button => button.addEventListener("click", () => {
            $("unitStatusFilter").value = $("unitStatusFilter").value === button.dataset.status ? "" : button.dataset.status;
            renderUnitsTable();
        }));
        $("unitQuickReserve").addEventListener("click", () => quickUpdateUnitStatus("reservado"));
        $("unitQuickSold").addEventListener("click", () => quickUpdateUnitStatus("vendido"));
        $("unitQuickBlock").addEventListener("click", () => quickUpdateUnitStatus("bloqueado"));
        $("unitEditFullButton").addEventListener("click", () => {
            if (selectedUnit) openUnitAdmin(selectedUnit.id);
        });
        $("unitSimButton").addEventListener("click", () => {
            if (!selectedUnit || !window.SKLSimulador) return;
            window.SKLSimulador.abrir({ valor: selectedUnit.valor, rotulo: `Apto ${selectedUnit.numero} · ${torreNome(selectedUnit.torre_id)}`, permiteUsar: false });
        });
        $("lotSimButton").addEventListener("click", () => {
            if (!selectedLot || !window.SKLSimulador) return;
            window.SKLSimulador.abrir({ valor: $("editLotValue").value || selectedLot.valor, rotulo: `Quadra ${selectedLot.quadra} · Lote ${selectedLot.lote}`, permiteUsar: false });
        });
        $("saveUserEmpreendimentosButton").addEventListener("click", saveUserEmpreendimentos);
        $("passwordToggleButton").addEventListener("click", () => {
            const mostrando = $("passwordInput").type === "text";
            $("passwordInput").type = mostrando ? "password" : "text";
            $("passwordToggleButton").textContent = mostrando ? "Mostrar" : "Ocultar";
            $("passwordToggleButton").setAttribute("aria-label", mostrando ? "Mostrar senha" : "Ocultar senha");
        });
        $("confirmResetPasswordButton").addEventListener("click", confirmResetPassword);
        $("confirmDeleteUserButton").addEventListener("click", confirmDeleteUser);
        document.querySelectorAll(".dialog-close").forEach(button => {
            button.addEventListener("click", () => button.closest("dialog")?.close());
        });
    }
    function h(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[char]));
    }
    function formatDate(value) {
        if (!value) return "—";
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR");
    }
    function formatArea(value) {
        return `${Number(value || 0).toLocaleString("pt-BR", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        })} m²`;
    }
    function statusPill(status) {
        return `<span class="status-pill ${h(status)}">${h(STATUS[status] || status)}</span>`;
    }
    function showMessage(element, message, success = false) {
        element.textContent = message;
        element.style.background = success ? "#dff4e8" : "#f7e8e6";
        element.style.color = success ? "#247346" : "#9a3b34";
        element.hidden = false;
    }
    function toast(message) {
        clearTimeout(toastTimer);
        $("toast").textContent = message;
        $("toast").hidden = false;
        toastTimer = setTimeout(() => $("toast").hidden = true, 3600);
    }
    function traduzErro(message) {
        const codigo = /^(REQUEST_PENDING|RESERVA_BLOQUEADA|RESERVA_ATIVA|REQUEST_EXPIRED):\s*(.*)$/s.exec(message || "");
        if (codigo) return codigo[2];
        const mapa = {
            "Invalid login credentials": "E-mail ou senha incorretos.",
            "A user with this email address has already been registered": "Já existe um usuário com esse e-mail (pode ser de outro empreendimento) — use um e-mail diferente.",
            "User already registered": "Já existe um usuário com esse e-mail (pode ser de outro empreendimento) — use um e-mail diferente."
        };
        return mapa[message] || message || "Não foi possível concluir a operação.";
    }
    async function invokeConvites(body) {
        const {data: data, error: error} = await sb.functions.invoke("convites", {
            body: body
        });
        if (error) {
            let message = error.message;
            if (error.context && typeof error.context.json === "function") {
                try {
                    const payload = await error.context.json();
                    message = payload.message || payload.error || message;
                } catch {}
            }
            throw new Error(message);
        }
        if (data?.error) throw new Error(data.message || data.error);
        return data;
    }
    async function invokeCvcrm(body) {
        const {data: data, error: error} = await sb.functions.invoke("cvcrm-integracao", {
            body: body
        });
        if (error) {
            let message = error.message;
            if (error.context && typeof error.context.json === "function") {
                try {
                    const payload = await error.context.json();
                    message = payload.message || payload.error || message;
                } catch {}
            }
            throw new Error(message);
        }
        if (data?.error) throw new Error(data.message || data.error);
        return data;
    }
    async function empreendimentoIdAtual() {
        if (empreendimentoId) return empreendimentoId;
        throw new Error("Nenhum empreendimento selecionado.");
    }
    async function papelDoUsuario(usuarioId, empId) {
        const {data: data, error: error} = await sb.from("empreendimento_usuarios").select("papel").eq("empreendimento_id", empId).eq("usuario_id", usuarioId).eq("ativo", true).maybeSingle();
        if (error || !data) return null;
        return data.papel;
    }
    async function listarEmpreendimentosDoUsuario() {
        const {data: userData, error: userError} = await sb.auth.getUser();
        if (userError || !userData?.user) throw new Error("Sessão inválida.");
        const uid = userData.user.id;
        pendingUser = {
            id: uid,
            email: userData.user.email,
            display_name: userData.user.user_metadata?.nome_exibicao || userData.user.email
        };
        const {data: data, error: error} = await sb.from("empreendimento_usuarios").select("papel, expira_em, empreendimentos(id, nome, slug, tipo, ativo)").eq("usuario_id", uid).eq("ativo", true);
        if (error) throw error;
        const agora = Date.now();
        return (data || []).filter(v => [ "administrador", "central_vendas" ].includes(v.papel) && v.empreendimentos?.ativo && (!v.expira_em || new Date(v.expira_em).getTime() >= agora)).filter(v => !SLUGS_OCULTOS_NA_BASE.includes(v.empreendimentos.slug)).filter(v => SLUGS_PERMITIDOS.includes(v.empreendimentos.slug)).map(v => ({
            id: v.empreendimentos.id,
            nome: v.empreendimentos.nome,
            slug: v.empreendimentos.slug,
            tipo: v.empreendimentos.tipo,
            papel: v.papel
        }));
    }
    async function listarEmpreendimentosParaGestao() {
        const {data: userData, error: userError} = await sb.auth.getUser();
        if (userError || !userData?.user) throw new Error("Sessão inválida.");
        const uid = userData.user.id;
        const {data: data, error: error} = await sb.from("empreendimento_usuarios").select("papel, expira_em, empreendimentos(id, nome, slug, tipo, ativo)").eq("usuario_id", uid).eq("ativo", true);
        if (error) throw error;
        const agora = Date.now();
        return (data || []).filter(v => [ "administrador", "central_vendas" ].includes(v.papel) && v.empreendimentos?.ativo && (!v.expira_em || new Date(v.expira_em).getTime() >= agora)).filter(v => !SLUGS_OCULTOS_NA_BASE.includes(v.empreendimentos.slug)).filter(v => SLUGS_PERMITIDOS.includes(v.empreendimentos.slug)).map(v => ({
            id: v.empreendimentos.id,
            nome: v.empreendimentos.nome,
            slug: v.empreendimentos.slug
        }));
    }
    function renderEmpreendimentoChecklist(listId, allId, lista, preSelecionados) {
        const marcados = preSelecionados || new Set([ empreendimentoSlugAtual ]);
        const container = $(listId);
        container.innerHTML = lista.map(emp => `<label class="checkbox-row"><input type="checkbox" class="emp-access-checkbox" value="${h(emp.slug)}" ${marcados.has(emp.slug) ? "checked" : ""} /><span>${h(emp.nome)}</span></label>`).join("") || '<div class="empty-state">Nenhum empreendimento disponível.</div>';
        const boxes = () => [ ...container.querySelectorAll(".emp-access-checkbox") ];
        const allBox = $(allId);
        allBox.checked = boxes().length > 0 && boxes().every(b => b.checked);
        allBox.onchange = () => boxes().forEach(b => b.checked = allBox.checked);
        boxes().forEach(b => b.addEventListener("change", () => {
            allBox.checked = boxes().every(x => x.checked);
        }));
    }
    function selectedEmpreendimentoSlugs(listId) {
        return [ ...$(listId).querySelectorAll(".emp-access-checkbox:checked") ].map(b => b.value);
    }
    async function resolverEmpreendimentoEEntrar() {
        const lista = await listarEmpreendimentosDoUsuario();
        if (!lista.length) throw new Error("Este acesso não pertence a este empreendimento.");
        if (lista.length === 1) return entrarNoEmpreendimento(lista[0]);
        let lembrado = null;
        try {
            lembrado = localStorage.getItem(EMP_ESCOLHIDO_KEY);
        } catch {}
        const encontrado = lembrado && lista.find(emp => emp.id === lembrado);
        if (encontrado) return entrarNoEmpreendimento(encontrado);
        mostrarSeletorEmpreendimento(lista);
    }
    function mostrarSeletorEmpreendimento(lista) {
        $("loginView").hidden = true;
        $("appView").hidden = true;
        $("empreendimentoPicker").hidden = false;
        $("empreendimentoPickerList").innerHTML = lista.map(emp => `\n      <button class="empreendimento-option" type="button" data-emp="${h(emp.id)}">\n        <span><strong>${h(emp.nome)}</strong><span class="empreendimento-tag">${emp.tipo === "vertical" ? "Empreendimento vertical" : "Loteamento"}</span></span>\n        <span class="arrow">›</span>\n      </button>`).join("");
        $("empreendimentoPickerList").querySelectorAll("[data-emp]").forEach(button => {
            button.addEventListener("click", () => {
                const emp = lista.find(item => item.id === button.dataset.emp);
                if (emp) entrarNoEmpreendimento(emp);
            });
        });
    }
    async function trocarEmpreendimento() {
        try {
            const lista = await listarEmpreendimentosDoUsuario();
            if (lista.length <= 1) return toast("Você só tem acesso a este empreendimento no momento.");
            mostrarSeletorEmpreendimento(lista);
        } catch (error) {
            toast(traduzErro(error.message));
        }
    }
    async function entrarNoEmpreendimento(emp) {
        fecharMapa3D();
        mapa3dDados = null;
        empreendimentoId = emp.id;
        empreendimentoTipo = emp.tipo;
        empreendimentoNomeAtual = emp.nome;
        empreendimentoSlugAtual = emp.slug;
        currentUser = {
            ...pendingUser,
            papel: emp.papel
        };
        try {
            localStorage.setItem(EMP_ESCOLHIDO_KEY, emp.id);
        } catch {}
        $("empreendimentoPicker").hidden = true;
        await enterApp();
    }
    async function login(event) {
        event.preventDefault();
        try {
            const {error: loginError} = await sb.auth.signInWithPassword({
                email: $("emailInput").value.trim(),
                password: $("passwordInput").value
            });
            if (loginError) throw loginError;
            await resolverEmpreendimentoEEntrar();
        } catch (error) {
            await sb.auth.signOut();
            showMessage($("loginMessage"), traduzErro(error.message));
        }
    }
    async function activateAccount(event) {
        event.preventDefault();
        const email = $("newEmailInput").value.trim();
        const password = $("newPasswordInput").value;
        try {
            await invokeConvites({
                action: "ativar_convite",
                token: $("inviteCodeInput").value.trim(),
                email: email,
                password: password
            });
            const {error: loginError} = await sb.auth.signInWithPassword({
                email: email,
                password: password
            });
            if (loginError) throw loginError;
            await resolverEmpreendimentoEEntrar();
        } catch (error) {
            showMessage($("activationMessage"), traduzErro(error.message));
        }
    }
    async function restoreSession() {
        try {
            const {data: data} = await sb.auth.getSession();
            if (!data?.session) return logout();
            await resolverEmpreendimentoEEntrar();
        } catch {
            logout();
        }
    }
    async function enterApp() {
        $("loginView").hidden = true;
        $("appView").hidden = false;
        $("currentUserName").textContent = currentUser.display_name;
        $("currentUserRole").textContent = ROLE[currentUser.papel];
        $("passwordWarning").hidden = true;
        document.querySelectorAll(".admin-or-central").forEach(element => element.hidden = ![ "administrador", "central_vendas" ].includes(currentUser.papel));
        document.querySelectorAll(".admin-only").forEach(element => element.hidden = currentUser.papel !== "administrador");
        const podeGerenciar = [ "administrador", "central_vendas" ].includes(currentUser.papel);
        const vertical = empreendimentoTipo === "vertical";
        document.querySelector('[data-page="lots"]').hidden = vertical;
        document.querySelector('[data-page="units"]').hidden = !vertical;
        $("settingsEmpreendimentoNome").textContent = empreendimentoNomeAtual;
        $("settingsEmpreendimentoTipo").textContent = vertical ? "Empreendimento vertical" : "Loteamento";
        const estoqueTasks = vertical ? [ loadUnidades() ] : [ loadLots() ];
        await Promise.all([ ...estoqueTasks, loadRequests(), loadAudit(), podeGerenciar ? loadUsers() : Promise.resolve(), podeGerenciar ? loadPlanInfo() : Promise.resolve() ]);
        connectRealtime();
        iniciarSimulador(podeGerenciar);
        showPage("dashboard");
        if (vertical) {
            $("mapa3dButton").hidden = true;
        } else {
            sb.from("mapas_3d").select("id").eq("empreendimento_id", empreendimentoId).eq("ativo", true).maybeSingle().then(({data: mapa3d}) => {
                $("mapa3dButton").hidden = !mapa3d;
            });
        }
    }
    function iniciarSimulador(podeGerenciar) {
        if (!window.SKLSimulador) return;
        window.SKLSimulador.init({ sb, empreendimentoId, papel: "central", toast }).catch(() => {});
        if (!podeGerenciar || !window.SKLSimuladorAdmin) return;
        window.SKLSimuladorAdmin.montar($("simuladorAdminPanel"), { sb, getEmpreendimentoId: async () => empreendimentoId, getPapel: () => currentUser.papel, toast, modeloUrl: "modelo-simulacao-financiamento.xlsx" }).catch(() => {});
    }
    let mapa3dInstance = null;
    let mapa3dDados = null;
    async function carregarMapa3D() {
        const {data: mapa, error: mapaError} = await sb.from("mapas_3d").select("id, imagem_url, largura_px, altura_px, pontos").eq("empreendimento_id", empreendimentoId).eq("ativo", true).maybeSingle();
        if (mapaError || !mapa) return null;
        const {data: lotesRows} = await sb.from("lotes").select("id, chave, status").eq("empreendimento_id", empreendimentoId);
        const chavePorId = new Map;
        const statusPorId = new Map;
        (lotesRows || []).forEach(l => {
            chavePorId.set(l.id, l.chave);
            statusPorId.set(l.id, l.status);
        });
        return {
            ...mapa,
            chavePorId: chavePorId,
            statusPorId: statusPorId
        };
    }
    async function abrirMapa3D() {
        $("mapa3dOverlay").hidden = false;
        $("mapa3dLoading").hidden = false;
        if (!mapa3dDados) mapa3dDados = await carregarMapa3D();
        if (!mapa3dDados) {
            $("mapa3dOverlay").hidden = true;
            toast("Mapa interativo não disponível para este empreendimento.");
            return;
        }
        mapa3dInstance = window.SKLMapaImagem.init($("mapa3dContainer"), {
            imagemUrl: mapa3dDados.imagem_url,
            larguraPx: mapa3dDados.largura_px,
            alturaPx: mapa3dDados.altura_px,
            pontos: mapa3dDados.pontos,
            statusPorId: mapa3dDados.statusPorId,
            onSelecionar(loteId) {
                const chave = mapa3dDados.chavePorId.get(loteId);
                if (!chave) return;
                fecharMapa3D();
                openLot(chave);
            },
            onAbrirInformativo(ponto) {
                mostrarPontoInformativo(ponto);
            }
        });
        $("editarMapaButton").hidden = !podeEditarMapa();
        $("mapa3dLoading").hidden = true;
    }
    function mostrarPontoInformativo(ponto) {
        const dialog = $("pontoInfoDialog");
        if (!dialog) return;
        $("pontoInfoTitulo").textContent = ponto.titulo || "Ponto de interesse";
        const img = $("pontoInfoImagem");
        if (ponto.imagem_url) {
            img.src = ponto.imagem_url;
            img.hidden = false;
        } else {
            img.hidden = true;
        }
        dialog.showModal();
    }
    function fecharMapa3D() {
        if (modoEdicaoMapa && editorSujo && !confirm("Existem alterações não salvas no mapa. Fechar mesmo assim?")) return;
        $("mapa3dOverlay").hidden = true;
        if (mapa3dInstance) {
            mapa3dInstance.destruir();
            mapa3dInstance = null;
        }
        modoEdicaoMapa = false;
        $("editorMapaPainel").hidden = true;
        $("mapa3dLegend").hidden = false;
    }

    // --- Editor do mapa interativo (só Central Windows / Electron, só administrador) ---
    // "a central não define onde clicar eu que faço" — pedido explicito do
    // Yuri pra poder posicionar/editar os pontos do mapa artistico direto
    // pelo programa, sem depender de mim rodar SQL a cada ajuste. Não
    // aparece no app Android nem no link web (gate por navigator.userAgent).
    const isElectronApp = /Electron\//.test(navigator.userAgent);
    let modoEdicaoMapa = false;
    let editorPontos = [];
    let editorSelecionado = null;
    let editorSujo = false;
    function podeEditarMapa() {
        return isElectronApp && currentUser && currentUser.papel === "administrador";
    }
    function entrarModoEdicaoMapa() {
        if (!mapa3dDados) return;
        modoEdicaoMapa = true;
        editorPontos = (mapa3dDados.pontos || []).map(p => ({...p}));
        editorSelecionado = null;
        editorSujo = false;
        $("mapa3dHeadingText").textContent = "Clique pra criar · arraste pra mover · clique num ponto pra editar";
        $("mapa3dEyebrow").textContent = "EDITANDO O MAPA";
        $("mapa3dLegend").hidden = true;
        $("editarMapaButton").hidden = true;
        $("editorMapaPainel").hidden = false;
        $("editorMapaForm").hidden = true;
        $("editorMapaVazio").hidden = false;
        atualizarBotaoSalvarMapa();
        if (mapa3dInstance) mapa3dInstance.destruir();
        mapa3dInstance = window.SKLMapaImagem.init($("mapa3dContainer"), {
            imagemUrl: mapa3dDados.imagem_url,
            larguraPx: mapa3dDados.largura_px,
            alturaPx: mapa3dDados.altura_px,
            pontos: editorPontos,
            statusPorId: mapa3dDados.statusPorId,
            editavel: true,
            onEditarPonto(ponto) {
                editorSelecionarPonto(ponto);
            },
            onMoverPonto(ponto, x, y) {
                ponto.x = x;
                ponto.y = y;
                editorMarcarSujo();
                if (editorSelecionado === ponto) editorAtualizarCoords(ponto);
            },
            onCriarPonto(x, y) {
                const novo = {
                    tipo: "lote",
                    lote_id: null,
                    x: x,
                    y: y
                };
                editorPontos.push(novo);
                mapa3dInstance.adicionarMarcador(novo);
                editorMarcarSujo();
                editorSelecionarPonto(novo);
            }
        });
    }
    function montarSelectLotesEditor() {
        const usados = new Set(editorPontos.filter(p => p.tipo !== "informativo" && p.lote_id).map(p => p.lote_id));
        const linhas = [...lots.values()].sort((a, b) => Number(a.quadra) - Number(b.quadra) || Number(a.lote) - Number(b.lote));
        $("editorLoteSelect").innerHTML = linhas.map(l => {
            const jaTemPonto = usados.has(l.id) && (!editorSelecionado || editorSelecionado.lote_id !== l.id);
            return `<option value="${l.id}">Quadra ${l.quadra} · Lote ${l.lote}${jaTemPonto ? " (já tem ponto)" : ""}</option>`;
        }).join("");
    }
    function editorSelecionarPonto(ponto) {
        editorSelecionado = ponto;
        $("editorMapaVazio").hidden = true;
        $("editorMapaForm").hidden = false;
        $("editorMapaMsg").textContent = "";
        editorSetTipoUI(ponto.tipo === "informativo" ? "informativo" : "lote");
        montarSelectLotesEditor();
        if (ponto.tipo !== "informativo" && ponto.lote_id) $("editorLoteSelect").value = ponto.lote_id;
        $("editorInfoTituloInput").value = ponto.titulo || "";
        if (ponto.imagem_url) {
            $("editorInfoFoto").src = ponto.imagem_url;
            $("editorInfoFoto").hidden = false;
        } else {
            $("editorInfoFoto").hidden = true;
        }
        editorAtualizarCoords(ponto);
        mapa3dInstance.destacarMarcador(ponto);
    }
    function editorAtualizarCoords(ponto) {
        $("editorMapaCoords").textContent = `x: ${ponto.x}, y: ${ponto.y}`;
    }
    function editorSetTipoUI(tipo) {
        $("editorTipoLoteButton").classList.toggle("ativo", tipo === "lote");
        $("editorTipoInfoButton").classList.toggle("ativo", tipo === "informativo");
        $("editorCampoLote").style.display = tipo === "lote" ? "block" : "none";
        $("editorCampoInfo").style.display = tipo === "informativo" ? "block" : "none";
    }
    function editorMarcarSujo() {
        editorSujo = true;
        atualizarBotaoSalvarMapa();
    }
    function atualizarBotaoSalvarMapa() {
        $("editorSalvarButton").disabled = !editorSujo;
        $("editorSalvarStatus").textContent = editorSujo ? "Alterações não salvas" : "Sem alterações";
        $("editorSalvarStatus").className = "editor-mapa-status" + (editorSujo ? " dirty" : "");
    }
    async function editorSalvarTudo() {
        $("editorSalvarButton").disabled = true;
        $("editorSalvarStatus").textContent = "Salvando...";
        $("editorSalvarStatus").className = "editor-mapa-status";
        const payload = editorPontos.map(p => {
            if (p.tipo === "informativo") {
                return {
                    tipo: "informativo",
                    id: p.id || ("info-" + Date.now() + "-" + Math.random().toString(36).slice(2)),
                    titulo: p.titulo || "Ponto de interesse",
                    imagem_url: p.imagem_url || null,
                    x: p.x,
                    y: p.y
                };
            }
            return {
                tipo: "lote",
                lote_id: p.lote_id,
                x: p.x,
                y: p.y
            };
        }).filter(p => p.tipo === "informativo" || p.lote_id);
        const {error: error} = await sb.from("mapas_3d").update({pontos: payload}).eq("id", mapa3dDados.id);
        if (error) {
            editorSujo = true;
            atualizarBotaoSalvarMapa();
            $("editorSalvarStatus").textContent = "Erro ao salvar";
            $("editorSalvarStatus").className = "editor-mapa-status dirty";
            toast("Erro ao salvar o mapa: " + error.message);
            return;
        }
        mapa3dDados.pontos = payload;
        editorSujo = false;
        atualizarBotaoSalvarMapa();
        $("editorSalvarStatus").textContent = "Tudo salvo";
        $("editorSalvarStatus").className = "editor-mapa-status saved";
    }
    function sairModoEdicaoMapa() {
        if (editorSujo && !confirm("Existem alterações não salvas. Sair mesmo assim?")) return;
        modoEdicaoMapa = false;
        editorSelecionado = null;
        $("editorMapaPainel").hidden = true;
        $("mapa3dLegend").hidden = false;
        $("editarMapaButton").hidden = !podeEditarMapa();
        $("mapa3dHeadingText").textContent = "Toque em um lote para ver detalhes";
        $("mapa3dEyebrow").textContent = "MAPA INTERATIVO";
        if (mapa3dInstance) mapa3dInstance.destruir();
        mapa3dInstance = window.SKLMapaImagem.init($("mapa3dContainer"), {
            imagemUrl: mapa3dDados.imagem_url,
            larguraPx: mapa3dDados.largura_px,
            alturaPx: mapa3dDados.altura_px,
            pontos: mapa3dDados.pontos,
            statusPorId: mapa3dDados.statusPorId,
            onSelecionar(loteId) {
                const chave = mapa3dDados.chavePorId.get(loteId);
                if (!chave) return;
                fecharMapa3D();
                openLot(chave);
            },
            onAbrirInformativo(ponto) {
                mostrarPontoInformativo(ponto);
            }
        });
    }
    $("editarMapaButton").addEventListener("click", entrarModoEdicaoMapa);
    $("editorMapaSairButton").addEventListener("click", sairModoEdicaoMapa);
    $("editorTipoLoteButton").addEventListener("click", () => {
        if (!editorSelecionado) return;
        editorSelecionado.tipo = "lote";
        editorSetTipoUI("lote");
        mapa3dInstance.redesenharMarcador(editorSelecionado);
        editorMarcarSujo();
    });
    $("editorTipoInfoButton").addEventListener("click", () => {
        if (!editorSelecionado) return;
        editorSelecionado.tipo = "informativo";
        editorSetTipoUI("informativo");
        mapa3dInstance.redesenharMarcador(editorSelecionado);
        editorMarcarSujo();
    });
    $("editorLoteSelect").addEventListener("change", () => {
        if (!editorSelecionado) return;
        editorSelecionado.lote_id = $("editorLoteSelect").value;
        mapa3dInstance.redesenharMarcador(editorSelecionado);
        montarSelectLotesEditor();
        $("editorLoteSelect").value = editorSelecionado.lote_id;
        editorMarcarSujo();
    });
    $("editorInfoTituloInput").addEventListener("input", () => {
        if (!editorSelecionado) return;
        editorSelecionado.titulo = $("editorInfoTituloInput").value;
        editorMarcarSujo();
    });
    $("editorInfoFotoInput").addEventListener("change", async () => {
        if (!editorSelecionado) return;
        const arquivo = $("editorInfoFotoInput").files[0];
        if (!arquivo) return;
        $("editorMapaMsg").textContent = "Enviando foto...";
        const caminho = `acquaville/pontos/${Date.now()}_${arquivo.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const {error: uploadError} = await sb.storage.from("mapas3d").upload(caminho, arquivo, {upsert: true});
        if (uploadError) {
            $("editorMapaMsg").textContent = "Falha ao enviar: " + uploadError.message;
            return;
        }
        const {data: urlData} = sb.storage.from("mapas3d").getPublicUrl(caminho);
        editorSelecionado.imagem_url = urlData.publicUrl;
        $("editorInfoFoto").src = editorSelecionado.imagem_url;
        $("editorInfoFoto").hidden = false;
        $("editorMapaMsg").textContent = "Foto enviada.";
        editorMarcarSujo();
    });
    $("editorExcluirButton").addEventListener("click", () => {
        if (!editorSelecionado) return;
        if (!confirm("Excluir este ponto do mapa?")) return;
        mapa3dInstance.removerMarcador(editorSelecionado);
        editorPontos = editorPontos.filter(p => p !== editorSelecionado);
        editorSelecionado = null;
        $("editorMapaForm").hidden = true;
        $("editorMapaVazio").hidden = false;
        editorMarcarSujo();
    });
    $("editorSalvarButton").addEventListener("click", editorSalvarTudo);
    function logout() {
        sb.auth.signOut();
        currentUser = null;
        empreendimentoId = null;
        empreendimentoTipo = "loteamento";
        empreendimentoNomeAtual = "";
        if (realtimeChannel) {
            sb.removeChannel(realtimeChannel);
            realtimeChannel = null;
        }
        $("appView").hidden = true;
        $("empreendimentoPicker").hidden = true;
        $("loginView").hidden = false;
        showAuthForm(false);
    }
    function showAuthForm(activation) {
        $("loginForm").hidden = activation;
        $("activationForm").hidden = !activation;
    }
    function showPage(name) {
        document.querySelectorAll(".page").forEach(page => page.classList.remove("active-page"));
        document.querySelectorAll(".nav-button").forEach(button => button.classList.toggle("active", button.dataset.page === name));
        const page = $(`page-${name}`);
        if (page) page.classList.add("active-page");
        const titles = {
            dashboard: "Visão geral",
            lots: "Controle de lotes",
            units: "Controle de unidades",
            requests: "Solicitações dos corretores",
            users: "Usuários e acessos",
            plan: "Meu plano",
            payment: "Formas de pagamento",
            banking: "Dados bancários",
            commissions: "Comissões",
            audit: "Histórico de alterações",
            reports: "Relatórios",
            settings: "Configurações"
        };
        $("pageTitle").textContent = titles[name] || "Acquaville Central";
        if (name === "lots") {
            renderLots();
            setTimeout(() => map && map.invalidateSize(), 80);
        }
        if (name === "units") renderUnitsTable();
        if (name === "requests") renderRequests();
        if (name === "reports") renderReports();
        if (name === "plan") loadPlanInfo();
        if (name === "payment") loadPaymentPlans();
        if (name === "banking") loadBanking();
        if (name === "commissions") loadCommissions();
        if (name === "settings" && currentUser.papel === "administrador") {
            loadCvcrmConfig();
            loadContractTemplate();
        }
    }
    let cvcrmConfig = null;
    function renderCvcrmStatus() {
        if (!cvcrmConfig) {
            $("cvcrmStatusRow").hidden = true;
            return;
        }
        $("cvcrmStatusRow").hidden = false;
        $("cvcrmStatusBadge").className = `cvcrm-status-badge cvcrm-status-${cvcrmConfig.ultimo_status}`;
        $("cvcrmStatusBadge").textContent = {
            ok: "Conectado",
            erro: "Erro",
            nunca_sincronizado: "Nunca sincronizado"
        }[cvcrmConfig.ultimo_status] || cvcrmConfig.ultimo_status;
        const partes = [];
        if (cvcrmConfig.ultima_sincronizacao_em) partes.push(`Última tentativa: ${formatDate(cvcrmConfig.ultima_sincronizacao_em)}`);
        if (cvcrmConfig.total_unidades_cv != null) partes.push(`${cvcrmConfig.total_unidades_cv} unidades no CV`);
        if (cvcrmConfig.total_unidades_casadas != null) partes.push(`${cvcrmConfig.total_unidades_casadas} casadas com lotes locais`);
        if (cvcrmConfig.ultimo_erro) partes.push(`Erro: ${cvcrmConfig.ultimo_erro}`);
        $("cvcrmStatusDetail").textContent = partes.join(" · ") || "—";
    }
    async function loadCvcrmConfig() {
        const empId = await empreendimentoIdAtual();
        const {data: data, error: error} = await sb.from("integracoes_cvcrm").select("*").eq("empreendimento_id", empId).maybeSingle();
        if (error) {
            toast(traduzErro(error.message));
            return;
        }
        cvcrmConfig = data;
        $("cvcrmDominioInput").value = data?.dominio || "";
        $("cvcrmEmailInput").value = data?.email_autenticacao || "";
        $("cvcrmIdEmpreendimentoInput").value = data?.cv_idempreendimento ?? "";
        renderCvcrmStatus();
    }
    async function salvarCvcrmConfig() {
        try {
            const empId = await empreendimentoIdAtual();
            const {data: data, error: error} = await sb.rpc("configurar_integracao_cvcrm", {
                p_empreendimento_id: empId,
                p_dominio: $("cvcrmDominioInput").value.trim(),
                p_email_autenticacao: $("cvcrmEmailInput").value.trim(),
                p_cv_idempreendimento: Number($("cvcrmIdEmpreendimentoInput").value) || 0,
                p_ativo: true
            });
            if (error) throw error;
            cvcrmConfig = data;
            renderCvcrmStatus();
            showMessage($("cvcrmMessage"), "Configuração salva. Peça pra equipe SKL confirmar o secret CVCRM_TOKEN antes de testar.", true);
        } catch (error) {
            showMessage($("cvcrmMessage"), traduzErro(error.message));
        }
    }
    async function testarCvcrmConexao() {
        $("cvcrmTestarButton").disabled = true;
        try {
            const empId = await empreendimentoIdAtual();
            const resultado = await invokeCvcrm({
                action: "testar_conexao",
                empreendimento_id: empId
            });
            await loadCvcrmConfig();
            if (resultado.ok) showMessage($("cvcrmMessage"), `Conexão OK — ${resultado.total_unidades_cv ?? "?"} unidades encontradas no CV CRM.`, true); else showMessage($("cvcrmMessage"), resultado.motivo || "Falha ao testar a conexão.");
        } catch (error) {
            showMessage($("cvcrmMessage"), traduzErro(error.message));
        } finally {
            $("cvcrmTestarButton").disabled = false;
        }
    }
    async function sincronizarCvcrmDisponibilidade() {
        $("cvcrmSincronizarButton").disabled = true;
        try {
            const empId = await empreendimentoIdAtual();
            const resultado = await invokeCvcrm({
                action: "sincronizar_disponibilidade",
                empreendimento_id: empId
            });
            await loadCvcrmConfig();
            if (resultado.ok) {
                showMessage($("cvcrmMessage"), `Sincronizado: ${resultado.casados} unidades casadas de ${resultado.total_unidades_cv} no CV (${resultado.sem_correspondencia} sem lote local correspondente, ${resultado.ambiguos} ambíguas).`, true);
                if (empreendimentoTipo !== "vertical") await loadLots();
            } else {
                showMessage($("cvcrmMessage"), resultado.motivo || resultado.aviso || "Falha ao sincronizar.");
            }
        } catch (error) {
            showMessage($("cvcrmMessage"), traduzErro(error.message));
        } finally {
            $("cvcrmSincronizarButton").disabled = false;
        }
    }
    async function sincronizarCvcrmPrecos() {
        $("cvcrmSincronizarPrecosButton").disabled = true;
        try {
            const empId = await empreendimentoIdAtual();
            const resultado = await invokeCvcrm({
                action: "sincronizar_precos",
                empreendimento_id: empId,
                limite: 25
            });
            if (resultado.ok) {
                showMessage($("cvcrmMessage"), resultado.restantes > 0 ? `${resultado.processados} preços atualizados. Ainda faltam ${resultado.restantes} — clique novamente para continuar.` : `${resultado.processados} preços atualizados. Tudo sincronizado.`, true);
            } else {
                showMessage($("cvcrmMessage"), resultado.message || "Falha ao sincronizar preços.");
            }
        } catch (error) {
            showMessage($("cvcrmMessage"), traduzErro(error.message));
        } finally {
            $("cvcrmSincronizarPrecosButton").disabled = false;
        }
    }
    function setConnection(online) {
        $("connectionBadge").className = `connection-badge ${online ? "online" : "offline"}`;
        $("connectionBadge").textContent = online ? "Sincronizado" : "Desconectado";
        if (online) $("syncTime").textContent = `Atualizado ${(new Date).toLocaleTimeString("pt-BR")}`;
    }
    async function loadLots() {
        const empId = await empreendimentoIdAtual();
        const {data: data, error: error} = await sb.from("lotes").select("id, chave, quadra, lote, area_m2, status, valor, cliente, observacao, version, updated_at, updated_by_perfil:perfis!lotes_updated_by_fkey(nome_exibicao)").eq("empreendimento_id", empId);
        if (error) {
            setConnection(false);
            toast(error.message);
            return;
        }
        lots = new Map(data.map(lote => [ lote.chave, {
            ...lote,
            key: lote.chave,
            updated_by_name: lote.updated_by_perfil?.nome_exibicao || "Sistema"
        } ]));
        setConnection(true);
        updateMetrics();
        renderLots();
        await ensureMap();
    }
    function updateMetrics() {
        const counts = {
            disponivel: 0,
            reservado: 0,
            vendido: 0,
            bloqueado: 0,
            nao_informado: 0
        };
        lots.forEach(lot => counts[lot.status] = (counts[lot.status] || 0) + 1);
        $("metricAvailable").textContent = counts.disponivel;
        $("metricReserved").textContent = counts.reservado;
        $("metricSold").textContent = counts.vendido;
        $("metricBlocked").textContent = counts.bloqueado;
        $("metricUnknown").textContent = counts.nao_informado;
    }
    function filteredLots() {
        const term = $("lotSearchInput").value.trim().toLowerCase();
        const status = $("lotStatusFilter").value;
        return [ ...lots.values() ].filter(lot => (!status || lot.status === status) && (!term || `q${lot.quadra} l${lot.lote} quadra ${lot.quadra} lote ${lot.lote} ${lot.cliente}`.toLowerCase().includes(term))).sort((a, b) => Number(a.quadra) - Number(b.quadra) || Number(a.lote) - Number(b.lote));
    }
    function renderLots() {
        const rows = filteredLots();
        $("lotTableBody").innerHTML = rows.map(lot => `<tr><td><input type="checkbox" class="lot-select-checkbox" data-lot-select="${h(lot.key)}" ${selectedLotKeys.has(lot.key) ? "checked" : ""}></td><td>${h(lot.quadra)}</td><td><strong>${h(lot.lote)}</strong></td><td>${h(formatArea(lot.area_m2))}</td><td>${statusPill(lot.status)}</td><td>${h(lot.valor || "—")}</td><td>${h(lot.cliente || "—")}</td><td><small>${h(formatDate(lot.updated_at))}<br>${h(lot.updated_by_name || "")}</small></td><td><button class="row-button" data-lot="${h(lot.key)}">Editar</button></td></tr>`).join("");
        $("lotTableEmpty").hidden = rows.length > 0;
        $("lotTableBody").querySelectorAll("[data-lot]").forEach(button => button.addEventListener("click", () => openLot(button.dataset.lot)));
        $("lotTableBody").querySelectorAll("[data-lot-select]").forEach(checkbox => checkbox.addEventListener("change", () => toggleLotSelection(checkbox.dataset.lotSelect, checkbox.checked)));
        $("selectAllLotsCheckbox").checked = rows.length > 0 && rows.every(lot => selectedLotKeys.has(lot.key));
        updateMapStyles();
    }
    function toggleLotSelection(key, checked) {
        if (checked) selectedLotKeys.add(key); else selectedLotKeys.delete(key);
        updateBulkToolbar();
    }
    function toggleSelectAllLots() {
        const rows = filteredLots();
        const allSelected = rows.length > 0 && rows.every(lot => selectedLotKeys.has(lot.key));
        rows.forEach(lot => {
            if (allSelected) selectedLotKeys.delete(lot.key); else selectedLotKeys.add(lot.key);
        });
        renderLots();
    }
    function clearLotSelection() {
        selectedLotKeys.clear();
        renderLots();
    }
    function updateBulkToolbar() {
        const count = selectedLotKeys.size;
        $("bulkLotToolbar").hidden = count === 0;
        $("bulkSelectedCount").textContent = count === 1 ? "1 lote selecionado" : `${count} lotes selecionados`;
    }
    async function applyBulkStatus() {
        const keys = [ ...selectedLotKeys ];
        if (!keys.length) return;
        const novoStatus = $("bulkStatusSelect").value;
        if (!confirm(`Alterar a situação de ${keys.length} lote(s) para "${STATUS[novoStatus]}"? Isso não muda valor/cliente/observação de nenhum deles.`)) return;
        let ok = 0;
        let falhas = 0;
        for (const key of keys) {
            const lot = lots.get(key);
            if (!lot) {
                falhas++;
                continue;
            }
            try {
                const {data: lote, error: error} = await sb.rpc("atualizar_lote", {
                    p_lote_id: lot.id,
                    p_expected_version: lot.version,
                    p_status: novoStatus,
                    p_origem: "central_windows_bulk"
                });
                if (error) throw error;
                lots.set(lote.chave, {
                    ...lote,
                    key: lote.chave,
                    updated_by_name: currentUser.display_name
                });
                ok++;
            } catch {
                falhas++;
            }
        }
        selectedLotKeys.clear();
        updateMetrics();
        renderLots();
        updateBulkToolbar();
        toast(falhas === 0 ? `${ok} lote(s) atualizado(s).` : `${ok} atualizado(s), ${falhas} falharam (provavelmente alterados por outro usuário nesse meio-tempo — recarregue e tente de novo).`);
    }
    async function ensureMap() {
        if (!window.L || map) return;
        geojson = window.SKL_LOTES_GEOJSON;
        if (!geojson) return;
        map = L.map("lotMap", {
            zoomControl: true,
            preferCanvas: true
        });
        satelliteLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
            maxZoom: 21,
            maxNativeZoom: 19,
            attribution: "Imagem © Esri"
        });
        streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 21,
            maxNativeZoom: 19,
            attribution: "© OpenStreetMap"
        });
        satelliteLayer.addTo(map);
        const layer = L.geoJSON(geojson, {
            style: featureStyle,
            onEachFeature(feature, polygon) {
                const key = `Q${feature.properties.quadra}-L${feature.properties.lote}`;
                lotLayers.set(key, polygon);
                polygon.on("click", () => openLot(key));
            }
        }).addTo(map);
        map.fitBounds(layer.getBounds(), {
            padding: [ 20, 20 ]
        });
        updateMapStyles();
        $("toggleBasemapButton").hidden = false;
    }
    function toggleBasemap() {
        if (!map) return;
        if (activeBasemap === "satellite") {
            map.removeLayer(satelliteLayer);
            streetLayer.addTo(map);
            activeBasemap = "street";
            $("toggleBasemapButton").textContent = "Imagem de satélite";
        } else {
            map.removeLayer(streetLayer);
            satelliteLayer.addTo(map);
            activeBasemap = "satellite";
            $("toggleBasemapButton").textContent = "Mapa de ruas";
        }
    }
    function featureStyle(feature) {
        const lot = lots.get(`Q${feature.properties.quadra}-L${feature.properties.lote}`);
        const colors = {
            disponivel: "#2f8a56",
            reservado: "#d59a22",
            vendido: "#bd5147",
            bloqueado: "#477fa4",
            nao_informado: "#708189"
        };
        return {
            color: colors[lot?.status || "nao_informado"],
            weight: 2,
            fillColor: colors[lot?.status || "nao_informado"],
            fillOpacity: .34
        };
    }
    function updateMapStyles() {
        if (!geojson) return;
        lotLayers.forEach((layer, key) => {
            const lot = lots.get(key);
            const colors = {
                disponivel: "#2f8a56",
                reservado: "#d59a22",
                vendido: "#bd5147",
                bloqueado: "#477fa4",
                nao_informado: "#708189"
            };
            const color = colors[lot?.status || "nao_informado"];
            layer.setStyle({
                color: color,
                fillColor: color
            });
            layer.bindTooltip(`${key.replace("Q", "Quadra ").replace("-L", " · Lote ")}<br><strong>${STATUS[lot?.status] || "Não informado"}</strong>`);
        });
    }
    function openLot(key) {
        const lot = lots.get(key);
        if (!lot) return;
        selectedLot = {
            ...lot
        };
        $("lotDialogTitle").textContent = `Quadra ${lot.quadra} · Lote ${lot.lote}`;
        $("lotDialogMeta").innerHTML = `<span>${h(formatArea(lot.area_m2))}</span><span>Versão ${lot.version}</span>`;
        $("editLotStatus").value = lot.status;
        $("editLotValue").value = lot.valor;
        $("editLotCustomer").value = lot.cliente;
        $("editLotNote").value = lot.observacao;
        $("lotDialogMessage").hidden = true;
        $("lotDialog").showModal();
    }
    async function saveLot() {
        if (!selectedLot) return;
        try {
            const {data: loteRow, error: loteError} = await sb.from("lotes").select("id").eq("empreendimento_id", await empreendimentoIdAtual()).eq("chave", selectedLot.key).single();
            if (loteError || !loteRow) throw new Error("Lote não encontrado.");
            const {data: lote, error: error} = await sb.rpc("atualizar_lote", {
                p_lote_id: loteRow.id,
                p_expected_version: selectedLot.version,
                p_status: $("editLotStatus").value,
                p_valor: $("editLotValue").value,
                p_observacao: $("editLotNote").value,
                p_cliente: $("editLotCustomer").value,
                p_origem: "central_windows"
            });
            if (error) throw error;
            lots.set(lote.chave, {
                ...lote,
                key: lote.chave,
                updated_by_name: currentUser.display_name
            });
            updateMetrics();
            renderLots();
            $("lotDialog").close();
            toast("Lote atualizado para todos os usuários.");
        } catch (error) {
            if (error.message?.includes("VERSION_CONFLICT")) await loadLots();
            showMessage($("lotDialogMessage"), traduzErro(error.message));
        }
    }
    async function loadUnidades() {
        const empId = await empreendimentoIdAtual();
        const [{data: torresData}, {data: tiposData}, {data: acabData}, {data: unidadesData, error: error}] = await Promise.all([ sb.from("torres").select("id, nome, ordem").eq("empreendimento_id", empId).order("ordem"), sb.from("tipos_planta").select("*").eq("empreendimento_id", empId), sb.from("acabamentos").select("*").eq("empreendimento_id", empId), sb.from("unidades").select("*, updated_by_perfil:perfis!unidades_updated_by_fkey(nome_exibicao)").eq("empreendimento_id", empId) ]);
        if (error) {
            setConnection(false);
            toast(error.message);
            return;
        }
        torres = torresData || [];
        tiposPorId = new Map((tiposData || []).map(t => [ t.id, t ]));
        acabamentosPorId = new Map((acabData || []).map(a => [ a.id, a ]));
        unidades = new Map((unidadesData || []).map(u => [ u.id, {
            ...u,
            updated_by_name: u.updated_by_perfil?.nome_exibicao || "Sistema"
        } ]));
        setConnection(true);
        $("unitHeroNome").textContent = empreendimentoNomeAtual;
        $("unitTorreFilter").innerHTML = '<option value="">Todas as torres</option>' + torres.map(t => `<option value="${h(t.id)}">${h(t.nome)}</option>`).join("");
        const andares = [ ...new Set([ ...unidades.values() ].map(u => u.andar)) ].sort((a, b) => a - b);
        $("unitFloorFilter").innerHTML = '<option value="">Todos os andares</option>' + andares.map(a => `<option value="${a}">${a}º andar</option>`).join("");
        updateUnitMetrics();
        renderUnitsTable();
        if (selectedUnit && unidades.has(selectedUnit.id)) selectUnitForPreview(selectedUnit.id); else clearUnitDetail();
    }
    function updateUnitMetrics() {
        const counts = {
            disponivel: 0,
            reservado: 0,
            vendido: 0,
            bloqueado: 0,
            nao_informado: 0
        };
        unidades.forEach(u => counts[u.status] = (counts[u.status] || 0) + 1);
        if ($("metricAvailable")) {
            $("metricAvailable").textContent = counts.disponivel;
            $("metricReserved").textContent = counts.reservado;
            $("metricSold").textContent = counts.vendido;
            $("metricBlocked").textContent = counts.bloqueado;
            $("metricUnknown").textContent = counts.nao_informado;
        }
        const total = unidades.size || 1;
        const pct = n => `${Math.round(n / total * 100)}% do total`;
        $("unitMetricAvailable").textContent = counts.disponivel;
        $("unitMetricAvailablePct").textContent = pct(counts.disponivel);
        $("unitMetricReserved").textContent = counts.reservado;
        $("unitMetricReservedPct").textContent = pct(counts.reservado);
        $("unitMetricSold").textContent = counts.vendido;
        $("unitMetricSoldPct").textContent = pct(counts.vendido);
        $("unitMetricBlocked").textContent = counts.bloqueado;
        $("unitMetricBlockedPct").textContent = pct(counts.bloqueado);
    }
    function filteredUnits() {
        const term = $("unitSearchInput").value.trim().toLowerCase();
        const status = $("unitStatusFilter").value;
        const torreId = $("unitTorreFilter").value;
        const andar = $("unitFloorFilter").value;
        return [ ...unidades.values() ].filter(u => (!status || u.status === status) && (!torreId || u.torre_id === torreId) && (!andar || String(u.andar) === andar) && (!term || `${u.numero} andar ${u.andar} ${u.cliente || ""}`.toLowerCase().includes(term))).sort((a, b) => b.andar - a.andar || String(a.numero).localeCompare(String(b.numero)));
    }
    function torreNome(torreId) {
        return torres.find(t => t.id === torreId)?.nome || "—";
    }
    function renderUnitsTable() {
        const rows = filteredUnits();
        $("unitTableBody").innerHTML = rows.map(u => {
            const tipo = tiposPorId.get(u.tipo_planta_id);
            const selected = selectedUnit?.id === u.id ? " unit-row-selected" : "";
            return `<tr class="${selected}" data-unit="${h(u.id)}"><td><strong>${h(u.numero)}</strong></td><td>${h(torreNome(u.torre_id))}</td><td>${h(u.andar)}º</td><td>${h(tipo?.nome || "—")}</td><td>${h(formatArea(u.area_privativa_m2))}</td><td>${statusPill(u.status)}</td><td>${u.valor != null ? h(Number(u.valor).toLocaleString("pt-BR", {
                style: "currency",
                currency: "BRL",
                minimumFractionDigits: 0
            })) : "—"}</td><td>${h(u.cliente || "—")}</td><td><small>${h(formatDate(u.updated_at))}<br>${h(u.updated_by_name || "")}</small></td></tr>`;
        }).join("");
        $("unitTableEmpty").hidden = rows.length > 0;
        $("unitTableBody").querySelectorAll("[data-unit]").forEach(row => row.addEventListener("click", () => selectUnitForPreview(row.dataset.unit)));
    }
    function clearUnitDetail() {
        selectedUnit = null;
        $("unitDetailEmpty").hidden = false;
        $("unitDetailContent").hidden = true;
    }
    function selectUnitForPreview(unitId) {
        const u = unidades.get(unitId);
        if (!u) return;
        selectedUnit = {
            ...u
        };
        renderUnitsTable();
        const tipo = tiposPorId.get(u.tipo_planta_id);
        $("unitDetailEmpty").hidden = true;
        $("unitDetailContent").hidden = false;
        $("unitDetailTitle").textContent = `Apto ${u.numero}`;
        $("unitDetailMeta").textContent = `${torreNome(u.torre_id)} · ${u.andar}º andar${tipo ? ` · ${tipo.nome}` : ""}`;
        $("unitDetailStatus").className = `status-pill ${u.status}`;
        $("unitDetailStatus").textContent = STATUS[u.status] || u.status;
        const photo = $("unitDetailPhoto");
        if (u.planta_arquivo) {
            photo.src = `aurora/${u.planta_arquivo}`;
            photo.hidden = false;
        } else {
            photo.hidden = true;
            photo.src = "";
        }
        $("unitDetailSpecs").innerHTML = [ [ "Área privativa", formatArea(u.area_privativa_m2) ], [ "Quartos", u.quartos != null ? `${u.quartos}${u.suites ? ` (${u.suites} suíte${u.suites > 1 ? "s" : ""})` : ""}` : "—" ], [ "Banheiros", u.banheiros ?? "—" ], [ "Vagas", u.vagas ?? "—" ] ].map(([label, value]) => `<div class="unit-detail-spec"><span>${h(label)}</span><strong>${h(value)}</strong></div>`).join("");
        $("unitDetailValor").textContent = u.valor != null ? Number(u.valor).toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL",
            minimumFractionDigits: 0
        }) : "R$ —";
        $("unitDetailCliente").textContent = u.cliente || "—";
        $("unitQuickReserve").disabled = u.status === "reservado";
        $("unitQuickSold").disabled = u.status === "vendido";
        $("unitQuickBlock").disabled = u.status === "bloqueado";
    }
    async function quickUpdateUnitStatus(status) {
        if (!selectedUnit) return;
        try {
            const {data: unidade, error: error} = await sb.rpc("atualizar_unidade", {
                p_unidade_id: selectedUnit.id,
                p_expected_version: selectedUnit.version,
                p_status: status,
                p_valor: selectedUnit.valor ?? null,
                p_observacao: selectedUnit.observacao || "",
                p_cliente: selectedUnit.cliente || "",
                p_origem: "central_windows"
            });
            if (error) throw error;
            unidades.set(unidade.id, {
                ...unidades.get(unidade.id),
                ...unidade,
                updated_by_name: currentUser.display_name
            });
            updateUnitMetrics();
            selectUnitForPreview(unidade.id);
            toast("Unidade atualizada para todos os usuários.");
        } catch (error) {
            if (error.message?.includes("VERSION_CONFLICT")) await loadUnidades();
            toast(traduzErro(error.message));
        }
    }
    function openUnitAdmin(unitId) {
        const u = unidades.get(unitId);
        if (!u) return;
        selectedUnit = {
            ...u
        };
        $("unitAdminDialogTitle").textContent = `Apto ${u.numero} — ${torreNome(u.torre_id)} · ${u.andar}º andar`;
        $("unitAdminDialogMeta").innerHTML = `<span>${h(formatArea(u.area_privativa_m2))}</span><span>Versão ${u.version}</span>`;
        $("editUnitStatus").value = u.status;
        $("editUnitValue").value = u.valor ?? "";
        $("editUnitCustomer").value = u.cliente || "";
        $("editUnitNote").value = u.observacao || "";
        $("unitAdminDialogMessage").hidden = true;
        $("unitAdminDialog").showModal();
    }
    async function saveUnitAdmin() {
        if (!selectedUnit) return;
        try {
            const {data: unidade, error: error} = await sb.rpc("atualizar_unidade", {
                p_unidade_id: selectedUnit.id,
                p_expected_version: selectedUnit.version,
                p_status: $("editUnitStatus").value,
                p_valor: $("editUnitValue").value ? Number($("editUnitValue").value) : null,
                p_observacao: $("editUnitNote").value,
                p_cliente: $("editUnitCustomer").value,
                p_origem: "central_windows"
            });
            if (error) throw error;
            unidades.set(unidade.id, {
                ...unidades.get(unidade.id),
                ...unidade,
                updated_by_name: currentUser.display_name
            });
            updateUnitMetrics();
            renderUnitsTable();
            selectUnitForPreview(unidade.id);
            $("unitAdminDialog").close();
            toast("Unidade atualizada para todos os usuários.");
        } catch (error) {
            if (error.message?.includes("VERSION_CONFLICT")) await loadUnidades();
            showMessage($("unitAdminDialogMessage"), traduzErro(error.message));
        }
    }
    async function loadRequests() {
        const empId = await empreendimentoIdAtual();
        const {data: data, error: error} = await sb.from("solicitacoes").select("id, tipo, cliente_nome, cliente_telefone, cliente_cpf, cliente_email, cliente_endereco, forma_pagamento_nome, simulacao, observacao, status, created_at, revisado_em, expira_em, reserva_ate, lote_id, unidade_id, criado_por, lotes(chave, quadra, lote, version, status), unidades(id, numero, andar, version, status, torre_id), criado_por_perfil:perfis!solicitacoes_criado_por_fkey(nome_exibicao)").eq("empreendimento_id", empId).order("created_at", {
            ascending: false
        });
        if (error) {
            toast(error.message);
            return;
        }
        requests = data.map(item => ({
            id: item.id,
            type: item.tipo,
            customer_name: item.cliente_nome,
            customer_phone: item.cliente_telefone,
            customer_cpf: item.cliente_cpf,
            customer_email: item.cliente_email,
            customer_address: item.cliente_endereco,
            payment_plan_name: item.forma_pagamento_nome,
            note: item.observacao,
            status: item.status,
            created_at: item.created_at,
            reviewed_at: item.revisado_em,
            expires_at: item.expira_em,
            reserva_ate: item.reserva_ate,
            simulacao: item.simulacao,
            lote_id: item.lote_id,
            lot_key: item.lotes?.chave,
            quadra: item.lotes?.quadra,
            lote: item.lotes?.lote,
            unidade_id: item.unidade_id,
            unidade: item.unidades,
            created_by_name: item.criado_por_perfil?.nome_exibicao || "Corretor"
        }));
        updateRequestBadge();
        renderRequests();
        renderDashboard();
        loadBloqueios();
    }
    function updateRequestBadge() {
        const count = requests.filter(item => item.status === "pendente").length;
        $("requestCountBadge").textContent = count;
        $("requestCountBadge").hidden = count === 0;
    }
    function requestTargetLabel(item) {
        return item.lote_id ? `Quadra ${h(item.quadra)} · Lote ${h(item.lote)}` : `Apto ${h(item.unidade?.numero)} · ${h(item.unidade?.andar)}º andar`;
    }
    const ROTULO_STATUS_PEDIDO = {
        pendente: "Pendente",
        aprovada: "Aprovada",
        rejeitada: "Rejeitada",
        expirada: "Expirada"
    };
    function formatarRestante(ms) {
        const total = Math.max(0, Math.ceil(ms / 1000));
        const hh = Math.floor(total / 3600), mm = Math.floor(total % 3600 / 60), ss = total % 60;
        const dois = n => String(n).padStart(2, "0");
        return hh > 0 ? hh + ":" + dois(mm) + ":" + dois(ss) : dois(mm) + ":" + dois(ss);
    }
    function infoPrazoPedido(item) {
        if (item.status === "pendente" && item.expires_at) return `<small class="request-deadline" data-modo="pedido" data-prazo="${h(item.expires_at)}"></small>`;
        if (item.status === "aprovada" && item.type === "reserva" && item.reserva_ate) return `<small class="request-deadline" data-modo="reserva" data-prazo="${h(item.reserva_ate)}"></small>`;
        return "";
    }
    function atualizarPrazos() {
        document.querySelectorAll(".request-deadline").forEach(el => {
            const resto = Date.parse(el.dataset.prazo) - Date.now();
            if (el.dataset.modo === "pedido") el.textContent = resto > 0 ? "Responder em " + formatarRestante(resto) + " (depois expira)" : "Prazo de resposta esgotado";
            else el.textContent = resto > 0 ? "Reserva do corretor: restam " + formatarRestante(resto) : "Reserva vencida (libera sozinha)";
        });
    }
    setInterval(atualizarPrazos, 1000);
    async function loadBloqueios() {
        const box = $("bloqueiosList");
        if (!box) return;
        const empId = await empreendimentoIdAtual();
        const {data: data, error: error} = await sb.from("reserva_bloqueios").select("id, ate, lote_id, unidade_id, corretor:perfis!reserva_bloqueios_corretor_id_fkey(nome_exibicao), lotes(quadra, lote), unidades(numero, andar)").eq("empreendimento_id", empId).is("liberado_em", null).gt("ate", (new Date).toISOString()).order("ate");
        if (error) {
            box.innerHTML = "";
            return;
        }
        box.innerHTML = data.length ? data.map(b => `<div class="compact-item"><span><strong>${h(b.corretor?.nome_exibicao || "Corretor")}</strong><br><small>${b.lote_id ? "Quadra " + h(b.lotes?.quadra) + " · Lote " + h(b.lotes?.lote) : "Apto " + h(b.unidades?.numero)} · bloqueado até ${h(formatDate(b.ate))}</small></span><button class="secondary-button" data-liberar="${h(b.id)}">Liberar</button></div>`).join("") : '<div class="empty-state">Nenhum corretor bloqueado.</div>';
        box.querySelectorAll("[data-liberar]").forEach(btn => btn.addEventListener("click", async () => {
            btn.disabled = true;
            const {error: erroLiberar} = await sb.rpc("liberar_bloqueio_reserva", {
                p_bloqueio_id: btn.dataset.liberar
            });
            if (erroLiberar) {
                toast(traduzErro(erroLiberar.message));
                btn.disabled = false;
                return;
            }
            toast("Corretor liberado para pedir reserva de novo.");
            loadBloqueios();
        }));
    }
    function renderRequests() {
        const status = $("requestFilter").value;
        const list = requests.filter(item => !status || item.status === status);
        $("requestList").innerHTML = list.length ? list.map(item => `<article class="request-card"><small>${h(formatDate(item.created_at))}</small><h3>${requestTargetLabel(item)}</h3><p><strong>${item.type === "reserva" ? "Pedido de reserva" : "Indicação de venda"}</strong></p><p>Cliente: ${h(item.customer_name)}</p><small>Corretor: ${h(item.created_by_name)} · ${h(ROTULO_STATUS_PEDIDO[item.status] || item.status)}</small>${infoPrazoPedido(item)}${item.status === "pendente" ? `<button class="primary-button" data-request="${h(item.id)}">Analisar</button>` : ""}${item.status === "aprovada" ? `<button class="secondary-button" data-contract="${h(item.id)}">Fechamento / Contrato</button>` : ""}</article>`).join("") : '<div class="empty-state">Nenhuma solicitação nesta situação.</div>';
        $("requestList").querySelectorAll("[data-request]").forEach(button => button.addEventListener("click", () => openRequest(button.dataset.request)));
        $("requestList").querySelectorAll("[data-contract]").forEach(button => button.addEventListener("click", () => openContractDialog(button.dataset.contract)));
        atualizarPrazos();
    }
    function openRequest(requestId) {
        const request = requests.find(item => item.id === requestId);
        if (!request) return;
        selectedRequest = request;
        const alvo = request.lote_id ? lots.get(request.lot_key) : unidades.get(request.unidade_id);
        $("requestDialogTitle").textContent = requestTargetLabel(request);
        $("requestDialogContent").innerHTML = `<div class="request-card"><p><strong>${request.type === "reserva" ? "Pedido de reserva" : "Indicação de venda"}</strong></p><p>Cliente: ${h(request.customer_name)}</p><p>Telefone: ${h(request.customer_phone || "Não informado")}</p><p>CPF: ${h(request.customer_cpf || "Não informado")}</p><p>E-mail: ${h(request.customer_email || "Não informado")}</p><p>Endereço: ${h(request.customer_address || "Não informado")}</p><p>Forma de pagamento: ${h(request.payment_plan_name || "Não informada")}</p>${request.simulacao && window.SKLSimulador ? `<div class="request-simulacao"><strong>Simulação de financiamento escolhida pelo cliente</strong>${window.SKLSimulador.resumoHtml(request.simulacao)}<small>Simulação ilustrativa feita pelo corretor; não é aprovação de crédito.</small></div>` : ""}<p>Corretor: ${h(request.created_by_name)}</p><p>Observação: ${h(request.note || "—")}</p><small>Situação atual: ${h(STATUS[alvo?.status] || "—")} · versão ${alvo?.version || "—"}</small></div>`;
        $("requestDialogMessage").hidden = true;
        $("requestDialog").showModal();
    }
    async function reviewRequest(status) {
        if (!selectedRequest) return;
        const alvo = selectedRequest.lote_id ? lots.get(selectedRequest.lot_key) : unidades.get(selectedRequest.unidade_id);
        try {
            const {error: error} = await sb.rpc("revisar_solicitacao", {
                p_solicitacao_id: selectedRequest.id,
                p_decisao: status,
                p_expected_lot_version: alvo?.version,
                p_status_lote: $("requestLotStatus").value,
                p_observacao_revisao: $("requestReviewNote").value,
                p_origem: "central_windows"
            });
            if (error) throw error;
            const index = requests.findIndex(item => item.id === selectedRequest.id);
            if (index >= 0) requests[index].status = status;
            if (selectedRequest.lote_id) await loadLots(); else await loadUnidades();
            updateRequestBadge();
            renderRequests();
            renderDashboard();
            $("requestDialog").close();
            toast(status === "aprovada" ? "Solicitação aprovada e estoque atualizado." : "Solicitação rejeitada.");
        } catch (error) {
            showMessage($("requestDialogMessage"), traduzErro(error.message));
        }
    }
    let planInfo = {
        plano_nome: null,
        limite_corretores: null,
        valor_mensal: null
    };
    let planRequests = [];
    const SERIE_TIPO_LABEL = {
        ato: "Ato",
        sinal: "Sinal",
        parcelas: "Parcelas",
        financiamento: "Financiamento",
        chaves: "Chaves",
        outro: "Outro"
    };
    function formatMoneyBR(value) {
        return value == null || value === "" ? "—" : Number(value).toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL"
        });
    }
    let paymentPlans = [];
    let pendingDeletePaymentPlanId = null;
    async function loadPaymentPlans() {
        const empId = await empreendimentoIdAtual();
        const {data: data, error: error} = await sb.from("planos_pagamento").select("*, planos_pagamento_series(*)").eq("empreendimento_id", empId).order("criado_em");
        if (error) {
            toast(traduzErro(error.message));
            return;
        }
        paymentPlans = (data || []).map(plano => ({
            ...plano,
            planos_pagamento_series: (plano.planos_pagamento_series || []).sort((a, b) => a.ordem - b.ordem)
        }));
        renderPaymentPlans();
    }
    function renderPaymentPlans() {
        $("paymentPlanList").innerHTML = paymentPlans.length ? paymentPlans.map(plano => `<div class="plan-card ${plano.ativo ? "" : "plan-inactive"}"><div class="plan-card-heading"><div><h3>${h(plano.nome)}</h3>${plano.descricao ? `<p class="plan-card-desc">${h(plano.descricao)}</p>` : ""}</div><div class="plan-card-actions"><button class="row-button" data-plan-edit="${h(plano.id)}">Editar</button><button class="row-button danger-button" data-plan-delete="${h(plano.id)}">Excluir</button></div></div><div class="plan-series-chip-row">${plano.planos_pagamento_series.map(s => `<span class="plan-series-chip">${h(SERIE_TIPO_LABEL[s.tipo] || s.tipo)}${s.quantidade_parcelas > 1 ? ` · ${s.quantidade_parcelas}x` : ""}${s.valor_total ? ` · ${h(formatMoneyBR(s.valor_total))}` : ""}</span>`).join("") || '<span class="plan-series-chip">Sem etapas cadastradas</span>'}</div>${!plano.ativo ? '<small class="muted-text">Inativo — não aparece pro corretor</small>' : ""}</div>`).join("") : '<div class="empty-state">Nenhuma forma de pagamento cadastrada ainda.</div>';
        $("paymentPlanList").querySelectorAll("[data-plan-edit]").forEach(btn => btn.addEventListener("click", () => openPaymentPlanDialog(btn.dataset.planEdit)));
        $("paymentPlanList").querySelectorAll("[data-plan-delete]").forEach(btn => btn.addEventListener("click", () => {
            pendingDeletePaymentPlanId = btn.dataset.planDelete;
            const plano = paymentPlans.find(p => p.id === pendingDeletePaymentPlanId);
            $("deletePaymentPlanName").textContent = plano ? plano.nome : "";
            $("deletePaymentPlanDialog").showModal();
        }));
    }
    let editingPaymentPlanId = null;
    function addSerieRow(serie = {}) {
        const row = document.createElement("div");
        row.className = "serie-row";
        row.innerHTML = `<select class="serie-tipo">${Object.entries(SERIE_TIPO_LABEL).map(([value, label]) => `<option value="${value}" ${serie.tipo === value ? "selected" : ""}>${label}</option>`).join("")}</select><input class="serie-qtd" type="number" min="1" placeholder="Parcelas" value="${serie.quantidade_parcelas ?? 1}" /><input class="serie-valor" type="number" step="0.01" placeholder="Valor total (R$)" value="${serie.valor_total ?? ""}" /><input class="serie-indexador" placeholder="Indexador (opcional)" value="${h(serie.indexador || "")}" /><input class="serie-portador" placeholder="Banco/portador (opcional)" value="${h(serie.portador_cobranca || "")}" /><button type="button" class="row-button danger-button serie-remove">Remover</button>`;
        row.querySelector(".serie-remove").addEventListener("click", () => row.remove());
        $("paymentPlanSeriesList").appendChild(row);
    }
    function openPaymentPlanDialog(planId) {
        editingPaymentPlanId = planId || null;
        const plano = planId ? paymentPlans.find(p => p.id === planId) : null;
        $("paymentPlanDialogTitle").textContent = plano ? "Editar plano" : "Novo plano";
        $("paymentPlanNameInput").value = plano?.nome || "";
        $("paymentPlanDescInput").value = plano?.descricao || "";
        $("paymentPlanActiveInput").checked = plano ? plano.ativo : true;
        $("paymentPlanSeriesList").innerHTML = "";
        if (plano && plano.planos_pagamento_series.length) {
            plano.planos_pagamento_series.forEach(serie => addSerieRow(serie));
        } else {
            addSerieRow({
                tipo: "ato"
            });
        }
        $("paymentPlanMessage").hidden = true;
        $("paymentPlanDialog").showModal();
    }
    async function savePaymentPlan() {
        const nome = $("paymentPlanNameInput").value.trim();
        if (!nome) return showMessage($("paymentPlanMessage"), "Informe o nome do plano.");
        const empId = await empreendimentoIdAtual();
        const series = [ ...$("paymentPlanSeriesList").querySelectorAll(".serie-row") ].map((row, index) => ({
            tipo: row.querySelector(".serie-tipo").value,
            quantidade_parcelas: Number(row.querySelector(".serie-qtd").value) || 1,
            valor_total: row.querySelector(".serie-valor").value ? Number(row.querySelector(".serie-valor").value) : null,
            indexador: row.querySelector(".serie-indexador").value.trim() || null,
            portador_cobranca: row.querySelector(".serie-portador").value.trim() || null,
            ordem: index
        }));
        try {
            let planoId = editingPaymentPlanId;
            if (planoId) {
                const {error: error} = await sb.from("planos_pagamento").update({
                    nome: nome,
                    descricao: $("paymentPlanDescInput").value.trim() || null,
                    ativo: $("paymentPlanActiveInput").checked,
                    atualizado_em: new Date().toISOString()
                }).eq("id", planoId);
                if (error) throw error;
                await sb.from("planos_pagamento_series").delete().eq("plano_pagamento_id", planoId);
            } else {
                const {data: novo, error: error} = await sb.from("planos_pagamento").insert({
                    empreendimento_id: empId,
                    nome: nome,
                    descricao: $("paymentPlanDescInput").value.trim() || null,
                    ativo: $("paymentPlanActiveInput").checked
                }).select("id").single();
                if (error) throw error;
                planoId = novo.id;
            }
            if (series.length) {
                const {error: seriesError} = await sb.from("planos_pagamento_series").insert(series.map(s => ({
                    ...s,
                    plano_pagamento_id: planoId
                })));
                if (seriesError) throw seriesError;
            }
            await loadPaymentPlans();
            $("paymentPlanDialog").close();
            toast("Forma de pagamento salva.");
        } catch (error) {
            showMessage($("paymentPlanMessage"), traduzErro(error.message));
        }
    }
    async function confirmDeletePaymentPlan() {
        if (!pendingDeletePaymentPlanId) return;
        const {error: error} = await sb.from("planos_pagamento").delete().eq("id", pendingDeletePaymentPlanId);
        if (error) {
            toast(traduzErro(error.message));
            return;
        }
        await loadPaymentPlans();
        $("deletePaymentPlanDialog").close();
        toast("Plano excluído.");
    }
    const MODELO_CONTRATO_EXEMPLO = `<h1>Instrumento Particular de Promessa de Compra e Venda</h1>
<p>Pelo presente instrumento particular, de um lado {{empreendimento_nome}}, doravante denominado(a) PROMITENTE VENDEDOR(A), e de outro lado {{cliente_nome}}, portador(a) do CPF nº {{cliente_cpf}} e RG nº {{cliente_rg}}, estado civil {{cliente_estado_civil}}, profissão {{cliente_profissao}}, residente e domiciliado(a) em {{cliente_endereco}}, telefone {{cliente_telefone}}, e-mail {{cliente_email}}, doravante denominado(a) PROMITENTE COMPRADOR(A), têm entre si justo e contratado o seguinte:</p>
<p><strong>Cláusula 1ª — Do Imóvel.</strong> O(a) PROMITENTE VENDEDOR(A) promete vender ao(à) PROMITENTE COMPRADOR(A) o imóvel identificado como {{imovel_identificacao}}, com área de {{imovel_area}}, integrante do empreendimento {{empreendimento_nome}}.</p>
<p><strong>Cláusula 2ª — Do Preço e Forma de Pagamento.</strong> O preço total ajustado para a presente promessa de compra e venda é de {{valor}}, a ser pago conforme a forma de pagamento: {{forma_pagamento}}.</p>
<p><strong>Cláusula 3ª — Disposições Gerais.</strong> As partes elegem o presente instrumento como expressão de sua livre vontade, obrigando-se por si e seus sucessores ao fiel cumprimento do que ora pactuam.</p>
<p>E por estarem assim justos e contratados, firmam o presente instrumento.</p>
<p style="text-align:center;margin-top:30px">{{empreendimento_nome}}, {{data_atual}}.</p>
<div class="contract-sign-row"><div class="contract-sign-line">PROMITENTE VENDEDOR(A)</div><div class="contract-sign-line">{{cliente_nome}}<br />PROMITENTE COMPRADOR(A)</div></div>`;
    async function loadContractTemplate() {
        const empId = await empreendimentoIdAtual();
        const {data: data, error: error} = await sb.from("contratos_templates").select("conteudo_html, atualizado_em").eq("empreendimento_id", empId).maybeSingle();
        if (error) {
            toast(traduzErro(error.message));
            return;
        }
        $("contractTemplateInput").value = data?.conteudo_html || "";
        $("contractTemplateStatus").textContent = data?.atualizado_em ? `Modelo salvo · atualizado em ${formatDate(data.atualizado_em)}` : "Nenhum modelo salvo ainda — use o modelo de exemplo como ponto de partida.";
    }
    function loadExampleTemplate() {
        $("contractTemplateInput").value = MODELO_CONTRATO_EXEMPLO;
    }
    async function saveContractTemplate() {
        const empId = await empreendimentoIdAtual();
        const conteudo = $("contractTemplateInput").value;
        try {
            const {data: userData} = await sb.auth.getUser();
            const {error: error} = await sb.from("contratos_templates").upsert({
                empreendimento_id: empId,
                conteudo_html: conteudo,
                atualizado_em: new Date().toISOString(),
                atualizado_por: userData?.user?.id || null
            }, {
                onConflict: "empreendimento_id"
            });
            if (error) throw error;
            $("contractTemplateStatus").textContent = `Modelo salvo · atualizado em ${formatDate((new Date).toISOString())}`;
            toast("Modelo de contrato salvo.");
        } catch (error) {
            showMessage($("contractTemplateMessage"), traduzErro(error.message));
        }
    }
    let contractRequest = null;
    let contractExisting = null;
    async function openContractDialog(requestId) {
        const request = requests.find(item => item.id === requestId);
        if (!request) return;
        contractRequest = request;
        contractExisting = null;
        $("contractDialogTitle").textContent = requestTargetLabel(request);
        $("contractMessage").hidden = true;
        await loadPaymentPlans();
        $("contractPaymentPlanInput").innerHTML = '<option value="">Selecione...</option>' + paymentPlans.filter(p => p.ativo).map(p => `<option value="${h(p.nome)}">${h(p.nome)}</option>`).join("");
        const {data: existing} = await sb.from("contratos").select("*").eq("solicitacao_id", requestId).maybeSingle();
        contractExisting = existing || null;
        const dados = existing?.dados_cliente || {};
        const endereco = dados.endereco || {};
        $("contractNomeInput").value = dados.nome_completo || request.customer_name || "";
        $("contractCpfInput").value = dados.cpf || "";
        $("contractRgInput").value = dados.rg || "";
        $("contractEstadoCivilInput").value = dados.estado_civil || "";
        $("contractProfissaoInput").value = dados.profissao || "";
        $("contractTelefoneInput").value = dados.telefone || request.customer_phone || "";
        $("contractEmailInput").value = dados.email || "";
        $("contractEnderecoInput").value = endereco.rua || "";
        $("contractBairroInput").value = endereco.bairro || "";
        $("contractCidadeInput").value = endereco.cidade || "";
        $("contractUfInput").value = endereco.uf || "";
        $("contractCepInput").value = endereco.cep || "";
        $("contractPaymentPlanInput").value = dados.forma_pagamento || "";
        $("contractStatusInfo").textContent = existing ? `Situação do contrato: ${existing.status} · atualizado em ${formatDate(existing.atualizado_em)}` : "Ainda não há dados salvos para este cliente.";
        $("contractDialog").showModal();
    }
    function coletarDadosContrato() {
        return {
            nome_completo: $("contractNomeInput").value.trim(),
            cpf: $("contractCpfInput").value.trim(),
            rg: $("contractRgInput").value.trim(),
            estado_civil: $("contractEstadoCivilInput").value.trim(),
            profissao: $("contractProfissaoInput").value.trim(),
            telefone: $("contractTelefoneInput").value.trim(),
            email: $("contractEmailInput").value.trim(),
            endereco: {
                rua: $("contractEnderecoInput").value.trim(),
                bairro: $("contractBairroInput").value.trim(),
                cidade: $("contractCidadeInput").value.trim(),
                uf: $("contractUfInput").value.trim().toUpperCase(),
                cep: $("contractCepInput").value.trim()
            },
            forma_pagamento: $("contractPaymentPlanInput").value
        };
    }
    async function saveContractData() {
        if (!contractRequest) return false;
        const nome = $("contractNomeInput").value.trim();
        if (nome.length < 3) {
            showMessage($("contractMessage"), "Informe o nome completo do cliente.");
            return false;
        }
        const empId = await empreendimentoIdAtual();
        const dados = coletarDadosContrato();
        try {
            if (contractExisting) {
                const {data: data, error: error} = await sb.from("contratos").update({
                    dados_cliente: dados,
                    atualizado_em: new Date().toISOString()
                }).eq("id", contractExisting.id).select().single();
                if (error) throw error;
                contractExisting = data;
            } else {
                const {data: data, error: error} = await sb.from("contratos").insert({
                    empreendimento_id: empId,
                    solicitacao_id: contractRequest.id,
                    dados_cliente: dados
                }).select().single();
                if (error) throw error;
                contractExisting = data;
            }
            $("contractStatusInfo").textContent = `Dados salvos · ${formatDate(contractExisting.atualizado_em)} (contrato ainda não gerado)`;
            toast("Dados do cliente salvos.");
            return true;
        } catch (error) {
            showMessage($("contractMessage"), traduzErro(error.message));
            return false;
        }
    }
    function preencherModeloContrato(template, dados) {
        return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, chave) => {
            const valor = dados[chave];
            return valor === undefined || valor === null || valor === "" ? "_______________" : String(valor);
        });
    }
    function printContractDocument() {
        if (window.NativeBridge?.printPage) {
            window.NativeBridge.printPage();
            return;
        }
        window.print();
    }
    async function generateContract() {
        if (!contractRequest) return;
        const salvo = await saveContractData();
        if (!salvo || !contractExisting) return;
        const empId = await empreendimentoIdAtual();
        const {data: templateRow} = await sb.from("contratos_templates").select("conteudo_html").eq("empreendimento_id", empId).maybeSingle();
        const template = templateRow?.conteudo_html;
        if (!template) {
            showMessage($("contractMessage"), "Nenhum modelo de contrato configurado. Vá em Configurações → Modelo de contrato.");
            return;
        }
        let valor = "";
        let area = "";
        if (contractRequest.lote_id) {
            const {data: lote} = await sb.from("lotes").select("valor, area_m2").eq("id", contractRequest.lote_id).maybeSingle();
            valor = lote?.valor || "";
            area = lote?.area_m2 ? `${lote.area_m2} m²` : "";
        } else if (contractRequest.unidade_id) {
            const {data: unidade} = await sb.from("unidades").select("valor, area_privativa_m2").eq("id", contractRequest.unidade_id).maybeSingle();
            valor = unidade?.valor ? formatMoneyBR(unidade.valor) : "";
            area = unidade?.area_privativa_m2 ? `${unidade.area_privativa_m2} m²` : "";
        }
        const dados = contractExisting.dados_cliente || {};
        const endereco = dados.endereco || {};
        const enderecoTexto = [ endereco.rua, endereco.bairro, [ endereco.cidade, endereco.uf ].filter(Boolean).join("/"), endereco.cep ? `CEP ${endereco.cep}` : null ].filter(Boolean).join(", ");
        const tokens = {
            cliente_nome: dados.nome_completo,
            cliente_cpf: dados.cpf,
            cliente_rg: dados.rg,
            cliente_estado_civil: dados.estado_civil,
            cliente_profissao: dados.profissao,
            cliente_telefone: dados.telefone,
            cliente_email: dados.email,
            cliente_endereco: enderecoTexto,
            forma_pagamento: dados.forma_pagamento,
            imovel_identificacao: requestTargetLabel(contractRequest),
            imovel_area: area,
            valor: valor,
            empreendimento_nome: $("settingsEmpreendimentoNome").textContent || "",
            data_atual: (new Date).toLocaleDateString("pt-BR")
        };
        $("contractPrintArea").innerHTML = `<div class="contract-doc">${preencherModeloContrato(template, tokens)}</div>`;
        printContractDocument();
        await sb.from("contratos").update({
            status: "gerado",
            atualizado_em: new Date().toISOString()
        }).eq("id", contractExisting.id);
        $("contractStatusInfo").textContent = `Contrato gerado · ${formatDate((new Date).toISOString())}`;
        toast("Contrato gerado — confira a janela de impressão.");
    }
    let bankingList = [];
    let editingBankingId = null;
    let pendingDeleteBankingId = null;
    const BANKING_TIPO_LABEL = {
        pix: "PIX",
        boleto: "Boleto",
        deposito: "Depósito/TED",
        outro: "Outro"
    };
    async function loadBanking() {
        const empId = await empreendimentoIdAtual();
        const {data: data, error: error} = await sb.from("dados_bancarios_cobranca").select("*").eq("empreendimento_id", empId).order("ordem");
        if (error) {
            toast(traduzErro(error.message));
            return;
        }
        bankingList = data || [];
        renderBanking();
    }
    function renderBanking() {
        $("bankingList").innerHTML = bankingList.length ? bankingList.map(item => `<div class="banking-card ${item.ativo ? "" : "banking-inactive"}"><div class="banking-card-heading"><div><h3>${h(BANKING_TIPO_LABEL[item.tipo] || item.tipo)}${item.banco_nome ? " · " + h(item.banco_nome) : ""}</h3><p class="plan-card-desc">${[ item.titular, item.chave_pix ? "PIX: " + item.chave_pix : null, item.conta ? "Conta: " + item.conta : null ].filter(Boolean).map(h).join(" · ") || "—"}</p></div><div class="banking-card-actions"><button class="row-button" data-bank-edit="${h(item.id)}">Editar</button><button class="row-button danger-button" data-bank-delete="${h(item.id)}">Excluir</button></div></div>${!item.ativo ? '<small class="muted-text">Inativo — não aparece pro corretor</small>' : ""}</div>`).join("") : '<div class="empty-state">Nenhum dado bancário cadastrado ainda.</div>';
        $("bankingList").querySelectorAll("[data-bank-edit]").forEach(btn => btn.addEventListener("click", () => openBankingDialog(btn.dataset.bankEdit)));
        $("bankingList").querySelectorAll("[data-bank-delete]").forEach(btn => btn.addEventListener("click", () => {
            pendingDeleteBankingId = btn.dataset.bankDelete;
            $("deleteBankingDialog").showModal();
        }));
    }
    function openBankingDialog(id) {
        editingBankingId = id || null;
        const item = id ? bankingList.find(b => b.id === id) : null;
        $("bankingDialogTitle").textContent = item ? "Editar dado bancário" : "Novo dado bancário";
        $("bankingTipoInput").value = item?.tipo || "pix";
        $("bankingBancoInput").value = item?.banco_nome || "";
        $("bankingAgenciaInput").value = item?.agencia || "";
        $("bankingContaInput").value = item?.conta || "";
        $("bankingChavePixInput").value = item?.chave_pix || "";
        $("bankingTitularInput").value = item?.titular || "";
        $("bankingDocumentoInput").value = item?.documento_titular || "";
        $("bankingInstrucoesInput").value = item?.instrucoes || "";
        $("bankingAtivoInput").checked = item ? item.ativo : true;
        $("bankingMessage").hidden = true;
        $("bankingDialog").showModal();
    }
    async function saveBanking() {
        const empId = await empreendimentoIdAtual();
        const payload = {
            empreendimento_id: empId,
            tipo: $("bankingTipoInput").value,
            banco_nome: $("bankingBancoInput").value.trim() || null,
            agencia: $("bankingAgenciaInput").value.trim() || null,
            conta: $("bankingContaInput").value.trim() || null,
            chave_pix: $("bankingChavePixInput").value.trim() || null,
            titular: $("bankingTitularInput").value.trim() || null,
            documento_titular: $("bankingDocumentoInput").value.trim() || null,
            instrucoes: $("bankingInstrucoesInput").value.trim() || null,
            ativo: $("bankingAtivoInput").checked
        };
        try {
            const {error: error} = editingBankingId ? await sb.from("dados_bancarios_cobranca").update(payload).eq("id", editingBankingId) : await sb.from("dados_bancarios_cobranca").insert(payload);
            if (error) throw error;
            await loadBanking();
            $("bankingDialog").close();
            toast("Dado bancário salvo.");
        } catch (error) {
            showMessage($("bankingMessage"), traduzErro(error.message));
        }
    }
    async function confirmDeleteBanking() {
        if (!pendingDeleteBankingId) return;
        const {error: error} = await sb.from("dados_bancarios_cobranca").delete().eq("id", pendingDeleteBankingId);
        if (error) {
            toast(traduzErro(error.message));
            return;
        }
        await loadBanking();
        $("deleteBankingDialog").close();
        toast("Dado bancário excluído.");
    }
    let commissions = [];
    const COMMISSION_STATUS_LABEL = {
        pendente: "Pendente",
        aprovada: "Aprovada",
        paga: "Paga",
        cancelada: "Cancelada"
    };
    async function loadCommissions() {
        const empId = await empreendimentoIdAtual();
        const {data: data, error: error} = await sb.from("comissoes").select("*").eq("empreendimento_id", empId).order("criado_em", {
            ascending: false
        });
        if (error) {
            toast(traduzErro(error.message));
            return;
        }
        commissions = data || [];
        renderCommissions();
    }
    function commissionStatusPillClass(status) {
        if (status === "paga") return "disponivel";
        if (status === "cancelada") return "vendido";
        if (status === "aprovada") return "reservado";
        return "nao_informado";
    }
    function renderCommissions() {
        $("commissionTableBody").innerHTML = commissions.map(c => `<tr><td><strong>${h(c.corretor_nome || "—")}</strong></td><td>${h(formatMoneyBR(c.valor_venda))}</td><td>${c.percentual != null ? h(c.percentual) + "%" : "—"}</td><td>${h(formatMoneyBR(c.valor_comissao))}</td><td><span class="status-pill ${commissionStatusPillClass(c.status)}">${h(COMMISSION_STATUS_LABEL[c.status] || c.status)}</span></td><td style="display:flex;gap:6px">${c.status === "pendente" ? `<button class="row-button" data-commission-approve="${h(c.id)}">Aprovar</button>` : ""}${c.status !== "paga" && c.status !== "cancelada" ? `<button class="row-button" data-commission-pay="${h(c.id)}">Marcar paga</button>` : ""}</td></tr>`).join("");
        $("commissionTableEmpty").hidden = commissions.length > 0;
        $("commissionTableBody").querySelectorAll("[data-commission-approve]").forEach(btn => btn.addEventListener("click", () => updateCommissionStatus(btn.dataset.commissionApprove, "aprovada")));
        $("commissionTableBody").querySelectorAll("[data-commission-pay]").forEach(btn => btn.addEventListener("click", () => updateCommissionStatus(btn.dataset.commissionPay, "paga")));
    }
    async function updateCommissionStatus(id, status) {
        const payload = {
            status: status
        };
        if (status === "paga") payload.pago_em = new Date().toISOString();
        const {error: error} = await sb.from("comissoes").update(payload).eq("id", id);
        if (error) {
            toast(traduzErro(error.message));
            return;
        }
        await loadCommissions();
        toast("Comissão atualizada.");
    }
    function openCommissionDialog() {
        const corretores = users.filter(u => u.papel === "corretor");
        $("commissionCorretorInput").innerHTML = corretores.map(u => `<option value="${h(u.id)}">${h(u.display_name)}</option>`).join("") || '<option value="">Nenhum corretor cadastrado</option>';
        $("commissionValorVendaInput").value = "";
        $("commissionPercentualInput").value = "";
        $("commissionValorComissaoInput").value = "";
        $("commissionObservacaoInput").value = "";
        $("commissionMessage").hidden = true;
        $("commissionDialog").showModal();
    }
    async function saveCommission() {
        const empId = await empreendimentoIdAtual();
        const corretorId = $("commissionCorretorInput").value;
        const corretor = users.find(u => u.id === corretorId);
        if (!corretorId) return showMessage($("commissionMessage"), "Selecione um corretor.");
        const valorVenda = $("commissionValorVendaInput").value ? Number($("commissionValorVendaInput").value) : null;
        const percentual = $("commissionPercentualInput").value ? Number($("commissionPercentualInput").value) : null;
        let valorComissao = $("commissionValorComissaoInput").value ? Number($("commissionValorComissaoInput").value) : null;
        if (valorComissao == null && valorVenda != null && percentual != null) valorComissao = Math.round(valorVenda * percentual) / 100;
        try {
            const {error: error} = await sb.from("comissoes").insert({
                empreendimento_id: empId,
                corretor_id: corretorId,
                corretor_nome: corretor?.display_name || null,
                valor_venda: valorVenda,
                percentual: percentual,
                valor_comissao: valorComissao,
                observacao: $("commissionObservacaoInput").value.trim() || null
            });
            if (error) throw error;
            await loadCommissions();
            $("commissionDialog").close();
            toast("Comissão registrada.");
        } catch (error) {
            showMessage($("commissionMessage"), traduzErro(error.message));
        }
    }
    let planCorretoresAtivos = 0;
    async function loadPlanInfo() {
        const empId = await empreendimentoIdAtual();
        const {data: data} = await sb.from("empreendimentos").select("plano_nome, limite_corretores, valor_mensal").eq("id", empId).maybeSingle();
        if (data) planInfo = data;
        const {count: count} = await sb.from("empreendimento_usuarios").select("usuario_id", {
            count: "exact",
            head: true
        }).eq("empreendimento_id", empId).eq("papel", "corretor").eq("ativo", true);
        planCorretoresAtivos = count || 0;
        const {data: reqRows} = await sb.from("solicitacoes_plano").select("*").eq("empreendimento_id", empId).order("created_at", {
            ascending: false
        });
        planRequests = reqRows || [];
        renderPlan();
    }
    function planRequestStatusPill(status) {
        if (status === "atendida") return '<span class="status-pill disponivel">Atendido</span>';
        if (status === "recusada") return '<span class="status-pill vendido">Recusado</span>';
        return '<span class="status-pill reservado">Pendente</span>';
    }
    function renderPlan() {
        $("planNameText").textContent = planInfo.plano_nome || "Sem pacote definido";
        $("planCorretoresUsados").textContent = planCorretoresAtivos;
        $("planCorretoresLimite").textContent = planInfo.limite_corretores == null ? "Sem limite" : planInfo.limite_corretores;
        $("planValorMensal").textContent = planInfo.valor_mensal == null ? "A combinar" : `R$ ${Number(planInfo.valor_mensal).toLocaleString("pt-BR", {
            minimumFractionDigits: 2
        })}`;
        $("planRequestList").innerHTML = planRequests.length ? planRequests.map(r => `<div class="compact-item"><span><strong>${h(r.pacote_solicitado)}</strong><br><small>${h(formatDate(r.created_at))}${r.resposta_observacao ? " · " + h(r.resposta_observacao) : ""}</small></span>${planRequestStatusPill(r.status)}</div>`).join("") : '<div class="empty-state">Nenhum pedido enviado ainda.</div>';
    }
    async function submitPlanRequest() {
        try {
            const pacote = $("planPackageInput").value;
            const observacao = $("planObservationInput").value.trim();
            const {error: error} = await sb.rpc("criar_solicitacao_plano", {
                p_empreendimento_slug: empreendimentoSlugAtual,
                p_pacote_solicitado: pacote,
                p_observacao: observacao
            });
            if (error) throw error;
            $("planRequestDialog").close();
            toast("Pedido enviado! A SKL vai avaliar e retornar em breve.");
            await loadPlanInfo();
        } catch (error) {
            showMessage($("planRequestMessage"), traduzErro(error.message));
        }
    }
    async function loadUsers() {
        const empId = await empreendimentoIdAtual();
        const {data: vinculos, error: error} = await sb.from("empreendimento_usuarios").select("usuario_id, papel, ativo, expira_em, perfis(nome_exibicao)").eq("empreendimento_id", empId);
        if (error) {
            toast(error.message);
            return;
        }
        users = vinculos.map(v => ({
            id: v.usuario_id,
            display_name: v.perfis?.nome_exibicao || "—",
            papel: v.papel,
            active: v.ativo,
            expires_at: v.expira_em
        }));
        const {data: conviteRows} = await sb.from("convites").select("id, email, papel, expira_em").eq("empreendimento_id", empId).is("usado_em", null).gt("expira_em", (new Date).toISOString());
        invites = conviteRows || [];
        renderUsers();
    }
    function userStatusPill(user) {
        if (!user.active) return '<span class="status-pill vendido">Bloqueado</span>';
        if (user.expires_at) {
            const expired = new Date(user.expires_at).getTime() < Date.now();
            return expired ? `<span class="status-pill vendido">Expirado</span>` : `<span class="status-pill reservado">Até ${h(formatDate(user.expires_at))}</span>`;
        }
        return '<span class="status-pill disponivel">Ativo</span>';
    }
    function canManage(user) {
        if (user.id === currentUser.id) return false;
        if (currentUser.papel === "central_vendas") return user.papel === "corretor";
        return true;
    }
    function renderUsers() {
        $("userTableBody").innerHTML = users.map(user => {
            if (!canManage(user)) {
                return `<tr><td><strong>${h(user.display_name)}</strong></td><td>${h(user.email || "—")}</td><td>${h(ROLE[user.papel])}</td><td>${userStatusPill(user)}</td><td>—</td><td>${user.id === currentUser.id ? "Conta atual" : "—"}</td></tr>`;
            }
            const toggleLabel = user.active ? "Desativar" : "Reativar";
            return `<tr><td><strong>${h(user.display_name)}</strong></td><td>${h(user.email || "—")}</td><td>${h(ROLE[user.papel])}</td><td>${userStatusPill(user)}</td><td>—</td><td style="display:flex;gap:6px;flex-wrap:wrap"><button class="row-button" data-user-emp="${h(user.id)}" data-user-emp-name="${h(user.display_name)}">Empreendimentos</button><button class="row-button" data-user-reset="${h(user.id)}">Redefinir senha</button><button class="row-button" data-user-toggle="${h(user.id)}" data-next-active="${user.active ? "0" : "1"}">${toggleLabel}</button><button class="row-button danger-button" data-user-delete="${h(user.id)}" data-user-name="${h(user.display_name)}">Excluir</button></td></tr>`;
        }).join("");
        $("userTableBody").querySelectorAll("[data-user-emp]").forEach(button => button.addEventListener("click", () => openUserEmpreendimentosDialog(button.dataset.userEmp, button.dataset.userEmpName)));
        $("userTableBody").querySelectorAll("[data-user-reset]").forEach(button => button.addEventListener("click", () => resetUser(button.dataset.userReset)));
        $("userTableBody").querySelectorAll("[data-user-toggle]").forEach(button => button.addEventListener("click", () => toggleUserStatus(button.dataset.userToggle, button.dataset.nextActive === "1")));
        $("userTableBody").querySelectorAll("[data-user-delete]").forEach(button => button.addEventListener("click", () => deleteUser(button.dataset.userDelete, button.dataset.userName)));
        $("inviteList").innerHTML = invites.length ? invites.map(invite => `<div class="invite-row"><span><strong>${h(invite.email)}</strong><br><small>${h(ROLE[invite.papel])} · expira ${h(formatDate(invite.expira_em))}</small></span><code class="invite-code">${h(invite.token || "")}</code></div>`).join("") : '<div class="empty-state">Nenhum convite pendente.</div>';
    }
    async function createInvite() {
        const slugs = selectedEmpreendimentoSlugs("inviteEmpList");
        if (!slugs.length) return showMessage($("inviteResult"), "Selecione ao menos um empreendimento.");
        try {
            const data = await invokeConvites({
                action: "criar_convite",
                empreendimento_slugs: slugs,
                display_name: $("inviteNameInput").value,
                papel: $("inviteRoleInput").value
            });
            await loadUsers();
            $("inviteResult").innerHTML = `Código: <strong>${h(data.convite.token)}</strong><br><small>Envie este código somente à pessoa autorizada.</small>`;
            $("inviteResult").hidden = false;
        } catch (error) {
            showMessage($("inviteResult"), traduzErro(error.message));
        }
    }
    function restrictRoleOptionsForCaller(selectEl) {
        const onlyCorretor = currentUser.papel === "central_vendas";
        [ ...selectEl.options ].forEach(option => {
            option.hidden = onlyCorretor && option.value !== "corretor";
        });
        if (onlyCorretor) selectEl.value = "corretor";
    }
    async function createDirectUser() {
        const slugs = selectedEmpreendimentoSlugs("directEmpList");
        if (!slugs.length) return showMessage($("directUserMessage"), "Selecione ao menos um empreendimento.");
        const validadeRaw = $("directExpiryInput").value;
        try {
            const data = await invokeConvites({
                action: "criar_usuario_direto",
                empreendimento_slugs: slugs,
                display_name: $("directNameInput").value,
                email: $("directEmailInput").value,
                password: $("directPasswordInput").value,
                papel: $("directRoleInput").value,
                validade_horas: validadeRaw ? Number(validadeRaw) : null
            });
            await loadUsers();
            const reaproveitado = data.reused_existing_account ? " (e-mail já tinha conta em outro empreendimento — vinculamos direto, mesma senha de sempre.)" : "";
            showMessage($("directUserMessage"), (data.expira_em ? `Acesso criado — expira em ${formatDate(data.expira_em)}.` : "Acesso criado sem prazo de validade.") + reaproveitado, true);
            $("directNameInput").value = "";
            $("directEmailInput").value = "";
            $("directPasswordInput").value = "";
        } catch (error) {
            showMessage($("directUserMessage"), traduzErro(error.message));
        }
    }
    async function toggleUserStatus(userId, nextActive) {
        const acao = nextActive ? "reativar" : "desativar";
        if (!confirm(`Confirma ${acao} o acesso deste usuário?`)) return;
        try {
            const data = await invokeConvites({
                action: "alternar_status_usuario",
                empreendimento_slug: empreendimentoSlugAtual,
                usuario_id: userId,
                ativo: nextActive
            });
            await loadUsers();
            toast(nextActive ? "Acesso reativado." : "Acesso desativado.");
        } catch (error) {
            toast(traduzErro(error.message));
        }
    }
    let pendingResetUserId = null;
    function resetUser(userId) {
        pendingResetUserId = userId;
        $("resetPasswordInput").value = "";
        $("resetPasswordMessage").hidden = true;
        $("resetPasswordDialog").showModal();
    }
    async function confirmResetPassword() {
        const novaSenha = $("resetPasswordInput").value;
        if (!novaSenha || novaSenha.length < 6) return showMessage($("resetPasswordMessage"), "A senha deve ter pelo menos 6 caracteres.");
        try {
            await invokeConvites({
                action: "redefinir_senha_admin",
                empreendimento_slug: empreendimentoSlugAtual,
                usuario_id: pendingResetUserId,
                nova_senha: novaSenha
            });
            $("resetPasswordDialog").close();
            toast("Senha redefinida com sucesso.");
        } catch (error) {
            showMessage($("resetPasswordMessage"), traduzErro(error.message));
        }
    }
    let pendingUserEmpUserId = null;
    async function openUserEmpreendimentosDialog(userId, displayName) {
        pendingUserEmpUserId = userId;
        $("userEmpreendimentosName").textContent = displayName;
        $("userEmpreendimentosMessage").hidden = true;
        try {
            const gerenciaveis = await listarEmpreendimentosParaGestao();
            const {data: atuais} = await sb.from("empreendimento_usuarios").select("empreendimentos(slug)").eq("usuario_id", userId).eq("ativo", true);
            const marcados = new Set((atuais || []).map(v => v.empreendimentos?.slug).filter(Boolean));
            renderEmpreendimentoChecklist("userEmpList", "userEmpAllInput", gerenciaveis, marcados);
        } catch (error) {
            toast(traduzErro(error.message));
        }
        $("userEmpreendimentosDialog").showModal();
    }
    async function saveUserEmpreendimentos() {
        const slugs = selectedEmpreendimentoSlugs("userEmpList");
        if (!slugs.length) return showMessage($("userEmpreendimentosMessage"), "Selecione ao menos um empreendimento.");
        try {
            await invokeConvites({
                action: "atualizar_empreendimentos_usuario",
                usuario_id: pendingUserEmpUserId,
                empreendimento_slugs: slugs
            });
            $("userEmpreendimentosDialog").close();
            toast("Acesso por empreendimento atualizado.");
            await loadUsers();
        } catch (error) {
            showMessage($("userEmpreendimentosMessage"), traduzErro(error.message));
        }
    }
    let pendingDeleteUser = null;
    function deleteUser(userId, displayName) {
        pendingDeleteUser = {
            id: userId,
            name: displayName
        };
        $("deleteUserName").textContent = displayName;
        $("deleteUserConfirmInput").value = "";
        $("deleteUserMessage").hidden = true;
        $("deleteUserDialog").showModal();
    }
    async function confirmDeleteUser() {
        if (!pendingDeleteUser) return;
        const digitado = $("deleteUserConfirmInput").value.trim();
        if (digitado !== pendingDeleteUser.name) return showMessage($("deleteUserMessage"), "Nome não confere — confira e digite exatamente como mostrado.");
        try {
            await invokeConvites({
                action: "excluir_usuario",
                empreendimento_slug: empreendimentoSlugAtual,
                usuario_id: pendingDeleteUser.id
            });
            await loadUsers();
            $("deleteUserDialog").close();
            toast("Usuário excluído.");
        } catch (error) {
            showMessage($("deleteUserMessage"), traduzErro(error.message));
        }
    }
    async function loadAudit() {
        const empId = await empreendimentoIdAtual();
        const {data: data, error: error} = await sb.from("auditoria").select("usuario_nome, acao, detalhes, created_at").eq("empreendimento_id", empId).order("created_at", {
            ascending: false
        }).limit(300);
        if (error) {
            toast(error.message);
            return;
        }
        auditItems = data.map(item => ({
            user_name: item.usuario_nome || "Sistema",
            action: item.acao,
            details: item.detalhes,
            at: item.created_at
        }));
        renderAudit();
        renderDashboard();
    }
    function renderAudit() {
        $("auditList").innerHTML = auditItems.length ? auditItems.map(item => `<div class="timeline-item"><strong>${h(item.user_name)}</strong><p>${h(ACTION[item.action] || item.action)}${item.details?.chave ? ` · ${h(item.details.chave)}` : ""}</p><small>${h(formatDate(item.at))}</small></div>`).join("") : '<div class="empty-state">Sem registros.</div>';
    }
    function renderDashboard() {
        const pending = requests.filter(item => item.status === "pendente").slice(0, 5);
        $("dashboardRequests").innerHTML = pending.length ? pending.map(item => `<div class="compact-item"><span><strong>${requestTargetLabel(item)}</strong><br><small>${h(item.customer_name)} · ${h(item.created_by_name)}</small></span><small>${h(formatDate(item.created_at))}</small></div>`).join("") : '<div class="empty-state">Nenhuma solicitação pendente.</div>';
        $("dashboardAudit").innerHTML = auditItems.slice(0, 5).map(item => `<div class="compact-item"><span><strong>${h(item.user_name)}</strong><br><small>${h(ACTION[item.action] || item.action)}</small></span><small>${h(formatDate(item.at))}</small></div>`).join("");
    }
    let relatoriosMarcaPronto = false;
    function iniciarRelatoriosMarca() {
        if (relatoriosMarcaPronto || !window.SKLRelatorios || !$("relatoriosMarcaPanel")) return;
        relatoriosMarcaPronto = true;
        window.SKLRelatorios.montarPainel($("relatoriosMarcaPanel"), { sb, getEmpreendimentoId: async () => empreendimentoId, getEmpreendimentoNome: () => empreendimentoNomeAtual, toast });
    }
    function renderReports() {
        iniciarRelatoriosMarca();
        renderReportFunnel();
        renderReportSalesChart();
        renderReportRanking();
    }
    function renderReportFunnel() {
        const counts = {
            disponivel: 0,
            reservado: 0,
            vendido: 0,
            bloqueado: 0,
            nao_informado: 0
        };
        const source = empreendimentoTipo === "vertical" ? unidades : lots;
        source.forEach(item => counts[item.status] = (counts[item.status] || 0) + 1);
        const total = source.size || 1;
        const order = [ "disponivel", "reservado", "vendido", "bloqueado", "nao_informado" ];
        $("reportFunnel").innerHTML = order.map(key => {
            const pct = Math.round(counts[key] / total * 100);
            return `<div class="report-bar-row"><span class="report-bar-label">${h(STATUS[key])}</span><div class="report-bar-track"><div class="report-bar-fill ${key}" style="width:${pct}%"></div></div><strong>${counts[key]}</strong></div>`;
        }).join("");
    }
    function weekKey(dateStr) {
        const d = new Date(dateStr);
        const firstJan = new Date(d.getFullYear(), 0, 1);
        const week = Math.ceil(((d - firstJan) / 864e5 + firstJan.getDay() + 1) / 7);
        return `${d.getFullYear()}-S${String(week).padStart(2, "0")}`;
    }
    function renderReportSalesChart() {
        const sales = auditItems.filter(item => item.action === "lot.updated" && item.details?.after?.status === "vendido");
        const byWeek = new Map;
        sales.forEach(item => {
            const key = weekKey(item.at);
            byWeek.set(key, (byWeek.get(key) || 0) + 1);
        });
        const weeks = [ ...byWeek.keys() ].sort().slice(-8);
        lastSalesByWeek = weeks.map(week => ({
            semana: week,
            vendas: byWeek.get(week)
        }));
        if (!weeks.length) {
            $("reportSalesChart").innerHTML = '<div class="empty-state">Sem vendas registradas no histórico carregado.</div>';
            return;
        }
        const max = Math.max(1, ...weeks.map(week => byWeek.get(week)));
        $("reportSalesChart").innerHTML = weeks.map(week => {
            const count = byWeek.get(week);
            const pct = Math.round(count / max * 100);
            return `<div class="report-bar-row"><span class="report-bar-label">${h(week)}</span><div class="report-bar-track"><div class="report-bar-fill vendido" style="width:${pct}%"></div></div><strong>${count}</strong></div>`;
        }).join("");
    }
    function computeRanking() {
        const byBroker = new Map;
        requests.forEach(item => {
            const name = item.created_by_name || "Corretor";
            if (!byBroker.has(name)) byBroker.set(name, {
                name: name,
                total: 0,
                aprovada: 0,
                rejeitada: 0,
                responseMs: []
            });
            const entry = byBroker.get(name);
            entry.total += 1;
            if (item.status === "aprovada") entry.aprovada += 1;
            if (item.status === "rejeitada") entry.rejeitada += 1;
            if (item.reviewed_at && item.created_at) entry.responseMs.push(new Date(item.reviewed_at) - new Date(item.created_at));
        });
        return [ ...byBroker.values() ].map(entry => ({
            ...entry,
            approvalRate: entry.total ? Math.round(entry.aprovada / entry.total * 100) : 0,
            avgResponseHours: entry.responseMs.length ? entry.responseMs.reduce((a, b) => a + b, 0) / entry.responseMs.length / 36e5 : null
        })).sort((a, b) => b.aprovada - a.aprovada || b.total - a.total);
    }
    function renderReportRanking() {
        const ranking = computeRanking();
        $("reportRankingBody").innerHTML = ranking.length ? ranking.map(entry => `<tr><td>${h(entry.name)}</td><td>${entry.total}</td><td>${entry.aprovada}</td><td>${entry.rejeitada}</td><td>${entry.approvalRate}%</td><td>${entry.avgResponseHours == null ? "—" : entry.avgResponseHours.toFixed(1) + "h"}</td></tr>`).join("") : '<tr><td colspan="6" class="empty-state">Nenhuma solicitação registrada ainda.</td></tr>';
    }
    function csvEscape(value) {
        const str = String(value == null ? "" : value);
        return /[",;\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }
    function buildCsv(headers, rows) {
        return [ headers, ...rows ].map(row => row.map(csvEscape).join(";")).join("\r\n");
    }
    function downloadCsv(filename, headers, rows) {
        const csv = "\ufeff" + buildCsv(headers, rows);
        if (window.NativeBridge?.saveTextFile) {
            const base64 = btoa(unescape(encodeURIComponent(csv)));
            window.NativeBridge.saveTextFile(base64, filename, "text/csv");
            return;
        }
        const blob = new Blob([ csv ], {
            type: "text/csv;charset=utf-8"
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4e3);
        toast(`${filename} salvo na pasta de downloads.`);
    }
    function exportLotsCsv() {
        if (empreendimentoTipo === "vertical") {
            const rows = [ ...unidades.values() ].sort((a, b) => a.andar - b.andar || String(a.numero).localeCompare(String(b.numero))).map(u => [ torreNome(u.torre_id), u.andar, u.numero, STATUS[u.status] || u.status, u.valor || "", u.cliente || "", formatDate(u.updated_at) ]);
            downloadCsv("unidades.csv", [ "Torre", "Andar", "Unidade", "Situação", "Valor", "Cliente", "Última atualização" ], rows);
            return;
        }
        const rows = [ ...lots.values() ].sort((a, b) => Number(a.quadra) - Number(b.quadra) || Number(a.lote) - Number(b.lote)).map(lot => [ lot.quadra, lot.lote, STATUS[lot.status] || lot.status, lot.valor || "", lot.cliente || "", formatDate(lot.updated_at) ]);
        downloadCsv(`lotes_${empreendimentoNomeAtual || "empreendimento"}.csv`, [ "Quadra", "Lote", "Situação", "Valor", "Cliente", "Última atualização" ], rows);
    }
    function exportRankingCsv() {
        const rows = computeRanking().map(entry => [ entry.name, entry.total, entry.aprovada, entry.rejeitada, `${entry.approvalRate}%`, entry.avgResponseHours == null ? "—" : `${entry.avgResponseHours.toFixed(1)}h` ]);
        downloadCsv("ranking_corretores.csv", [ "Corretor", "Solicitações", "Aprovadas", "Rejeitadas", "Taxa de aprovação", "Tempo médio de resposta" ], rows);
    }
    function exportSalesCsv() {
        const rows = lastSalesByWeek.map(item => [ item.semana, item.vendas ]);
        downloadCsv("vendas_por_semana.csv", [ "Semana", "Vendas" ], rows);
    }
    function printReport() {
        if (window.NativeBridge?.printPage) {
            window.NativeBridge.printPage();
            return;
        }
        window.print();
    }
    async function changePassword(event) {
        event.preventDefault();
        try {
            const {error: error} = await sb.auth.updateUser({
                password: $("changedPasswordInput").value
            });
            if (error) throw error;
            $("passwordForm").reset();
            toast("Senha alterada com segurança.");
        } catch (error) {
            toast(traduzErro(error.message));
        }
    }
    function playBeep() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext);
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            oscillator.type = "sine";
            oscillator.frequency.value = 880;
            gain.gain.setValueAtTime(.2, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .4);
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            oscillator.start();
            oscillator.stop(ctx.currentTime + .4);
        } catch (error) {}
    }
    function notify(title, body) {
        if (window.NativeBridge?.showNotification) {
            window.NativeBridge.showNotification(title, body);
            return;
        }
        playBeep();
        if (typeof Notification === "undefined") return;
        if (Notification.permission === "granted") {
            new Notification(title, {
                body: body
            });
        } else if (Notification.permission !== "denied") {
            Notification.requestPermission().then(perm => {
                if (perm === "granted") new Notification(title, {
                    body: body
                });
            });
        }
    }
    function connectRealtime() {
        if (realtimeChannel) sb.removeChannel(realtimeChannel);
        realtimeChannel = sb.channel("central-changes").on("postgres_changes", {
            event: "UPDATE",
            schema: "public",
            table: "lotes",
            filter: `empreendimento_id=eq.${empreendimentoId}`
        }, payload => {
            const lote = payload.new;
            lots.set(lote.chave, {
                ...lote,
                key: lote.chave,
                updated_by_name: lots.get(lote.chave)?.updated_by_name || ""
            });
            updateMetrics();
            renderLots();
            if (mapa3dInstance) mapa3dInstance.atualizarStatus(lote.id, lote.status);
            toast(`${lote.chave} atualizado.`);
        }).on("postgres_changes", {
            event: "UPDATE",
            schema: "public",
            table: "unidades",
            filter: `empreendimento_id=eq.${empreendimentoId}`
        }, payload => {
            const u = payload.new;
            unidades.set(u.id, {
                ...unidades.get(u.id),
                ...u
            });
            updateUnitMetrics();
            renderUnitsTable();
            if (selectedUnit?.id === u.id) selectUnitForPreview(u.id);
            toast(`Apto ${u.numero} atualizado.`);
        }).on("postgres_changes", {
            event: "INSERT",
            schema: "public",
            table: "solicitacoes",
            filter: `empreendimento_id=eq.${empreendimentoId}`
        }, payload => {
            loadRequests();
            toast("Nova solicitação recebida de um corretor.");
            const tipoLabel = payload.new?.tipo === "reserva" ? "reserva" : "indicação de venda";
            notify("Nova solicitação", `Um corretor enviou uma ${tipoLabel}.`);
        }).on("postgres_changes", {
            event: "UPDATE",
            schema: "public",
            table: "solicitacoes",
            filter: `empreendimento_id=eq.${empreendimentoId}`
        }, () => {
            loadRequests();
        }).subscribe(status => setConnection(status === "SUBSCRIBED"));
    }
})();