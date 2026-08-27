// Shared Leaflet base map for Insights map pages (death map, content map).
// Keeps the GTA V -> Leaflet projection and HD atlas tile setup in one place.
(() => {
  const MAP_SIZE = 32768;
  const TILE_MIN = -9655.77;
  const TILE_MAX = 12343.94;
  const TILE_RANGE = 20357.85;

  function createBaseMap(options) {
    const { elementId, tilesUrl, emptyTileUrl } = options;
    const map = L.map(elementId, {
      crs: L.CRS.Simple,
      minZoom: 2,
      maxZoom: 8,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    });

    const fullBounds = L.latLngBounds(map.unproject([0, MAP_SIZE], 7), map.unproject([MAP_SIZE, 0], 7));
    L.tileLayer(tilesUrl, {
      minZoom: 2,
      maxNativeZoom: 6,
      maxZoom: 8,
      noWrap: true,
      bounds: fullBounds,
      errorTileUrl: emptyTileUrl,
      keepBuffer: 3,
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.setMaxBounds(fullBounds.pad(0.08));

    function gtaToLatLng(x, y) {
      return map.unproject(
        [((x - TILE_MIN) / TILE_RANGE) * MAP_SIZE, ((TILE_MAX - y) / TILE_RANGE) * MAP_SIZE],
        7,
      );
    }

    function fitMainIsland() {
      map.fitBounds(L.latLngBounds(gtaToLatLng(-4000, -4500), gtaToLatLng(4500, 8500)), {
        padding: [24, 24],
      });
    }

    return { map, fullBounds, gtaToLatLng, fitMainIsland, MAP_SIZE };
  }

  window.InsightsMapCore = { createBaseMap, MAP_SIZE };
})();
