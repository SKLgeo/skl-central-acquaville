// SKL Soluções Digitais — Módulo genérico de Planta 3D interativa
//
// Reconstrói, com Three.js, o que o CV CRM (e sistemas similares de
// mercado) oferecem como "mapa 3D" de disponibilidade — mas com câmera
// de verdade (o usuário pode girar, inclinar, aproximar), coisa que nem
// o próprio CV CRM tem (lá é só uma imagem isométfica com pan/zoom).
//
// Genérico: recebe a imagem + os pontos de QUALQUER empreendimento — não
// depende de nada específico da Carmel. Um empreendimento sem plana 3D
// configurada (tabela mapas_3d) simplesmente não deve chamar init().
//
// Uso:
//   const mapa = SKLMapa3D.init(container, {
//     imagemUrl, larguraPx, alturaPx, pontos: [{lote_id,x,y}],
//     statusPorId: Map<loteId,status>,
//     corPorStatus: {disponivel:"#2f8a56", ...},
//     onSelecionar: (loteId) => {...},
//   });
//   mapa.atualizarStatus(loteId, "reservado");
//   mapa.destruir();
(function (global) {
  "use strict";

  const COR_PADRAO = {
    disponivel: "#2f8a56",
    reservado: "#d59a22",
    vendido: "#bd5147",
    bloqueado: "#477fa4",
    nao_informado: "#8a97a0",
  };

  function criarTexturaMarcador(cor, destacado) {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const cx = size / 2, cy = size / 2;

    // sombra suave (dá o "relevo" — o ponto parece flutuar sobre a planta)
    ctx.beginPath();
    ctx.arc(cx, cy + 6, size * 0.30, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(6,20,26,0.35)";
    ctx.filter = "blur(4px)";
    ctx.fill();
    ctx.filter = "none";

    // disco principal com leve gradiente (dá volume, não fica "chapado")
    const grad = ctx.createRadialGradient(cx - size * 0.12, cy - size * 0.14, size * 0.05, cx, cy, size * 0.32);
    grad.addColorStop(0, clarear(cor, 0.35));
    grad.addColorStop(1, cor);
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.30, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // anel branco
    ctx.lineWidth = size * 0.045;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    if (destacado) {
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.40, 0, Math.PI * 2);
      ctx.lineWidth = size * 0.03;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.stroke();
    }

    const tex = new global.THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  function clarear(hex, quantidade) {
    const n = parseInt(hex.replace("#", ""), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.min(255, Math.round(r + (255 - r) * quantidade));
    g = Math.min(255, Math.round(g + (255 - g) * quantidade));
    b = Math.min(255, Math.round(b + (255 - b) * quantidade));
    return `rgb(${r},${g},${b})`;
  }

  function init(container, opts) {
    const THREE = global.THREE;
    if (!THREE || !THREE.OrbitControls) {
      console.error("SKLMapa3D: THREE/OrbitControls não carregado.");
      return null;
    }

    const corPorStatus = Object.assign({}, COR_PADRAO, opts.corPorStatus || {});
    const larguraMundo = 100;
    const alturaMundo = larguraMundo * (opts.alturaPx / opts.larguraPx);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a2530);
    scene.fog = new THREE.Fog(0x0a2530, larguraMundo * 1.1, larguraMundo * 2.6);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    camera.position.set(0, alturaMundo * 0.85, alturaMundo * 0.95);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    container.innerHTML = "";
    container.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";

    // luz suave, só pra dar um pouco de profundidade nas bordas do plano
    scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.35);
    dirLight.position.set(larguraMundo * 0.3, larguraMundo * 0.6, larguraMundo * 0.2);
    scene.add(dirLight);

    const loader = new THREE.TextureLoader();
    loader.crossOrigin = "anonymous";
    const textura = loader.load(opts.imagemUrl, () => { renderNow(); });
    textura.colorSpace = THREE.SRGBColorSpace || textura.colorSpace;
    textura.anisotropy = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;

    const planoGeo = new THREE.PlaneGeometry(larguraMundo, alturaMundo, 1, 1);
    const planoMat = new THREE.MeshStandardMaterial({ map: textura, roughness: 1, metalness: 0 });
    const plano = new THREE.Mesh(planoGeo, planoMat);
    plano.rotation.x = -Math.PI / 2;
    scene.add(plano);

    // "borda"/base com leve espessura por baixo do plano — dá um efeito de
    // maquete física (relevo real), não uma folha de papel flutuando.
    const baseGeo = new THREE.BoxGeometry(larguraMundo + 1.2, 0.9, alturaMundo + 1.2);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x0c3e4a, roughness: 0.9 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = -0.5;
    scene.add(base);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = larguraMundo * 0.12;
    controls.maxDistance = larguraMundo * 1.6;
    controls.maxPolarAngle = Math.PI / 2.05; // não deixa passar por baixo do "chão"
    controls.update();

    const marcadores = [];
    const porLoteId = new Map();
    for (const ponto of opts.pontos || []) {
      const status = (opts.statusPorId && opts.statusPorId.get(ponto.lote_id)) || "nao_informado";
      const cor = corPorStatus[status] || corPorStatus.nao_informado;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: criarTexturaMarcador(cor, false), depthTest: true, sizeAttenuation: true }));
      const u = ponto.x / opts.larguraPx;
      const v = ponto.y / opts.alturaPx;
      sprite.position.set((u - 0.5) * larguraMundo, 0.8, (v - 0.5) * alturaMundo);
      const escala = larguraMundo * 0.018;
      sprite.scale.set(escala, escala, 1);
      sprite.userData.loteId = ponto.lote_id;
      sprite.userData.status = status;
      scene.add(sprite);
      marcadores.push(sprite);
      porLoteId.set(ponto.lote_id, sprite);
    }

    const raycaster = new THREE.Raycaster();
    const ponteiro = new THREE.Vector2();
    let ultimoHover = null;

    function calcularPonteiro(evento) {
      const rect = renderer.domElement.getBoundingClientRect();
      const cx = evento.touches ? evento.touches[0].clientX : evento.clientX;
      const cy = evento.touches ? evento.touches[0].clientY : evento.clientY;
      ponteiro.x = ((cx - rect.left) / rect.width) * 2 - 1;
      ponteiro.y = -((cy - rect.top) / rect.height) * 2 + 1;
    }

    function marcadorSobPonteiro() {
      raycaster.setFromCamera(ponteiro, camera);
      const hits = raycaster.intersectObjects(marcadores);
      return hits.length ? hits[0].object : null;
    }

    let arrastando = false;
    let downPos = null;
    renderer.domElement.addEventListener("pointerdown", (e) => { arrastando = false; downPos = { x: e.clientX, y: e.clientY }; });
    renderer.domElement.addEventListener("pointermove", (e) => {
      if (downPos && (Math.abs(e.clientX - downPos.x) > 4 || Math.abs(e.clientY - downPos.y) > 4)) arrastando = true;
      calcularPonteiro(e);
      const alvo = marcadorSobPonteiro();
      renderer.domElement.style.cursor = alvo ? "pointer" : "grab";
      if (alvo !== ultimoHover) {
        if (ultimoHover) ultimoHover.scale.set(larguraMundo * 0.018, larguraMundo * 0.018, 1);
        if (alvo) { const s = larguraMundo * 0.024; alvo.scale.set(s, s, 1); }
        ultimoHover = alvo;
      }
    });
    renderer.domElement.addEventListener("pointerup", (e) => {
      if (arrastando) return;
      calcularPonteiro(e);
      const alvo = marcadorSobPonteiro();
      if (alvo && typeof opts.onSelecionar === "function") opts.onSelecionar(alvo.userData.loteId);
    });

    let vivo = true;
    function renderNow() {
      if (!vivo) return;
      renderer.render(scene, camera);
    }
    function loop() {
      if (!vivo) return;
      controls.update();
      renderNow();
      requestAnimationFrame(loop);
    }

    function ajustarTamanho() {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      renderNow();
    }
    const resizeObserver = new global.ResizeObserver(ajustarTamanho);
    resizeObserver.observe(container);
    ajustarTamanho();
    loop();

    return {
      atualizarStatus(loteId, status) {
        const sprite = porLoteId.get(loteId);
        if (!sprite) return;
        const cor = corPorStatus[status] || corPorStatus.nao_informado;
        sprite.material.map = criarTexturaMarcador(cor, false);
        sprite.material.needsUpdate = true;
        sprite.userData.status = status;
        renderNow();
      },
      redimensionar: ajustarTamanho,
      destruir() {
        vivo = false;
        resizeObserver.disconnect();
        controls.dispose();
        renderer.dispose();
        planoGeo.dispose();
        planoMat.dispose();
        baseGeo.dispose();
        baseMat.dispose();
        marcadores.forEach((m) => { m.material.map && m.material.map.dispose(); m.material.dispose(); });
        container.innerHTML = "";
      },
    };
  }

  global.SKLMapa3D = { init };
})(window);
