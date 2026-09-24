// Botão "Baixar / Instalar aplicativo" + registro do service worker (só na tela de login).
// Android (Chrome/Edge): usa o instalador do navegador (beforeinstallprompt).
// iPhone/iPad (Safari): não existe instalador automático — mostra o passo a passo
// "Compartilhar → Adicionar à Tela de Início".
(() => {
  "use strict";
  const isElectronApp = /Electron\//.test(navigator.userAgent);
  const isNativeCentralApp = Boolean(window.NativeBridge);
  if (isElectronApp || isNativeCentralApp) return; // já é o app instalado (exe/apk) — nada de instalar de novo

  const boxes = Array.from(document.querySelectorAll(".install-box"));
  const dialog = document.getElementById("installDialog");
  const instructions = document.getElementById("installInstructions");
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isInAppBrowser = /FBAN|FBAV|Instagram|WhatsApp|Line\/|MicroMessenger|Snapchat|; wv\)/i.test(ua);
  let deferredPrompt = null;

  function hintText() {
    if (isIOS) return "No iPhone/iPad: toque em Compartilhar e depois em “Adicionar à Tela de Início”.";
    return "Instale no seu celular ou computador para abrir como um aplicativo, sem precisar do navegador.";
  }

  function instructionsHtml() {
    if (isIOS) {
      return "No <strong>Safari</strong>, toque no ícone <strong>Compartilhar</strong> (o quadrado com a seta para cima) e escolha <strong>Adicionar à Tela de Início</strong>." +
        (isInAppBrowser ? "<br><br>Você abriu o link dentro de outro aplicativo. Toque em “Abrir no Safari” (ou copie o link e cole no Safari) e repita o passo acima." : "<br><br>Se estiver usando o Chrome, abra este mesmo link no Safari.");
    }
    return "Abra o menu do navegador (⋮) e escolha <strong>Instalar aplicativo</strong> ou <strong>Adicionar à tela inicial</strong>." +
      (isInAppBrowser ? "<br><br>Você abriu o link dentro de outro aplicativo. Abra no <strong>Chrome</strong> para conseguir instalar." : "");
  }

  function mostrarBoxes() {
    boxes.forEach((box) => {
      const hint = box.querySelector(".install-hint");
      if (hint) hint.textContent = hintText();
      box.hidden = false;
    });
  }

  if (!isStandalone) mostrarBoxes();

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    if (!isStandalone) mostrarBoxes();
  });

  document.querySelectorAll(".install-button").forEach((button) => {
    button.addEventListener("click", async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch {}
        deferredPrompt = null;
        return;
      }
      instructions.innerHTML = instructionsHtml();
      if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    });
  });

  const fechar = document.getElementById("installDialogClose");
  if (fechar && dialog) fechar.addEventListener("click", () => dialog.close());

  window.addEventListener("appinstalled", () => boxes.forEach((box) => { box.hidden = true; }));

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
})();
