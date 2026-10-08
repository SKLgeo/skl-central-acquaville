// Foto de perfil (avatar) de corretores e usuários da Central. Módulo único, copiado sem edição para todos os apps
// (Central e Corretor de Vendas, Aluguéis, Unificado e Acquaville). A foto fica em perfis.foto_path, arquivo no
// bucket privado "fotos-perfil" em <usuario_id>/<arquivo>; quem pode trocar é decidido no banco
// (definir_foto_perfil / pode_alterar_foto_de). Sem foto, mostra as iniciais num círculo colorido.
(function () {
    "use strict";
    const BUCKET = "fotos-perfil";
    const LADO = 320; // a foto é cortada em quadrado e reduzida no aparelho antes de enviar
    const TAMANHOS = [ 24, 28, 32, 36, 40, 44, 56, 72, 96 ];
    const CORES = [ "#1f6f8b", "#2f8a56", "#7d5bc4", "#c0612b", "#3c6e71", "#a23e48", "#46658c", "#8a6d1d" ];
    const cacheUrls = new Map();
    let sb = null;
    let agendado = false;

    function esc(valor) {
        return String(valor == null ? "" : valor).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    function iniciais(nome) {
        const partes = String(nome || "").trim().split(/\s+/).filter(Boolean);
        if (!partes.length) return "?";
        return ((partes[0][0] || "") + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase();
    }
    function cor(nome) {
        let h = 0;
        for (const ch of String(nome || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        return CORES[h % CORES.length];
    }
    function tamanhoMaisProximo(t) {
        return TAMANHOS.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a, 36);
    }

    // HTML do avatar. As cores/foto entram depois por JS (aplicar), sem estilo em linha.
    function html(nome, path, tamanho) {
        const t = tamanhoMaisProximo(tamanho || 36);
        return `<span class="skl-avatar t-${t}" data-avatar-nome="${esc(nome)}"${path ? ` data-avatar-path="${esc(path)}"` : ""} title="${esc(nome)}" aria-hidden="true"><span class="skl-avatar-ini">${esc(iniciais(nome))}</span></span>`;
    }

    async function urlAssinada(path) {
        const guardado = cacheUrls.get(path);
        if (guardado && guardado.ate > Date.now()) return guardado.url;
        if (!sb) return null;
        const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
        if (error || !data) return null;
        cacheUrls.set(path, { url: data.signedUrl, ate: Date.now() + 55 * 60 * 1000 });
        return data.signedUrl;
    }

    function aplicar(raiz) {
        (raiz || document).querySelectorAll(".skl-avatar:not([data-avatar-ok])").forEach(el => {
            el.setAttribute("data-avatar-ok", "1");
            el.style.background = cor(el.getAttribute("data-avatar-nome"));
            const path = el.getAttribute("data-avatar-path");
            if (!path) return;
            urlAssinada(path).then(url => {
                if (!url) return;
                const img = new Image();
                img.alt = "";
                img.onload = () => { el.querySelectorAll("img").forEach(i => i.remove()); el.appendChild(img); el.classList.add("com-foto"); };
                img.src = url;
            });
        });
    }
    function agendarAplicar() {
        if (agendado) return;
        agendado = true;
        setTimeout(() => { agendado = false; aplicar(document); }, 30);
    }

    // camera = true abre a câmera do celular direto (frontal); no computador o navegador ignora e abre os arquivos.
    function escolherArquivo(camera) {
        return new Promise(resolve => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            if (camera) input.setAttribute("capture", "user");
            input.hidden = true;
            document.body.appendChild(input);
            input.addEventListener("change", () => { resolve(input.files && input.files[0] || null); input.remove(); }, { once: true });
            input.addEventListener("cancel", () => { resolve(null); input.remove(); }, { once: true });
            input.click();
        });
    }

    async function reduzir(arquivo) {
        const dataUrl = await new Promise((resolve, reject) => {
            const leitor = new FileReader();
            leitor.onload = () => resolve(leitor.result);
            leitor.onerror = () => reject(new Error("Não foi possível ler a imagem."));
            leitor.readAsDataURL(arquivo);
        });
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error("Arquivo de imagem inválido."));
            i.src = dataUrl;
        });
        const lado = Math.min(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.min(LADO, lado);
        canvas.getContext("2d").drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, canvas.width, canvas.height);
        return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("Não foi possível preparar a foto.")), "image/jpeg", 0.85));
    }

    function mensagemDeErro(error) {
        const texto = (error && error.message) || String(error || "");
        const m = texto.match(/^[A-Z_]{4,}: (.+)$/);
        if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1);
        if (/row-level security|unauthorized|403/i.test(texto)) return "Sem permissão para alterar esta foto.";
        return texto || "Não foi possível salvar a foto.";
    }

    // Abre a galeria (ou a câmera, com opcoes.camera), envia e grava a foto da pessoa.
    // Devolve o caminho novo, ou null se a pessoa cancelou.
    async function trocar(usuarioId, pathAntigo, opcoes) {
        const arquivo = await escolherArquivo(!!(opcoes && opcoes.camera));
        if (!arquivo) return null;
        try {
            const blob = await reduzir(arquivo);
            const path = `${usuarioId}/${Date.now()}.jpg`;
            const { error: erroUpload } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false });
            if (erroUpload) throw erroUpload;
            const { error } = await sb.rpc("definir_foto_perfil", { p_usuario: usuarioId, p_path: path });
            if (error) {
                sb.storage.from(BUCKET).remove([ path ]).catch(() => {});
                throw error;
            }
            if (pathAntigo && pathAntigo !== path) sb.storage.from(BUCKET).remove([ pathAntigo ]).catch(() => {});
            return path;
        } catch (error) {
            throw new Error(mensagemDeErro(error));
        }
    }

    async function remover(usuarioId, pathAntigo) {
        try {
            const { error } = await sb.rpc("definir_foto_perfil", { p_usuario: usuarioId, p_path: null });
            if (error) throw error;
            if (pathAntigo) sb.storage.from(BUCKET).remove([ pathAntigo ]).catch(() => {});
        } catch (error) {
            throw new Error(mensagemDeErro(error));
        }
    }

    async function fotoDe(usuarioId) {
        if (!sb || !usuarioId) return null;
        const { data } = await sb.from("perfis").select("foto_path").eq("id", usuarioId).maybeSingle();
        return data ? data.foto_path || null : null;
    }

    // Celular/tablet (tela de toque): mostra o botão "Tirar foto". No computador fica só a escolha de arquivo.
    function temCamera() {
        try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
    }

    // Quadro "Minha foto" (Configurações da Central, Minha conta do corretor).
    // opcoes: { usuarioId, nome, path, aoMudar(pathNovo) }
    function painel(container, opcoes) {
        if (!container) return;
        let path = opcoes.path || null;
        function desenhar(mensagem, erro) {
            container.innerHTML = `<div class="skl-foto-painel">${html(opcoes.nome, path, 72)}<div class="skl-foto-acoes">
              <strong>${esc(opcoes.nome || "")}</strong>
              <div class="skl-foto-botoes">${temCamera() ? `<button type="button" class="skl-foto-camera">Tirar foto</button>` : ""}<button type="button" class="skl-foto-trocar">${temCamera() ? "Escolher da galeria" : path ? "Trocar foto" : "Adicionar foto"}</button>${path ? `<button type="button" class="skl-foto-remover">Remover</button>` : ""}</div>
              <small class="skl-foto-msg${erro ? " erro" : ""}">${esc(mensagem || "A foto aparece para a equipe nas listas e cadastros.")}</small></div></div>`;
            aplicar(container);
            async function escolher(camera) {
                desenhar(camera ? "Abrindo a câmera…" : "Escolha uma foto na galeria…");
                try {
                    const novo = await trocar(opcoes.usuarioId, path, { camera });
                    if (!novo) { desenhar(); return; }
                    path = novo;
                    if (opcoes.aoMudar) opcoes.aoMudar(path);
                    desenhar("Foto atualizada.");
                } catch (error) { desenhar(error.message, true); }
            }
            container.querySelector(".skl-foto-trocar").addEventListener("click", () => escolher(false));
            const botaoCamera = container.querySelector(".skl-foto-camera");
            if (botaoCamera) botaoCamera.addEventListener("click", () => escolher(true));
            const botaoRemover = container.querySelector(".skl-foto-remover");
            if (botaoRemover) botaoRemover.addEventListener("click", async () => {
                try {
                    await remover(opcoes.usuarioId, path);
                    path = null;
                    if (opcoes.aoMudar) opcoes.aoMudar(null);
                    desenhar("Foto removida.");
                } catch (error) { desenhar(error.message, true); }
            });
        }
        desenhar();
    }

    // Monta o quadro buscando a foto atual da pessoa logada (para apps que não guardam isso em memória).
    async function painelDoUsuarioLogado(container, aoMudar) {
        if (!sb || !container) return;
        const { data } = await sb.auth.getUser();
        const user = data && data.user;
        if (!user) return;
        const nome = (user.user_metadata && user.user_metadata.nome_exibicao) || user.email || "";
        const path = await fotoDe(user.id);
        painel(container, { usuarioId: user.id, nome, path, aoMudar });
        return { usuarioId: user.id, nome, path };
    }

    window.SKLAvatar = {
        init(cliente) {
            const primeiraVez = !sb;
            sb = cliente;
            if (primeiraVez && document.body) new MutationObserver(agendarAplicar).observe(document.body, { childList: true, subtree: true });
            agendarAplicar();
        },
        html, aplicar, trocar, remover, fotoDe, painel, painelDoUsuarioLogado, iniciais
    };
})();
