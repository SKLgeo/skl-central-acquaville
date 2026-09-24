(function (global) {
  "use strict";
  // Mapa interativo simples: imagem (planta artistica) + marcadores clicaveis,
  // usando o Leaflet (mesma biblioteca do mapa de satelite do app) com
  // CRS.Simple (coordenadas em pixel da imagem, sem geografia real). Vista
  // sempre de cima, sem rotacao/inclinacao possivel — so pan e zoom.
  //
  // Cada ponto em opts.pontos pode ser de dois tipos:
  //   { tipo: "lote", lote_id, x, y } (tipo omitido = "lote", compatibilidade
  //     com pontos antigos) — abre a ficha/reserva do lote ao clicar.
  //   { tipo: "informativo", id, titulo, imagem_url, x, y } — nao esta
  //     amarrado a nenhum lote (ex.: quiosque, area comum); ao clicar mostra
  //     uma foto/legenda em vez da ficha de reserva.
  //
  // Modo edicao (opts.editavel = true, só usado pelo editor interno da
  // Central Windows): marcadores ficam arrastaveis, clicar num marcador
  // chama onEditarPonto em vez de abrir a ficha/foto, e clicar em area vazia
  // do mapa chama onCriarPonto(x, y). A instancia retornada ganha metodos
  // extras (adicionarMarcador/redesenharMarcador/removerMarcador) pra o
  // editor manter o mapa em sincronia com a lista de pontos que ele edita.
  var CORES = {
    disponivel: "#2f8a56",
    reservado: "#d59a22",
    vendido: "#bd5147",
    bloqueado: "#4d83bd",
    nao_informado: "#8a8a8a"
  };
  var COR_INFORMATIVO = "#c9a063";

  function iconeInformativo(selecionado) {
    return L.divIcon({
      className: "mapa-imagem-marcador-info",
      html: '<span style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:' + COR_INFORMATIVO + ';border:2px solid ' + (selecionado ? "#ffe08a" : "#fff") + ';box-shadow:0 2px 6px rgba(0,0,0,.35);color:#fff;font-size:14px;">&#128247;</span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
  }
  function iconeLote(cor, selecionado) {
    return L.divIcon({
      className: "mapa-imagem-marcador-lote",
      html: '<span style="display:block;width:22px;height:22px;border-radius:50%;background:' + cor + ';border:2px solid ' + (selecionado ? "#ffe08a" : "#fff") + ';box-shadow:0 2px 6px rgba(0,0,0,.35);"></span>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
  }

  function init(container, opts) {
    container.innerHTML = "";
    var w = opts.larguraPx, h = opts.alturaPx;
    var bounds = [[0, 0], [h, w]];
    var editavel = !!opts.editavel;

    var map = L.map(container, {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 5,
      zoomSnap: 0.1,
      zoomDelta: 0.6,
      attributionControl: false,
      zoomControl: false
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.imageOverlay(opts.imagemUrl, bounds).addTo(map);
    map.setMaxBounds(bounds);
    map.fitBounds(bounds, { padding: [10, 10] });

    var marcadoresPorLote = new Map();
    var marcadoresPorPonto = new Map(); // ponto (referencia do objeto) -> L.Marker, só em modo editavel

    function corDoPonto(ponto) {
      if (ponto.tipo === "informativo") return null;
      var status = (opts.statusPorId && opts.statusPorId.get(ponto.lote_id)) || "nao_informado";
      return CORES[status] || CORES.nao_informado;
    }

    function criarMarcador(ponto) {
      var latlng = [h - ponto.y, ponto.x];
      var icone = ponto.tipo === "informativo" ? iconeInformativo(false) : iconeLote(corDoPonto(ponto), false);
      var marker = L.marker(latlng, { icon: icone, draggable: editavel }).addTo(map);

      if (editavel) {
        marker.on("click", function (e) {
          L.DomEvent.stopPropagation(e);
          if (typeof opts.onEditarPonto === "function") opts.onEditarPonto(ponto, marker);
        });
        marker.on("dragend", function () {
          var ll = marker.getLatLng();
          var x = Math.round(ll.lng), y = Math.round(h - ll.lat);
          if (typeof opts.onMoverPonto === "function") opts.onMoverPonto(ponto, x, y);
        });
        marcadoresPorPonto.set(ponto, marker);
        return marker;
      }

      if (ponto.tipo === "informativo") {
        marker.on("click", function () {
          if (typeof opts.onAbrirInformativo === "function") opts.onAbrirInformativo(ponto);
        });
        return marker;
      }
      marker.on("click", function () {
        if (typeof opts.onSelecionar === "function") opts.onSelecionar(ponto.lote_id);
      });
      marcadoresPorLote.set(ponto.lote_id, marker);
      return marker;
    }

    (opts.pontos || []).forEach(criarMarcador);

    if (editavel) {
      map.on("click", function (e) {
        var x = Math.round(e.latlng.lng), y = Math.round(h - e.latlng.lat);
        if (x < 0 || x > w || y < 0 || y > h) return;
        if (typeof opts.onCriarPonto === "function") opts.onCriarPonto(x, y);
      });
    }

    return {
      atualizarStatus: function (loteId, status) {
        var marker = marcadoresPorLote.get(loteId);
        if (!marker) return;
        var cor = CORES[status] || CORES.nao_informado;
        marker.setIcon(iconeLote(cor, false));
      },
      adicionarMarcador: function (ponto) {
        return criarMarcador(ponto);
      },
      redesenharMarcador: function (ponto) {
        var marker = marcadoresPorPonto.get(ponto);
        if (!marker) return;
        marker.setIcon(ponto.tipo === "informativo" ? iconeInformativo(false) : iconeLote(corDoPonto(ponto), false));
      },
      destacarMarcador: function (pontoOuNull) {
        marcadoresPorPonto.forEach(function (marker, ponto) {
          marker.setIcon(ponto.tipo === "informativo" ? iconeInformativo(ponto === pontoOuNull) : iconeLote(corDoPonto(ponto), ponto === pontoOuNull));
        });
      },
      removerMarcador: function (ponto) {
        var marker = marcadoresPorPonto.get(ponto);
        if (!marker) return;
        map.removeLayer(marker);
        marcadoresPorPonto.delete(ponto);
      },
      destruir: function () {
        map.remove();
      }
    };
  }

  global.SKLMapaImagem = { init: init };
})(window);
