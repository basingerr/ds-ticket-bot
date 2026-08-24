(() => {
  const MAP_SIZE = 32768;
  const TILE_MIN = -9655.77;
  const TILE_MAX = 12343.94;
  const TILE_RANGE = 20357.85;
  const INSIGHTS_BASE_URL = `${window.location.origin}/insights/deaths`;
  const causeLabels = {
    car: 'Транспорт', bullet: 'Огнестрел', fallDamage: 'Падение', unknown: 'Неизвестно',
    melee: 'Ближний бой', explosion: 'Взрыв', drown: 'Утопление', burn: 'Огонь',
  };
  const periods = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
  const state = { deaths: [], filtered: [], cause: 'all', period: 'all', radius: 22, showPoints: false };

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
  const dom = {
    causeList: document.querySelector('#cause-list'), period: document.querySelector('#period-filter'),
    radius: document.querySelector('#radius-filter'), radiusValue: document.querySelector('#radius-value'),
    points: document.querySelector('#points-toggle'), error: document.querySelector('#error-message'),
    status: document.querySelector('#data-status'), total: document.querySelector('#metric-total'),
    killed: document.querySelector('#metric-killed'), underground: document.querySelector('#metric-underground'),
    count: document.querySelector('#map-count'), reset: document.querySelector('#reset-view'),
    exportButton: document.querySelector('#export-button'), mapPanel: document.querySelector('#map-panel'),
  };

  function gtaToLatLng(x, y) {
    return map.unproject([((x - TILE_MIN) / TILE_RANGE) * MAP_SIZE, ((TILE_MAX - y) / TILE_RANGE) * MAP_SIZE], 7);
  }

  function fitMainIsland() {
    map.fitBounds(L.latLngBounds(gtaToLatLng(-4000, -4500), gtaToLatLng(4500, 8500)), { padding: [24, 24] });
  }

  function parseTimestamp(value) {
    return new Date(String(value).replace(' ', 'T') + 'Z');
  }

  function formatDate(value) {
    const date = parseTimestamp(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
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

  function showError(message) {
    dom.error.textContent = message;
    dom.error.hidden = !message;
    dom.status.classList.toggle('is-error', Boolean(message));
  }

  function filterData() {
    const latest = state.deaths.reduce((max, item) => Math.max(max, parseTimestamp(item.timestamp).getTime() || 0), 0);
    state.filtered = state.deaths.filter((item) => {
      if (state.cause !== 'all' && item.cause !== state.cause) return false;
      if (state.period === 'all' || !latest) return true;
      const timestamp = parseTimestamp(item.timestamp).getTime();
      return Number.isFinite(timestamp) && timestamp >= latest - periods[state.period];
    });
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

  function renderMap() {
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

  function update() {
    filterData();
    renderCauseList();
    renderMetrics();
    renderMap();
  }

  dom.period.addEventListener('change', () => { state.period = dom.period.value; update(); });
  dom.radius.addEventListener('input', () => { state.radius = Number(dom.radius.value); update(); });
  dom.points.addEventListener('change', () => { state.showPoints = dom.points.checked; update(); });
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

  fetch(`${INSIGHTS_BASE_URL}/data`, { cache: 'no-store' }).then((response) => {
    if (!response.ok) throw new Error(`Данные недоступны (${response.status})`);
    return response.json();
  }).then((input) => {
    state.deaths = parseDeaths(input);
    if (!state.deaths.length) throw new Error('В файле нет корректных событий');
    showError('');
    update();
  }).catch((error) => showError(error instanceof Error ? error.message : 'Не удалось загрузить данные'));
  fitMainIsland();
})();
