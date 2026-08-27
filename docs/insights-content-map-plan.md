# Insights: Content Map + Vehicle Catalog

Status: in progress (started 2026-08-27). Owner-approved as deliberate infra around the
bot ("целая инфра вокруг бота, потом отцепим"). This supersedes the narrow
`AGENTS.md` "no dashboard" default for the Insights surface specifically.

## Goal

Turn the narrow POI layer of the death heatmap into a first-class **content map** that
answers "what player-facing content exists on Rejoin and where", with real filtering,
search, a synced list, and per-category coverage stats. Then a separate **vehicle
catalog** page for dealership contents, linked from salon markers on the map.

Everything stays: HTTP Basic auth, `noindex`, server-only files in gitignored
`exports/`, manual regeneration (no DB / cron / live API in the bot). Context files are
pure functions of a `rejoin-server` commit.

## Architecture

New page `/insights/map`, sharing the atlas tiles and the GTA->LatLng projection with
the death map.

```
assets/insights/
  shared/map-core.js    NEW: MAP_SIZE/TILE_* consts, gtaToLatLng, base map + tile layer
  deaths/               refactored to import map-core (behaviour identical)
  map/                  NEW: index.html, app.js, styles.css
  dealership/           NEW (phase 3)
```

Fallback if the deaths refactor looks risky: duplicate the ~30 lines of map core into
`map/app.js` and leave `deaths/` untouched.

## Phase 1 - data layer  (DONE 2026-08-27)

- `scripts/generateMapContext.ts` sits *alongside* `generateDeathMapContext.ts`
  (additive - the death map and its schema-1 loader are left untouched). npm script
  `insights:map-context`. Output `./exports/map-insights/map-context.json`,
  `schemaVersion: 2`. Current run: 205 POIs, 24 zones. Beyond the death-map set it
  adds job start points, metro stations, and hotels; `organization`/`criminal` stay
  excluded. Per-POI `meta` block is live (`type`, `priceTier`, `units`,
  `salaryRange`, `linkedPage`, `note`).
- `src/insights/mapData.ts` - `sanitizeMapContext` / `loadPublishedMapContext`,
  covered by `src/insights/mapData.test.ts` (in `npm run insights:test`).
- config: `insights.mapContextPath`, `insights.mapTilesPath` (defaults reuse the
  death atlas dir); `.env(.production).example` updated.

Remaining source coverage to add later (own commits, trial each): businesses,
clothing/barber/tattoo/ammunation shops, gas stations, LS Customs, casino, farm &
fishing zones, faction wardrobes/warehouses, real job salary ranges.

Original v2 schema sketch:

  ```jsonc
  {
    "schemaVersion": 2,
    "generatedAt": "...", "sourceCommit": "...",
    "pois": [{
      "id": "job:trashCollector",
      "label": "Мусорщик",
      "kind": "job",            // + new: transitStop, business, shop
      "group": "poi",
      "position": { "x": 0, "y": 0, "z": 0 },
      "icon": "trashCollector",
      "meta": {                 // NEW, optional, per-category
        "salaryRange": "12–18$",
        "priceTier": "econom",
        "units": 24,
        "linkedPage": "/insights/dealership#salon-econom"
      }
    }],
    "zones": [{ "kind": "safe|police|fishing|farm|jobArea", "...": "..." }]
  }
  ```

  Sources to add beyond today's set: `jobs.ts` + `jobsSalary.ts`, `hotels.ts`,
  `apartmentData.ts`/`houseData.ts`, `businessTypes.ts`, `metro.ts`, `busStops.ts`,
  `fishingZones.ts`, `farm.ts`, `supermarkets.ts` / `clothingStores.const.ts` /
  `barberShop.ts` / `tattooShop.ts` / `autoSchool.ts`, `lsCustoms.ts`, `casino/`,
  `gasStationSupply.ts`. `organization` and `criminal` kinds stay excluded.

- `src/insights/mapData.ts` - loader + sanitizer for schema 2 (mirrors
  `deathsData.ts`): whitelist new `kind`s, row caps, `meta` key whitelist + length
  clamp, same coordinate bbox.
- `src/insights/mapData.test.ts` wired into `npm run insights:test`.
- Death map keeps its strict loader (unknown kinds dropped harmlessly). Decide during
  build whether to point it at the shared file; default is leave it alone.

## Phase 2 - content map page  (DONE 2026-08-27)

Shipped: `assets/insights/shared/map-core.js` (shared projection + tile layer; death
map left untouched, no refactor needed), `assets/insights/map/{index.html,app.js,
styles.css}`, routes `GET /map`, `/map/context`, `/map/tiles/:file`,
`/map/icons/:file`, `/map/vendor/leaflet`, `/map/vendor/html2canvas.min.js`,
`/map/core.js`, `/map/app.js`, `/map/styles.css` in `web.ts`; `setSecurityHeaders`
map-asset branch extended to `/map`; nav links added on `/insights` and
`/insights/deaths`. UX delivered: multi-select category chips with counts, search,
synced list (identical labels collapsed to `×N`), safe/police zone toggles, popups
with `meta`, `?cat=`/`?q=`/`?poi=` deep links, PNG export, reset view. Smoke-tested
end to end (auth, CSP, path-traversal guard, 205 POIs / 24 zones, filters, search,
deep-link round-trip); `npx tsc --noEmit` + `npm run insights:test` (12/12) green.

Deferred polish: real marker clustering at low zoom (canvas dots are fine for ~200);
coverage/"no service within R" block; richer per-category meta once Phase 1 sources
are expanded.

Original route plan:

- `GET /map`, `/map/` -> `assets/insights/map/index.html`
- `GET /map/context` -> `mapData.loadMapContext()`
- `GET /map/app.js`, `/map/styles.css`
- shared tiles `GET /insights/atlas/:file` (same dir, config renamed to `mapTilesPath`);
  keep `/deaths/tiles/:file` as an alias for cache continuity
