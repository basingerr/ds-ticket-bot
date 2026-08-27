(() => {
  const BASE_URL = `${window.location.origin}/insights/map`;
  const kindLabels = {
    job: 'Работа', service: 'Сервис', vehicles: 'Транспорт', housing: 'Жильё',
    activity: 'Активность', faction: 'Фракция', publicTransport: 'Транспорт (общ.)',
  };
  const kindColors = {
    job: '#42b7ff', service: '#64d99d', vehicles: '#ffbd59', housing: '#b58cff',
    activity: '#ff7895', faction: '#73a6ff', publicTransport: '#56d4d8',
  };
  const kindOrder = ['job', 'service', 'vehicles', 'housing', 'activity', 'faction', 'publicTransport'];
  const metaTypeLabels = {
    jobStart: 'Точка старта работы', metroStation: 'Станция метро',
    motel: 'Мотель', hotel: 'Отель', vehicleShop: 'Автосалон',
  };
  const LIST_LIMIT = 250;

  const state = {
    pois: [], zones: [],
    enabled: new Set(kindOrder),
    search: '',
    showSafe: false, showPolice: false,
    markers: new Map(),
  };

  const dom = {
    sourceName: document.querySelector('#source-name'),
    status: document.querySelector('#data-status'),
    error: document.querySelector('#error-message'),
    metricVisible: document.querySelector('#metric-visible'),
    metricCategories: document.querySelector('#metric-categories'),
    metricZones: document.querySelector('#metric-zones'),
    search: document.querySelector('#search-input'),
    categoryList: document.querySelector('#category-list'),
    toggleAll: document.querySelector('#category-toggle-all'),
    safe: document.querySelector('#safe-toggle'),
    police: document.querySelector('#police-toggle'),
    list: document.querySelector('#poi-list'),
    listCount: document.querySelector('#list-count'),
    mapCount: document.querySelector('#map-count'),
    reset: document.querySelector('#reset-view'),
    exportButton: document.querySelector('#export-button'),
    mapPanel: document.querySelector('#map-panel'),
  };

  const { map, gtaToLatLng, fitMainIsland } = window.InsightsMapCore.createBaseMap({
    elementId: 'map',
    tilesUrl: `${BASE_URL}/tiles/{z}_{x}_{y}.jpg`,
    emptyTileUrl: `${BASE_URL}/tiles/empty.jpg`,
  });

  let poiLayer = null;
  let zonesLayer = null;

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
  }

  function showError(message) {
    dom.error.textContent = message || '';
    dom.error.hidden = !message;
    dom.status.classList.toggle('is-error', Boolean(message));
  }

  function countsByKind() {
    const counts = new Map();
    state.pois.forEach((poi) => counts.set(poi.kind, (counts.get(poi.kind) || 0) + 1));
    return counts;
  }

  function filteredPois() {
    const needle = state.search.trim().toLowerCase();
    return state.pois.filter((poi) => {
      if (!state.enabled.has(poi.kind)) return false;
      if (needle && !poi.label.toLowerCase().includes(needle)) return false;
      return true;
    });
  }

  function syncUrl() {
    const params = new URLSearchParams();
    if (state.enabled.size !== kindOrder.length) {
      params.set('cat', kindOrder.filter((kind) => state.enabled.has(kind)).join(','));
    }
    if (state.search.trim()) params.set('q', state.search.trim());
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  }

  function popupHtml(poi) {
    const rows = [];
    const meta = poi.meta || {};
    if (meta.type) rows.push(['Тип', metaTypeLabels[meta.type] || meta.type]);
    if (meta.priceTier) rows.push(['Класс', meta.priceTier]);
    if (typeof meta.units === 'number') rows.push(['Юнитов', String(meta.units)]);
    if (meta.salaryRange) rows.push(['Оплата', meta.salaryRange]);
    if (meta.note) rows.push(['', meta.note]);
    rows.push(['Коорд.', `X ${poi.position.x.toFixed(1)} · Y ${poi.position.y.toFixed(1)}`]);
    const dl = rows.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
    const link = meta.linkedPage
      ? `<div><a href="${escapeHtml(meta.linkedPage)}">Открыть каталог ↗</a></div>`
      : '';
    return `<div class="poi-popup"><strong>${escapeHtml(poi.label)}</strong><br>`
      + `<span class="poi-kind">${escapeHtml(kindLabels[poi.kind] || poi.kind)}</span>`
      + `<dl>${dl}</dl>${link}</div>`;
  }

  function renderMarkers() {
    if (poiLayer) poiLayer.remove();
    poiLayer = L.layerGroup();
    state.markers.clear();
    const renderer = L.canvas({ padding: 0.4 });
    const useIcons = map.getZoom() >= 5;
    filteredPois().forEach((poi) => {
      const position = gtaToLatLng(poi.position.x, poi.position.y);
      const color = kindColors[poi.kind] || '#cbd2da';
      let marker;
      if (useIcons && poi.icon) {
        const icon = L.divIcon({
          className: 'poi-blip-shell',
          html: `<span class="poi-blip" style="--poi-color:${color}"><img src="${BASE_URL}/icons/${encodeURIComponent(poi.icon)}.svg" alt=""></span>`,
          iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -13],
        });
        marker = L.marker(position, { icon });
      } else {
        marker = L.circleMarker(position, {
          renderer, radius: poi.group === 'atm' ? 3 : 5, weight: 1,
          color: '#071018', fillColor: color, fillOpacity: 0.9,
        });
      }
      marker.bindPopup(popupHtml(poi));
      marker.addTo(poiLayer);
      state.markers.set(poi.id, marker);
    });
    poiLayer.addTo(map);
  }

  function circleZonePoints(shape) {
    return Array.from({ length: 48 }, (_, index) => {
      const angle = (index / 48) * Math.PI * 2;
      return gtaToLatLng(shape.x + Math.cos(angle) * shape.radius, shape.y + Math.sin(angle) * shape.radius);
    });
  }

  function renderZones() {
    if (zonesLayer) zonesLayer.remove();
    zonesLayer = L.layerGroup();
    state.zones.forEach((zone) => {
      if (zone.kind === 'safe' && !state.showSafe) return;
      if (zone.kind === 'police' && !state.showPolice) return;
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

  function renderCategoryList() {
    dom.categoryList.querySelectorAll('button.category').forEach((button) => button.remove());
    const counts = countsByKind();
    kindOrder.filter((kind) => counts.has(kind)).forEach((kind) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = state.enabled.has(kind) ? 'category active' : 'category';
      button.style.color = kindColors[kind];
      button.innerHTML = `<span class="swatch"></span><span class="label">${escapeHtml(kindLabels[kind] || kind)}</span><b>${counts.get(kind)}</b>`;
      button.addEventListener('click', () => {
        if (state.enabled.has(kind)) state.enabled.delete(kind);
        else state.enabled.add(kind);
        update();
      });
      dom.categoryList.append(button);
    });
    dom.toggleAll.textContent = state.enabled.size === kindOrder.length ? 'Снять все' : 'Выбрать все';
  }

  function renderList() {
    const items = filteredPois()
      .slice()
      .sort((left, right) => (kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind))
        || left.label.localeCompare(right.label, 'ru'));
    dom.listCount.textContent = items.length.toLocaleString('ru-RU');
    dom.list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-hotspot';
      empty.textContent = 'Ничего не найдено';
      dom.list.append(empty);
      return;
    }
    // Collapse identical label+kind into one row with a count (many ATMs, gas stations…).
    const groups = [];
    const byKey = new Map();
    items.forEach((poi) => {
      const key = `${poi.kind}|${poi.label}`;
      let group = byKey.get(key);
      if (!group) {
        group = { poi, kind: poi.kind, label: poi.label, ids: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      group.ids.push(poi.id);
    });
    groups.slice(0, LIST_LIMIT).forEach((group) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const suffix = group.ids.length > 1 ? ` <b>×${group.ids.length}</b>` : '';
      button.innerHTML = `<span class="swatch" style="background:${kindColors[group.kind]}"></span>`
        + `<span><strong>${escapeHtml(group.label)}${suffix}</strong>`
        + `<small>${escapeHtml(kindLabels[group.kind] || group.kind)}</small></span>`;
      let cursor = 0;
      button.addEventListener('click', () => {
        focusPoi(group.ids[cursor % group.ids.length]);
        cursor += 1;
      });
      li.append(button);
      dom.list.append(li);
    });
  }

  function focusPoi(id) {
    const poi = state.pois.find((item) => item.id === id);
    if (!poi) return;
    map.setView(gtaToLatLng(poi.position.x, poi.position.y), Math.max(map.getZoom(), 6));
    const marker = state.markers.get(id);
    if (marker) window.setTimeout(() => marker.openPopup(), 60);
  }

  function renderMetrics() {
    const visible = filteredPois().length;
    dom.metricVisible.textContent = visible.toLocaleString('ru-RU');
    dom.metricCategories.textContent = String(state.enabled.size);
    dom.metricZones.textContent = String(state.zones.length);
    dom.mapCount.textContent = `${visible.toLocaleString('ru-RU')} точек`;
  }

  function update() {
    renderCategoryList();
    renderMarkers();
    renderList();
    renderMetrics();
    syncUrl();
  }

  dom.search.addEventListener('input', () => { state.search = dom.search.value; update(); });
  dom.toggleAll.addEventListener('click', () => {
    if (state.enabled.size === kindOrder.length) state.enabled.clear();
    else state.enabled = new Set(kindOrder);
    update();
  });
  dom.safe.addEventListener('change', () => { state.showSafe = dom.safe.checked; renderZones(); });
  dom.police.addEventListener('change', () => { state.showPolice = dom.police.checked; renderZones(); });
  dom.reset.addEventListener('click', fitMainIsland);
  map.on('zoomend', renderMarkers);
  dom.exportButton.addEventListener('click', async () => {
    dom.exportButton.disabled = true;
    dom.exportButton.textContent = 'Экспорт…';
    try {
      const canvas = await html2canvas(dom.mapPanel, { useCORS: true, backgroundColor: '#071018', scale: 2 });
      const link = document.createElement('a');
      link.download = `rejoin-content-map-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch {
      showError('Не удалось экспортировать карту');
    } finally {
      dom.exportButton.disabled = false;
      dom.exportButton.textContent = 'Экспорт PNG';
    }
  });

  function applyInitialParams() {
    const params = new URLSearchParams(window.location.search);
    const cat = params.get('cat');
    if (cat) {
      const wanted = cat.split(',').map((value) => value.trim()).filter((value) => kindOrder.includes(value));
      if (wanted.length) state.enabled = new Set(wanted);
    }
    const query = params.get('q');
    if (query) { state.search = query; dom.search.value = query; }
    return params.get('poi');
  }

  fitMainIsland();
  fetch(`${BASE_URL}/context`, { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`Контекст недоступен (${response.status})`);
      return response.json();
    })
    .then((data) => {
      if (!data || !Array.isArray(data.pois)) throw new Error('Пустой контекст карты');
      state.pois = data.pois;
      state.zones = Array.isArray(data.zones) ? data.zones : [];
      if (data.generatedAt) {
        dom.sourceName.textContent = `Контекст · ${new Date(data.generatedAt).toLocaleDateString('ru-RU')}`;
      }
      const focusId = applyInitialParams();
      showError('');
      update();
      renderZones();
      if (focusId) focusPoi(focusId);
    })
    .catch((error) => showError(error instanceof Error ? error.message : 'Не удалось загрузить контекст'));
})();
