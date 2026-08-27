(() => {
  const BASE = `${window.location.origin}/insights/dealership`;
  const IMG = (m) => `${BASE}/img/${encodeURIComponent(m)}.webp`;
  const STAT_MAX = { braking: 5, traction: 3, acceleration: 1, agility: 1 };
  const STAT_LBL = { braking: 'Тормоза', traction: 'Тяга', acceleration: 'Разгон', agility: 'Управл.' };
  const CLASS_COLOR = {
    SUPER: '#ff6b6b', SPORT: '#ffa94d', SPORT_CLASSIC: '#ffd43b', MUSCLE: '#f783ac', COUPE: '#da77f2',
    SEDAN: '#74c0fc', COMPACT: '#63e6be', SUV: '#8ce99a', OFF_ROAD: '#a9e34b', MOTORCYCLE: '#ffe066',
    VAN: '#adb5bd', COMMERCIAL: '#adb5bd', BOAT: '#4dd4c8',
  };

  const state = { shops: [], salon: 'all', q: '', sort: 'price-asc', origin: 'all', flags: new Set(), cls: 'all', big: false };
  const dom = {};
  ['error-message', 'loading', 'statline', 'salons', 'controls', 'filters2', 'analytics', 'analytics-body',
    'grid', 'noresults', 'search-input', 'sort', 'density', 'modal', 'sheet'].forEach((id) => {
    dom[id] = document.getElementById(id);
  });

  const money = (n) => '$' + Number(n).toLocaleString('ru-RU');
  const esc = (v) => String(v).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

  let ALL = [];            // {..vehicle, shopId, shopLabel}
  const modelSales = {};   // model -> [{shopId, shopLabel, price}]
  const classMedian = {};
  const valueExtremes = {}; // model -> {kind, txt}

  const isPlaceholder = (v) => v.custom && v.speedKmh === 158 && v.stats
    && v.stats.traction === 2.4 && v.stats.acceleration === 0.25;

  function index() {
    ALL = state.shops.flatMap((s) => s.vehicles.map((v) => ({ ...v, shopId: s.id, shopLabel: s.label })));
    ALL.forEach((v) => { (modelSales[v.model] ??= []).push({ shopId: v.shopId, shopLabel: v.shopLabel, price: v.price }); });
    const uniq = dedupeAll();
    const byPrice = {}, byValue = {};
    uniq.forEach((v) => {
      if (!v.class) return;
      (byPrice[v.class] ??= []).push(v.price);
      if (v.speedKmh && !isPlaceholder(v)) (byValue[v.class] ??= []).push(v);
    });
    Object.entries(byPrice).forEach(([c, a]) => { a.sort((x, y) => x - y); classMedian[c] = a[Math.floor(a.length / 2)]; });
    Object.entries(byValue).forEach(([c, arr]) => {
      if (arr.length < 4) return;
      arr.sort((a, b) => a.price / a.speedKmh - b.price / b.speedKmh);
      const best = arr[0], worst = arr[arr.length - 1];
      valueExtremes[best.model] = { kind: 'cheap', txt: `лучшая цена за скорость в классе ${c} (${money(Math.round(best.price / best.speedKmh))}/км·ч)` };
      valueExtremes[worst.model] = { kind: 'pricey', txt: `худшая цена за скорость в классе ${c} (${money(Math.round(worst.price / worst.speedKmh))}/км·ч)` };
    });
  }

  function dedupeAll() {
    const seen = new Map();
    ALL.forEach((v) => { const cur = seen.get(v.model); if (!cur || v.price < cur.price) seen.set(v.model, v); });
    return [...seen.values()];
  }

  function currentList() {
    let list = state.salon === 'all'
      ? dedupeAll()
      : (state.shops.find((s) => s.id === state.salon)?.vehicles || []).map((v) => ({ ...v, shopId: state.salon }));
    const q = state.q.trim().toLowerCase();
    list = list.filter((v) => {
      if (q && !v.name.toLowerCase().includes(q) && !v.model.toLowerCase().includes(q)) return false;
      if (state.origin === 'custom' && !v.custom) return false;
      if (state.origin === 'vanilla' && v.custom) return false;
      if (state.cls !== 'all' && v.class !== state.cls) return false;
      if (state.flags.has('placeholder') && !isPlaceholder(v)) return false;
      if (state.flags.has('multi') && modelSales[v.model].length < 2) return false;
      if (state.flags.has('flagged') && !valueExtremes[v.model]) return false;
      return true;
    });
    const s = state.sort;
    list.sort((a, b) => {
      if (s === 'price-asc') return a.price - b.price;
      if (s === 'price-desc') return b.price - a.price;
      if (s === 'speed-desc') return (b.speedKmh || 0) - (a.speedKmh || 0);
      if (s === 'name-asc') return a.name.localeCompare(b.name, 'ru');
      return (a.class || 'zz').localeCompare(b.class || 'zz') || a.price - b.price;
    });
    return list;
  }

  function card(v) {
    const flag = valueExtremes[v.model];
    const bars = v.stats ? Object.keys(STAT_MAX).map((k) => {
      const pct = Math.max(3, Math.min(100, v.stats[k] / STAT_MAX[k] * 100));
      return `<span class="b" title="${STAT_LBL[k]} ${v.stats[k].toFixed(2)}"><i style="width:${pct}%"></i></span>`;
    }).join('') : '';
    const sales = modelSales[v.model];
    let also = '';
    if (sales.length > 1) {
      const diff = new Set(sales.map((s) => s.price)).size > 1;
      also = `<div class="alsoin">В салонах: ${sales.map((s) => esc(s.shopLabel) + ' ' + money(s.price)).join(' · ')}${diff ? ' <span class="diff">≠ цены</span>' : ''}</div>`;
    }
    return `<div class="card" data-model="${esc(v.model)}">
      <div class="imgwrap">
        <img src="${IMG(v.model)}" alt="" loading="lazy" onerror="this.remove()">
        <div class="ph"><b>${esc(v.model)}</b><span>${v.custom ? 'кастом · нет арта' : 'нет превью'}</span></div>
        <div class="corner l">${v.custom ? '<span class="chip custom">CUSTOM</span>' : ''}</div>
        <div class="corner r">${v.class ? `<span class="chip cls" style="color:${CLASS_COLOR[v.class] || '#ccc'}">${esc(v.class)}</span>` : ''}</div>
      </div>
      <div class="cbody">
        <div class="cname">${esc(v.name)}</div>
        <div class="cspawn" data-copy="${esc(v.model)}">${esc(v.model)} ⧉</div>
        <div class="cprice">${money(v.price)}${flag ? ` <span class="flag" title="${esc(flag.txt)}">⚠</span>` : ''}</div>
        <div class="cspec">${esc(v.class || '—')} · ${v.seats ?? '?'} мест · ${v.speedKmh ? '~' + v.speedKmh + ' км/ч' : 'скорость n/a'}</div>
        ${bars ? `<div class="bars">${bars}</div>` : ''}
        ${also}
      </div></div>`;
  }

  function render() {
    const list = currentList();
    dom.noresults.hidden = list.length > 0;
    dom.grid.className = 'grid' + (state.big ? ' big' : '');
    dom.grid.innerHTML = list.map(card).join('');
    const pool = state.salon === 'all' ? dedupeAll() : state.shops.find((s) => s.id === state.salon).vehicles;
    const prices = pool.map((c) => c.price);
    dom.statline.innerHTML =
      `<span>Показано <b>${list.length}</b></span>`
      + `<span>Кастом <b>${list.filter((v) => v.custom).length}</b></span>`
      + `<span>Классов <b>${new Set(list.map((v) => v.class).filter(Boolean)).size}</b></span>`
      + `<span>Цена <b>${money(Math.min(...prices))}–${money(Math.max(...prices))}</b></span>`;
    syncUrl();
  }

  function openModal(model) {
    const sales = modelSales[model];
    const v = ALL.find((x) => x.model === model);
    const minP = Math.min(...sales.map((s) => s.price));
    const maxP = Math.max(...sales.map((s) => s.price));
    const flag = valueExtremes[model];
    const stat = v.stats ? Object.keys(STAT_MAX).map((k) => {
      const pct = Math.max(3, Math.min(100, v.stats[k] / STAT_MAX[k] * 100));
      return `<span class="lbl">${STAT_LBL[k]}</span><span class="track"><i style="width:${pct}%"></i></span><span>${v.stats[k].toFixed(2)}</span>`;
    }).join('') : '<span class="lbl">нет handling-данных</span><span></span><span></span>';
    dom.sheet.innerHTML =
      `<img class="shimg" src="${IMG(model)}" alt="" onerror="this.style.display='none'">
      <div class="sc">
        <button class="closex" type="button" data-close>Закрыть</button>
        <h2>${esc(v.name)}</h2>
        <div class="sspawn" data-copy="${esc(model)}">${esc(model)} ⧉ спавн-модель</div>
        <div class="srow"><span>Класс <b>${esc(v.class || '—')}</b></span><span>Мест <b>${v.seats ?? '?'}</b></span><span>Скорость <b>${v.speedKmh ? v.speedKmh + ' км/ч' : 'n/a'}</b></span>${v.custom ? '<span><b style="color:var(--custom)">CUSTOM</b></span>' : ''}</div>
        <div class="statgrid">${stat}</div>
        <table class="selltab"><thead><tr><th>Салон</th><th>Цена</th></tr></thead><tbody>
          ${sales.map((s) => `<tr><td>${esc(s.shopLabel)}</td><td class="${s.price === minP ? 'min' : (s.price === maxP && maxP !== minP ? 'max' : '')}">${money(s.price)}</td></tr>`).join('')}
        </tbody></table>
        ${sales.length > 1 && minP !== maxP ? `<div class="note warn">Одна модель по разной цене в разных салонах (${money(minP)} vs ${money(maxP)}).</div>` : ''}
        ${flag ? `<div class="note warn">${esc(flag.txt)}</div>` : ''}
        <div class="note"><a href="/insights/map?cat=vehicles">салоны на карте контента →</a></div>
      </div>`;
    dom.modal.classList.add('open');
  }
  function closeModal() { dom.modal.classList.remove('open'); }
  dom.modal.addEventListener('click', (e) => {
    if (e.target.id === 'modal' || e.target.dataset.close !== undefined) { closeModal(); return; }
    const copy = e.target.closest('[data-copy]');
    if (copy) { navigator.clipboard?.writeText(copy.dataset.copy); copy.textContent = 'скопировано ✓'; }
  });

  dom.grid.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      navigator.clipboard?.writeText(copy.dataset.copy);
      copy.textContent = 'скопировано ✓';
      window.setTimeout(render, 900);
      e.stopPropagation();
      return;
    }
    const c = e.target.closest('.card');
    if (c) openModal(c.dataset.model);
  });

  function renderAnalytics() {
    const uniq = dedupeAll();
    const multi = Object.entries(modelSales).filter(([, s]) => s.length > 1);
    const multiDiff = multi.filter(([, s]) => new Set(s.map((x) => x.price)).size > 1);
    const placeholder = uniq.filter(isPlaceholder).map((v) => v.model);
    const tunedCustom = uniq.filter((v) => v.custom && !isPlaceholder(v)).length;
    const extremes = uniq.filter((v) => valueExtremes[v.model]).map((v) => ({ v, f: valueExtremes[v.model] }));
    const byClass = {};
    uniq.forEach((v) => { if (v.class) (byClass[v.class] ??= []).push(v); });
    const noStats = ALL.filter((v) => !v.stats).map((v) => v.model);
    const nameMap = {};
    uniq.forEach((v) => { (nameMap[v.name.toLowerCase()] ??= []).push(v.model); });
    const dupNames = Object.entries(nameMap).filter(([, a]) => new Set(a).size > 1);

    dom['analytics-body'].innerHTML =
      `<div><h4>Кастом на плейсхолдер-хендлинге (${placeholder.length} из ${placeholder.length + tunedCustom}) — нужен тюнинг</h4><ul><li>${placeholder.length ? placeholder.map(esc).join(', ') : 'нет'}</li></ul></div>`
      + `<div><h4>Модель в нескольких салонах (${multi.length}, с разной ценой ${multiDiff.length})</h4><ul>${multi.length ? multi.map(([m, s]) => `<li><span class="k">${esc(m)}</span> — ${s.map((x) => esc(x.shopLabel) + ' ' + money(x.price)).join(', ')}${new Set(s.map((x) => x.price)).size > 1 ? ' <span class="flag">≠</span>' : ''}</li>`).join('') : '<li>нет</li>'}</ul></div>`
      + `<div><h4>Экстремумы цены за скорость по классам (${extremes.length})</h4><ul>${extremes.length ? extremes.slice(0, 18).map((x) => `<li><span class="k">${esc(x.v.model)}</span> ${money(x.v.price)} — <span class="${x.f.kind === 'cheap' ? 'delta-down' : 'delta-up'}">${esc(x.f.txt)}</span></li>`).join('') : '<li>нет</li>'}</ul></div>`
      + `<div><h4>По классам · без stats (${noStats.length}) · дубли имён (${dupNames.length})</h4><ul>`
      + Object.entries(byClass).sort((a, b) => b[1].length - a[1].length).map(([c, arr]) => {
        const p = arr.map((v) => v.price).sort((a, b) => a - b);
        return `<li><span class="k">${esc(c)}</span> — ${arr.length} · медиана ${money(classMedian[c])} · ${money(p[0])}–${money(p[p.length - 1])}</li>`;
      }).join('')
      + (noStats.length ? `<li class="flag">нет stats: ${noStats.map(esc).join(', ')}</li>` : '')
      + dupNames.map(([n, a]) => `<li class="flag">«${esc(n)}» → ${[...new Set(a)].map(esc).join(', ')}</li>`).join('')
      + '</ul></div>';
  }

  // ---- controls
  function buildControls() {
    dom.salons.hidden = false; dom.controls.hidden = false; dom.filters2.hidden = false;
    dom.salons.innerHTML = ['<button class="pill active" data-s="all">Все салоны</button>']
      .concat(state.shops.map((s) => `<button class="pill" data-s="${esc(s.id)}">${esc(s.label)} · ${s.count}</button>`)).join('');
    dom.salons.addEventListener('click', (e) => {
      const b = e.target.closest('[data-s]'); if (!b) return;
      dom.salons.querySelectorAll('.pill').forEach((x) => x.classList.toggle('active', x === b));
      state.salon = b.dataset.s; render();
    });

    const classes = [...new Set(ALL.map((v) => v.class).filter(Boolean))].sort();
    dom.filters2.innerHTML =
      '<button class="pill mini" data-o="custom">Кастом</button>'
      + '<button class="pill mini" data-o="vanilla">Ванилла</button>'
      + '<span class="sep"></span>'
      + '<button class="pill mini" data-f="multi">В неск. салонах</button>'
      + '<button class="pill mini" data-f="placeholder">Плейсхолдер-хендлинг</button>'
      + '<button class="pill mini" data-f="flagged">Экстремумы цены/скорости</button>'
      + '<span class="sep"></span>'
      + classes.map((c) => `<button class="pill mini" data-c="${esc(c)}">${esc(c)}</button>`).join('');
    dom.filters2.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.o) {
        state.origin = state.origin === b.dataset.o ? 'all' : b.dataset.o;
        dom.filters2.querySelectorAll('[data-o]').forEach((x) => x.classList.toggle('active', x.dataset.o === state.origin));
      }
      if (b.dataset.f) {
        b.classList.toggle('active');
        b.classList.contains('active') ? state.flags.add(b.dataset.f) : state.flags.delete(b.dataset.f);
      }
      if (b.dataset.c) {
        state.cls = state.cls === b.dataset.c ? 'all' : b.dataset.c;
        dom.filters2.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('active', x.dataset.c === state.cls));
      }
      render();
    });

    dom['search-input'].addEventListener('input', () => { state.q = dom['search-input'].value; render(); });
    dom.sort.addEventListener('change', () => { state.sort = dom.sort.value; render(); });
    dom.density.addEventListener('click', () => {
      state.big = !state.big;
      dom.density.textContent = state.big ? 'Компактнее' : 'Крупнее';
      dom.density.classList.toggle('active', state.big);
      render();
    });
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.salon !== 'all') p.set('salon', state.salon);
    if (state.q.trim()) p.set('q', state.q.trim());
    if (state.sort !== 'price-asc') p.set('sort', state.sort);
    if (state.origin !== 'all') p.set('origin', state.origin);
    if (state.cls !== 'all') p.set('class', state.cls);
    if (state.flags.size) p.set('flags', [...state.flags].join(','));
    const q = p.toString();
    window.history.replaceState(null, '', q ? `?${q}` : window.location.pathname);
  }

  function applyInitial() {
    const hashSalon = (window.location.hash.match(/^#shop-([a-z]+)$/) || [])[1];
    const p = new URLSearchParams(window.location.search);
    const salon = hashSalon || p.get('salon');
    if (salon && state.shops.some((s) => s.id === salon)) {
      state.salon = salon;
      dom.salons.querySelectorAll('.pill').forEach((x) => x.classList.toggle('active', x.dataset.s === salon));
    }
    if (p.get('q')) { state.q = p.get('q'); dom['search-input'].value = state.q; }
    if (p.get('sort')) { state.sort = p.get('sort'); dom.sort.value = state.sort; }
    if (p.get('origin')) {
      state.origin = p.get('origin');
      dom.filters2.querySelectorAll('[data-o]').forEach((x) => x.classList.toggle('active', x.dataset.o === state.origin));
    }
    if (p.get('class')) {
      state.cls = p.get('class');
      dom.filters2.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('active', x.dataset.c === state.cls));
    }
    (p.get('flags') || '').split(',').filter(Boolean).forEach((f) => {
      state.flags.add(f);
      const b = dom.filters2.querySelector(`[data-f="${f}"]`);
      if (b) b.classList.add('active');
    });
  }

  fetch(`${BASE}/data`, { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(`Каталог недоступен (${r.status})`); return r.json(); })
    .then((data) => {
      if (!data || !Array.isArray(data.shops) || !data.shops.length) throw new Error('Пустой каталог');
      state.shops = data.shops;
      dom.loading.hidden = true;
      index();
      buildControls();
      applyInitial();
      renderAnalytics();
      render();
    })
    .catch((e) => {
      dom.loading.hidden = true;
      dom['error-message'].hidden = false;
      dom['error-message'].textContent = e instanceof Error ? e.message : 'Не удалось загрузить каталог';
    });
})();
