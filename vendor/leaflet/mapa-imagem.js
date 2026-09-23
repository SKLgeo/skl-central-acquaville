(function (global) {
  "use strict";
  // Mapa interativo simples: imagem (planta artistica) + marcadores clicaveis,
  // usando o Leaflet (mesma biblioteca do mapa de satelite do app) com
  // CRS.Simple (coordenadas em pixel da imagem, sem geografia real). Vista
  // sempre de cima, sem rotacao/inclinacao possivel — so pan e zoom.
  var CORES = {
    disponivel: "#2f8a56",
    reservado: "#d59a22",
    vendido: "#bd5147",
    bloqueado: "#4d83bd",
    nao_informado: "#8a8a8a"
  };

  function init(container, opts) {
    container.innerHTML = "";
    var w = opts.larguraPx, h = opts.alturaPx;
    var bounds = [[0, 0], [h, w]];

    var map = L.map(container, {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 4,
      zoomSnap: 0.1,
      zoomDelta: 0.6,
      attributionControl: false,
      zoomControl: false
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.imageOverlay(opts.imagemUrl, bounds).addTo(map);
    map.setMaxBounds(bounds);
    map.fitBounds(bounds, { padding: [10, 10] });

    var marcadores = new Map();
    (opts.pontos || []).forEach(function (ponto) {
      var status = (opts.statusPorId && opts.statusPorId.get(ponto.lote_id)) || "nao_informado";
      var cor = CORES[status] || CORES.nao_informado;
      var marker = L.circleMarker([h - ponto.y, ponto.x], {
        radius: 11,
        color: "#ffffff",
        weight: 2,
        fillColor: cor,
        fillOpacity: 1,
        bubblingMouseEvents: false
      }).addTo(map);
      marker.on("click", function () {
        if (typeof opts.onSelecionar === "function") opts.onSelecionar(ponto.lote_id);
      });
      marcadores.set(ponto.lote_id, marker);
    });

    return {
      atualizarStatus: function (loteId, status) {
        var marker = marcadores.get(loteId);
        if (!marker) return;
        var cor = CORES[status] || CORES.nao_informado;
        marker.setStyle({ fillColor: cor });
      },
      destruir: function () {
        map.remove();
      }
    };
  }

  global.SKLMapaImagem = { init: init };
})(window);