- shared icons `GET /insights/icons/:file`
- extend the `allowMapAssets` check in `setSecurityHeaders` to `/map` and `/atlas`
- nav links between `/insights`, `/insights/deaths`, `/insights/map`

UX (same dark styling as `deaths/styles.css`):

| Feature | Notes |
| --- | --- |
| Category filter | multi chips, per-category count |
| Search | POI name, highlight + fly-to |
| Always-visible markers | icon at zoom >= 5, colored dot otherwise; cluster when dense |
| Synced list | sidebar list of visible POIs, click -> fly-to + popup |
| Popup | name, category, per-category extra (salary range / price tier / units), link to subpage if any |
| Zone layers | safe / police / fishing / farm independent toggles |
| Legend + summary | "N POI across K categories" + per-category breakdown |
| Deep-link | `?cat=job,shop` and `?poi=<id>` |
| PNG export | reuse html2canvas |

Plus a "coverage" block: category table with counts and an optional
"areas with no service within R" radius check (cheap, like `deathsNearPoi`).

## Phase 3 - vehicle catalog (`/insights/dealership`)  (DONE 2026-08-27)

Shipped: `scripts/generateVehicleCatalog.ts` (`npm run insights:vehicle-catalog`;
7 salons / 255 vehicles from `vehicleDealership.ts` + `vehicle.ts`),
`src/insights/vehicleCatalogData.ts` + `vehicleCatalogData.test.ts` (5 tests),
routes `GET /dealership`, `/dealership/data`, `/dealership/app.js`,
`/dealership/styles.css` in `web.ts`, `interactiveAssetPath` CSP gate now covers
`/dealership` + `/dealership/img`, config `insights.vehicleCatalogPath` +
`vehicleImgPath`. Page: card grid with preview images (see rework note below),
handling stat bars, spawn-model copy, per-model modal, dev-analytics panel; salon /
search / sort / custom-vanilla / dev-flag / class filters; `?salon/q/sort/origin/
class/flags` deep links, `#shop-<id>` anchors. `generateMapContext.ts` now tags the 7 vehicle-shop
POIs with `meta.linkedPage = /insights/dealership#shop-<id>`; the map popup renders
that as an "Открыть каталог" link. Nav links added on `/insights` and `/insights/map`.
Smoke-tested (auth, 7 shops, filters, sort, deep-link, map cross-link);
`tsc --noEmit` + `insights:test` (17/17) green.

Original plan:

- `scripts/generateVehicleCatalog.ts` -> `vehicle-catalog.json` from
  `vehicleDealership.ts` (model + price per salon), `vehicle.ts` (class, stats, fuel),
  `vehicleShopList.ts` (salon coords). `custom` flag for `rejoin_*` models.
- `src/insights/vehicleCatalogData.ts` + routes `GET /insights/dealership`,
  `/dealership/data`, `/dealership/app.js|styles.css`; CSP branch like the map.
- Page reworked 2026-08-27 from the table into a card grid (ref:
  `html-prototypes/car_catalog_v2.html`): preview image per card, class/seats/speed +
  handling stat bars, click-to-copy spawn model, per-model modal (all salons+prices,
  full stats, link to the content map), collapsible dev-analytics panel
  (placeholder-handling customs `speedKmh===158 && default stats` — 55/79 right now,
  multi-salon models, price/speed extremes per class, class summary, no-stats,
  duplicate display names). Deep links `?salon/q/sort/origin/class/flags`,
  `#shop-<id>` anchors.
- Images: `scripts/fetchVehicleImages.ts` (`npm run insights:vehicle-images`)
  downloads the ~175 vanilla `<model>.webp` from docs.fivem.net into
  `INSIGHTS_VEHICLE_IMG_PATH` once (~7 MB); route `/dealership/img/:file` serves them
  under the unchanged strict CSP. Custom `rejoin_*` have no upstream art -> placeholder.

## Shared navigation  (DONE 2026-08-27)

One top nav on every Insights page. Source of truth: `assets/insights/shared/nav.js`
(`Обзор` · segmented `Карты` = `Контент`/`Смерти` · `Автосалоны`), styled by
`assets/insights/shared/nav.css` (fixed colors, palette-independent), served at
`/insights/nav.js` + `/insights/nav.css`. The three interactive pages drop a
`<div data-insights-nav>` placeholder and load the script; the Manager report page
(strict CSP, no external JS) mirrors the same markup server-side in `web.ts` with an
inline copy of the tab CSS. Adding a future map = one entry in `nav.js` + the new
page. `?…` deep-link params are not carried across tabs (plain links).

## Order of work

1. Phase 1 (generator v2 + `mapData.ts` + tests) - foundation, trial on a real checkout.
2. Phase 2 (map page + routes + core extraction).
3. Phase 3 (dealership) once the map is in prod and links to it.

## Files

New: `scripts/generateMapContext.ts`, `scripts/generateVehicleCatalog.ts`,
`src/insights/mapData.ts`, `src/insights/mapData.test.ts`,
`src/insights/vehicleCatalogData.ts`, `assets/insights/shared/map-core.js`,
`assets/insights/map/{index.html,app.js,styles.css}`,
`assets/insights/dealership/{index.html,app.js,styles.css}`.

Edit: `src/insights/web.ts` (routes + CSP gate), `src/config.ts` (`mapTilesPath`,
`mapContextPath`, `vehicleCatalogPath`), `package.json` (npm scripts), `README.md` +
`.env.example`, `assets/insights/deaths/app.js` (import map-core), nav in
`assets/insights/deaths/index.html` and `renderInsightsReportPage`.
