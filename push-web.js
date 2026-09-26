// Notificação push pelo link/PWA (Web Push via Firebase Cloud Messaging) — só
// faz sentido num navegador de verdade; o exe (Electron) e o app Android nativo
// já têm seu próprio jeito de notificar (ou nunca tiveram, no caso da Central).
// Genérico por design: o token vai pra push_tokens igual o app nativo já faz,
// e o link que a notificação abre vem de empreendimentos.config.links_web —
// nada aqui é específico do Acquaville, outro cliente só precisa desse campo.
//
// IMPORTANTE: Notification.requestPermission() só funciona de verdade quando
// chamado bem na hora de um toque do usuário — se acontecer escondido no meio
// de várias chamadas assíncronas (ex.: depois de várias consultas ao banco no
// login), o Chrome/Android costuma ignorar o pedido sem nem mostrar a caixa de
// diálogo. Por isso o pedido de permissão só roda dentro do clique de um botão
// visível ("Ativar notificações"), nunca escondido dentro do fluxo de login.
(() => {
  "use strict";
  const isElectronApp = /Electron\//.test(navigator.userAgent);
  const isNativeCentralApp = Boolean(window.NativeBridge);
  if (isElectronApp || isNativeCentralApp) return;
  if (!("serviceWorker" in navigator) || !("Notification" in window) || !location.protocol.startsWith("http")) return;

  const firebaseConfig = {
    apiKey: "AIzaSyDAi87BQ_wf9gDn5H-Khqyl4cKf72UnmO4",
    authDomain: "app-impreendimentos.firebaseapp.com",
    projectId: "app-impreendimentos",
    storageBucket: "app-impreendimentos.firebasestorage.app",
    messagingSenderId: "525989169956",
    appId: "1:525989169956:web:f4a9329652d0367dd441b1",
  };
  const VAPID_KEY = "BK7NBwuwSb5ExS5SCnEkkkMeCnFCVHW_JWkTKuU0puBUXANFMCi2WulFTsNCcgfvrh8M8AIKhunTayGZw9kSUFs";

  let sbAtual = null;
  let usuarioIdAtual = null;

  function criarBanner() {
    if (document.getElementById("pushWebBanner")) return document.getElementById("pushWebBanner");
    const banner = document.createElement("div");
    banner.id = "pushWebBanner";
    banner.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;background:#163D26;color:#EFE1D5;border-radius:14px;padding:14px 16px;box-shadow:0 12px 32px rgba(0,0,0,.3);display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-family:Arial,Helvetica,sans-serif;";
    banner.innerHTML =
      '<span style="flex:1;min-width:200px;font-size:13px;line-height:1.4;">Ative as notificações para saber na hora de novidades.</span>' +
      '<button id="pushWebAtivarButton" type="button" style="background:#C9A063;color:#26332B;border:0;border-radius:9px;padding:9px 16px;font-weight:800;font-size:13px;cursor:pointer;">Ativar</button>' +
      '<button id="pushWebFecharButton" type="button" aria-label="Fechar" style="background:transparent;color:#EFE1D5;border:0;font-size:18px;cursor:pointer;padding:0 4px;">×</button>';
    document.body.appendChild(banner);
    return banner;
  }

  async function registrarToken() {
    if (!window.firebase || !sbAtual || !usuarioIdAtual) return false;
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const messaging = firebase.messaging();
    const registration = await navigator.serviceWorker.register("./sw.js");
    const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    if (!token) return false;
    await sbAtual.from("push_tokens").upsert(
      { usuario_id: usuarioIdAtual, token, plataforma: "web", atualizado_em: new Date().toISOString() },
      { onConflict: "token" },
    );
    return true;
  }

  async function ativarClicado() {
    const banner = document.getElementById("pushWebBanner");
    const botao = document.getElementById("pushWebAtivarButton");
    if (botao) { botao.disabled = true; botao.textContent = "Ativando…"; }
    try {
      const permissao = await Notification.requestPermission();
      if (permissao === "granted") {
        await registrarToken();
      }
    } catch (error) {
      console.error("Falha ao registrar push web:", error);
    } finally {
      if (banner) banner.remove();
    }
  }

  function oferecer(sb, usuarioId) {
    if (!usuarioId) return;
    sbAtual = sb;
    usuarioIdAtual = usuarioId;
    if (Notification.permission === "denied") return;
    if (Notification.permission === "granted") {
      registrarToken().catch((error) => console.error("Falha ao registrar push web:", error));
      return;
    }
    const banner = criarBanner();
    banner.querySelector("#pushWebAtivarButton").addEventListener("click", ativarClicado);
    banner.querySelector("#pushWebFecharButton").addEventListener("click", () => banner.remove());
  }

  window.SKLPushWeb = { oferecer };
})();
