// Shared Insights top navigation. Each page drops a <div data-insights-nav></div>
// placeholder and loads this script; the single page list below is the source of
// truth. The Manager report page (server-rendered) mirrors this markup in web.ts.
(() => {
  const NAV = [
    { href: '/insights', label: 'Обзор' },
    {
      group: 'Карты',
      items: [
        { href: '/insights/map', label: 'Контент' },
        { href: '/insights/deaths', label: 'Смерти' },
      ],
    },
    { href: '/insights/dealership', label: 'Автосалоны' },
  ];

  const mount = document.querySelector('[data-insights-nav]');
  if (!mount) return;
  const here = (location.pathname.replace(/\/+$/, '') || '/insights');

  const link = (item) => {
    const el = document.createElement('a');
    el.href = item.href;
    el.textContent = item.label;
    if (here === item.href.replace(/\/+$/, '')) {
      el.className = 'is-current';
      el.setAttribute('aria-current', 'page');
    }
    return el;
  };

  const nav = document.createElement('nav');
  nav.className = 'insights-tabs';
  nav.setAttribute('aria-label', 'Разделы Insights');
  NAV.forEach((entry) => {
    if (entry.group) {
      const groupEl = document.createElement('span');
      groupEl.className = 'tab-group';
      groupEl.setAttribute('role', 'group');
      groupEl.setAttribute('aria-label', entry.group);
      entry.items.forEach((item) => groupEl.append(link(item)));
      nav.append(groupEl);
    } else {
      nav.append(link(entry));
    }
  });
  mount.replaceWith(nav);
})();
