// Notificação push pelo link/PWA (Web Push via Firebase Cloud Messaging) — só
// faz sentido num navegador de verdade; o exe (Electron) e o app Android nativo
// já têm seu próprio jeito de notificar (ou nunca tiveram, no caso da Central).
// Genérico por design: o token vai pra push_tokens igual o app nativo já faz,
// e o link que a notificação abre vem de empreendimentos.config.links_web —
// nada aqui é específico do Acquaville, outro cliente só precisa desse campo.
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

  let iniciado = false;

  async function registrar(sb, usuarioId) {
    if (iniciado || !usuarioId) return;
    if (!window.firebase || Notification.permission === "denied") return;
    try {
      const permissao = await Notification.requestPermission();
      if (permissao !== "granted") return;

      if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
      const messaging = firebase.messaging();
      const registration = await navigator.serviceWorker.register("./sw.js");
      const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
      if (!token) return;

      await sb.from("push_tokens").upsert(
        { usuario_id: usuarioId, token, plataforma: "web", atualizado_em: new Date().toISOString() },
        { onConflict: "token" },
      );
      iniciado = true;
    } catch (error) {
      console.error("Falha ao registrar push web:", error);
    }
  }

  window.SKLPushWeb = { registrar };
})();
