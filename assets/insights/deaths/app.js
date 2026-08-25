(() => {
  const MAP_SIZE = 32768;
  const TILE_MIN = -9655.77;
  const TILE_MAX = 12343.94;
  const TILE_RANGE = 20357.85;
  const INSIGHTS_BASE_URL = `${window.location.origin}/insights/deaths`;
  const HOTSPOT_RADIUS = 100;
  const causeLabels = {
    car: 'Транспорт', bullet: 'Огнестрел', fallDamage: 'Падение', unknown: 'Неизвестно',
    melee: 'Ближний бой', explosion: 'Взрыв', drown: 'Утопление', burn: 'Огонь',
  };
  const kindLabels = {
    job: 'Работа', service: 'Сервис', vehicles: 'Транспорт', housing: 'Жильё',
    activity: 'Активность', faction: 'Фракция', publicTransport: 'Общественный транспорт',
  };
  const kindColors = {
    job: '#42b7ff', service: '#64d99d', vehicles: '#ffbd59', housing: '#b58cff',
    activity: '#ff7895', faction: '#73a6ff', publicTransport: '#56d4d8',
  };
  const periods = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
  const state = {
    deaths: [], filtered: [], context: { pois: [], zones: [] }, cause: 'all', period: 'all',
    radius: 22, showPoints: false, showPois: false, showZones: false, showAtms: false,
    timeline: 100, playbackTimer: null,
  };

  const map = L.map('map', {
    crs: L.CRS.Simple, minZoom: 2, maxZoom: 8, zoomControl: false,
    attributionControl: false, preferCanvas: true,
  });
  const fullBounds = L.latLngBounds(map.unproject([0, MAP_SIZE], 7), map.unproject([MAP_SIZE, 0], 7));
  L.tileLayer(`${INSIGHTS_BASE_URL}/tiles/{z}_{x}_{y}.jpg`, {
    minZoom: 2, maxNativeZoom: 6, maxZoom: 8, noWrap: true, bounds: fullBounds,
    errorTileUrl: `${INSIGHTS_BASE_URL}/tiles/empty.jpg`, keepBuffer: 3,
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.setMaxBounds(fullBounds.pad(0.08));

  let heatLayer = null;
  let pointsLayer = null;
  let poiLayer = null;
  let zonesLayer = null;
  const dom = {
    causeList: document.querySelector('#cause-list'), period: document.querySelector('#period-filter'),
    timeline: document.querySelector('#timeline-filter'), timelineValue: document.querySelector('#timeline-value'),
    timelinePlay: document.querySelector('#timeline-play'), radius: document.querySelector('#radius-filter'),
    radiusValue: document.querySelector('#radius-value'), points: document.querySelector('#points-toggle'),
    pois: document.querySelector('#poi-toggle'), zones: document.querySelector('#zones-toggle'),
    atms: document.querySelector('#atms-toggle'), error: document.querySelector('#error-message'),
    status: document.querySelector('#data-status'), total: document.querySelector('#metric-total'),
    killed: document.querySelector('#metric-killed'), underground: document.querySelector('#metric-underground'),
    count: document.querySelector('#map-count'), reset: document.querySelector('#reset-view'),
    exportButton: document.querySelector('#export-button'), mapPanel: document.querySelector('#map-panel'),
    hotspots: document.querySelector('#hotspots-list'), contextCount: document.querySelector('#context-count'),
  };

  function gtaToLatLng(x, y) {
    return map.unproject([((x - TILE_MIN) / TILE_RANGE) * MAP_SIZE, ((TILE_MAX - y) / TILE_RANGE) * MAP_SIZE], 7);
  }

  function fitMainIsland() {
    map.fitBounds(L.latLngBounds(gtaToLatLng(-4000, -4500), gtaToLatLng(4500, 8500)), { padding: [24, 24] });
  }

  function parseTimestamp(value) {
    const text = String(value || '').trim().replace(' ', 'T');
    return new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(text) ? text : `${text}Z`);
  }

  function formatDate(value) {
    const date = parseTimestamp(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
  }

  function parseDeaths(input) {
    const rows = Array.isArray(input) ? input : input && input.data;
    if (!Array.isArray(rows)) throw new Error('В ответе нет массива событий');
    return rows.filter((row) => Number.isFinite(Number(row.pos_x)) && Number.isFinite(Number(row.pos_y))
      && Number.isFinite(Number(row.pos_z)) && typeof row.cause === 'string')
      .map((row) => ({
        cause: row.cause, pos_x: Number(row.pos_x), pos_y: Number(row.pos_y), pos_z: Number(row.pos_z),
        timestamp: String(row.timestamp || ''), killed_by_player: Boolean(row.killed_by_player),
      }));
  }

  function parseContext(input) {
    if (!input || !Array.isArray(input.pois) || !Array.isArray(input.zones)) throw new Error('Контекст карты недоступен');
    return { pois: input.pois, zones: input.zones };
  }

  function showError(message) {
    dom.error.textContent = message;
    dom.error.hidden = !message;
    dom.status.classList.toggle('is-error', Boolean(message));
  }

  function periodFilteredDeaths() {
    const latest = state.deaths.reduce((max, item) => Math.max(max, parseTimestamp(item.timestamp).getTime() || 0), 0);
    return state.deaths.filter((item) => {
      if (state.cause !== 'all' && item.cause !== state.cause) return false;
      if (state.period === 'all' || !latest) return true;
      const timestamp = parseTimestamp(item.timestamp).getTime();
      return Number.isFinite(timestamp) && timestamp >= latest - periods[state.period];
    });
  }

  function filterData() {
    const candidates = periodFilteredDeaths();
    const times = candidates.map((item) => parseTimestamp(item.timestamp).getTime()).filter(Number.isFinite);
    const min = times.length ? Math.min(...times) : 0;
    const max = times.length ? Math.max(...times) : 0;
    if (state.timeline >= 100 || !min || min === max) {
      state.filtered = candidates;
      dom.timelineValue.textContent = 'Все события';
      return;
    }
    const cutoff = min + (max - min) * (state.timeline / 100);
    state.filtered = candidates.filter((item) => parseTimestamp(item.timestamp).getTime() <= cutoff);
    dom.timelineValue.textContent = formatDate(new Date(cutoff).toISOString());
  }

  function renderCauseList() {
    dom.causeList.querySelectorAll('button').forEach((button) => button.remove());
    const counts = new Map();
    state.deaths.forEach((item) => counts.set(item.cause, (counts.get(item.cause) || 0) + 1));
    const choices = [['all', state.deaths.length], ...[...counts.entries()].sort((a, b) => b[1] - a[1])];
    choices.forEach(([name, count]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = state.cause === name ? 'active' : '';
      const label = document.createElement('span');
      label.textContent = name === 'all' ? 'Все причины' : (causeLabels[name] || name);
      const amount = document.createElement('b');
      amount.textContent = Number(count).toLocaleString('ru-RU');
      button.append(label, amount);
      button.addEventListener('click', () => { state.cause = name; update(); });
      dom.causeList.append(button);
    });
  }

  function renderMetrics() {
    dom.total.textContent = state.filtered.length.toLocaleString('ru-RU');
    dom.killed.textContent = state.filtered.filter((item) => item.killed_by_player).length.toLocaleString('ru-RU');
    dom.underground.textContent = state.filtered.filter((item) => item.pos_z < 0).length.toLocaleString('ru-RU');
    dom.count.textContent = `${state.filtered.length.toLocaleString('ru-RU')} событий`;
    dom.radiusValue.textContent = String(state.radius);
  }

  function renderHeatmap() {
    if (heatLayer) heatLayer.remove();
    if (pointsLayer) pointsLayer.remove();
    heatLayer = L.heatLayer(state.filtered.map((item) => {
      const point = gtaToLatLng(item.pos_x, item.pos_y);
      return [point.lat, point.lng, 0.55];
    }), {
      radius: state.radius, blur: Math.round(state.radius * 0.72), maxZoom: 8, minOpacity: 0.22,
      gradient: { 0.18: '#2d8cff', 0.42: '#21d4c2', 0.65: '#f5d547', 0.82: '#ff8a35', 1: '#ff3155' },
    }).addTo(map);

    if (state.showPoints) {
      pointsLayer = L.layerGroup();
      const renderer = L.canvas({ padding: 0.5 });
      state.filtered.forEach((item) => {
        L.circleMarker(gtaToLatLng(item.pos_x, item.pos_y), {
          renderer, radius: 3, weight: 1, color: '#ffffff', fillColor: '#ff3155', fillOpacity: 0.82,
        }).bindPopup(`<strong>${escapeHtml(causeLabels[item.cause] || item.cause)}</strong><br>X ${item.pos_x.toFixed(1)} · Y ${item.pos_y.toFixed(1)} · Z ${item.pos_z.toFixed(1)}<br>${escapeHtml(formatDate(item.timestamp))}`)
          .addTo(pointsLayer);
      });
      pointsLayer.addTo(map);
    }
  }

  function circleZonePoints(shape) {
    return Array.from({ length: 48 }, (_, index) => {
      const angle = (index / 48) * Math.PI * 2;
      return gtaToLatLng(shape.x + Math.cos(angle) * shape.radius, shape.y + Math.sin(angle) * shape.radius);
    });
  }

  function renderContextLayers() {
    if (poiLayer) poiLayer.remove();
    if (zonesLayer) zonesLayer.remove();
    poiLayer = L.layerGroup();
    zonesLayer = L.layerGroup();

    if (state.showPois || state.showAtms) {
      const renderer = L.canvas({ padding: 0.4 });
      state.context.pois.filter((poi) => poi.group === 'atm' ? state.showAtms : state.showPois).forEach((poi) => {
        const color = kindColors[poi.kind] || '#cbd2da';
        const popup = `<strong>${escapeHtml(poi.label)}</strong><br>${escapeHtml(kindLabels[poi.kind] || poi.kind)}<br>X ${poi.position.x.toFixed(1)} · Y ${poi.position.y.toFixed(1)}`;
        const position = gtaToLatLng(poi.position.x, poi.position.y);
        if (map.getZoom() >= 5 && poi.icon) {
          const iconUrl = `${INSIGHTS_BASE_URL}/icons/${encodeURIComponent(poi.icon)}.svg`;
          const icon = L.divIcon({
            className: 'poi-blip-shell',
            html: `<span class="poi-blip" style="--poi-color:${color}"><img src="${iconUrl}" alt=""></span>`,
            iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -13],
          });
          L.marker(position, { icon }).bindPopup(popup).addTo(poiLayer);
        } else {
          L.circleMarker(position, {
            renderer, radius: poi.group === 'atm' ? 3 : 5, weight: 1, color: '#071018', fillColor: color, fillOpacity: 0.9,
          }).bindPopup(popup).addTo(poiLayer);
        }
      });
      poiLayer.addTo(map);
    }

    if (state.showZones) {
      state.context.zones.forEach((zone) => {
        const points = zone.shape.kind === 'circle'
          ? circleZonePoints(zone.shape)
          : zone.shape.points.map((point) => gtaToLatLng(point.x, point.y));
        const color = zone.kind === 'safe' ? '#64d99d' : '#73a6ff';
        L.polygon(points, { color, weight: 1.5, opacity: 0.9, fillColor: color, fillOpacity: 0.12 })
          .bindPopup(`<strong>${escapeHtml(zone.label)}</strong><br>${zone.kind === 'safe' ? 'Safe-зона' : 'Полицейская территория'}`)
          .addTo(zonesLayer);
      });
      zonesLayer.addTo(map);
    }
  }

  function deathsNearPoi(poi) {
    return state.filtered.reduce((count, death) => {
      if (Math.abs(death.pos_z - poi.position.z) > 80) return count;
      return count + (Math.hypot(death.pos_x - poi.position.x, death.pos_y - poi.position.y) <= HOTSPOT_RADIUS ? 1 : 0);
    }, 0);
  }

  function renderHotspots() {
    dom.hotspots.replaceChildren();
    const ranked = state.context.pois.filter((poi) => poi.group !== 'atm')
      .map((poi) => ({ poi, deaths: deathsNearPoi(poi) }))
      .filter((item) => item.deaths > 0)
      .sort((left, right) => right.deaths - left.deaths || left.poi.label.localeCompare(right.poi.label, 'ru'))
      .slice(0, 5);
    dom.contextCount.textContent = state.context.pois.length
      ? `${state.context.pois.length} POI · ${state.context.zones.length} зоны`
      : 'Контекст недоступен';
    if (!ranked.length) {
      const item = document.createElement('li');
      item.className = 'empty-hotspot';
      item.textContent = 'Нет смертей рядом с POI';
      dom.hotspots.append(item);
      return;
    }
    ranked.forEach(({ poi, deaths }) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.innerHTML = `<span><strong>${escapeHtml(poi.label)}</strong><small>${escapeHtml(kindLabels[poi.kind] || poi.kind)}</small></span><b>${deaths}</b>`;
      button.addEventListener('click', () => map.setView(gtaToLatLng(poi.position.x, poi.position.y), 7));
      item.append(button);
      dom.hotspots.append(item);
    });
  }

  function update(options = {}) {
    filterData();
    renderCauseList();
    renderMetrics();
    renderHeatmap();
    if (options.hotspots !== false) renderHotspots();
  }

  function stopPlayback() {
    if (state.playbackTimer) window.clearInterval(state.playbackTimer);
    state.playbackTimer = null;
    dom.timelinePlay.textContent = 'Воспроизвести';
  }

  dom.period.addEventListener('change', () => { state.period = dom.period.value; state.timeline = 100; dom.timeline.value = '100'; update(); });
  dom.timeline.addEventListener('input', () => { state.timeline = Number(dom.timeline.value); stopPlayback(); update(); });
  dom.timelinePlay.addEventListener('click', () => {
    if (state.playbackTimer) { stopPlayback(); return; }
    if (state.timeline >= 100) { state.timeline = 0; dom.timeline.value = '0'; update(); }
    dom.timelinePlay.textContent = 'Пауза';
    state.playbackTimer = window.setInterval(() => {
      state.timeline = Math.min(100, state.timeline + 2);
      dom.timeline.value = String(state.timeline);
      update({ hotspots: state.timeline % 10 === 0 || state.timeline >= 100 });
      if (state.timeline >= 100) stopPlayback();
    }, 140);
  });
  dom.radius.addEventListener('input', () => { state.radius = Number(dom.radius.value); update(); });
  dom.points.addEventListener('change', () => { state.showPoints = dom.points.checked; update(); });
  dom.pois.addEventListener('change', () => { state.showPois = dom.pois.checked; renderContextLayers(); });
  dom.zones.addEventListener('change', () => { state.showZones = dom.zones.checked; renderContextLayers(); });
  dom.atms.addEventListener('change', () => { state.showAtms = dom.atms.checked; renderContextLayers(); });
  map.on('zoomend', () => { if (state.showPois || state.showAtms) renderContextLayers(); });
  dom.reset.addEventListener('click', fitMainIsland);
  dom.exportButton.addEventListener('click', async () => {
    dom.exportButton.disabled = true;
    dom.exportButton.textContent = 'Экспорт…';
    try {
      const canvas = await html2canvas(dom.mapPanel, { useCORS: true, backgroundColor: '#071018', scale: 2 });
      const link = document.createElement('a');
      link.download = `rejoin-deaths-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch {
      showError('Не удалось экспортировать карту');
    } finally {
      dom.exportButton.disabled = false;
      dom.exportButton.textContent = 'Экспорт PNG';
    }
  });

  Promise.all([
    fetch(`${INSIGHTS_BASE_URL}/data`, { cache: 'no-store' }).then((response) => {
      if (!response.ok) throw new Error(`Данные недоступны (${response.status})`);
      return response.json();
    }),
    fetch(`${INSIGHTS_BASE_URL}/context?v=2`).then((response) => response.ok ? response.json() : null),
  ]).then(([deathsInput, contextInput]) => {
    state.deaths = parseDeaths(deathsInput);
    if (!state.deaths.length) throw new Error('В файле нет корректных событий');
    if (contextInput) state.context = parseContext(contextInput);
    showError('');
    update();
  }).catch((error) => showError(error instanceof Error ? error.message : 'Не удалось загрузить данные'));
  fitMainIsland();
})();
