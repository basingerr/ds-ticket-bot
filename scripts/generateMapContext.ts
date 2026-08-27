import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Content-map context generator (schemaVersion 2).
//
// Superset of scripts/generateDeathMapContext.ts: same POI/zone extraction plus
// job start points, metro stations, and hotels, and an optional per-POI `meta`
// block. Criminal and organization locations stay excluded. Output is a pure
// function of the given rejoin-server commit; regenerate it manually on release.
//
//   npm run insights:map-context -- --source=/path/to/rejoin-server \
//     --output=./exports/map-insights/map-context.json

type Position = { x: number; y: number; z?: number };
type PoiKind = "job" | "service" | "vehicles" | "housing" | "activity" | "faction" | "publicTransport";
type PoiIcon = "247shop" | "airport" | "atm" | "autoSchool" | "cityHall" | "dump" | "fireStation" | "gasStation" | "goPostal" | "hospital" | "hotel" | "parking" | "policeStation" | "port" | "roadRepair" | "trashCollector" | "vehicleShopPremium";
type PoiMeta = {
  type?: string;
  priceTier?: string;
  units?: number;
  salaryRange?: string;
  linkedPage?: string;
  note?: string;
};
type Poi = {
  id: string;
  label: string;
  kind: PoiKind;
  group: "poi" | "atm";
  position: Required<Position>;
  icon?: PoiIcon;
  sprite?: number;
  color?: number;
  meta?: PoiMeta;
};

function arg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix}<path>`);
  return resolve(value);
}

function translate(catalog: unknown, key: string): string {
  const publicLabelOverrides: Record<string, string> = {
    "blips.lsmc": "Los Santos Medical Center",
    "blips.ssmc": "Sandy Shores Medical Center",
  };
  if (publicLabelOverrides[key]) return publicLabelOverrides[key];
  let value: unknown = catalog;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object") return key.replace(/^blips\./, "");
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : key.replace(/^blips\./, "");
}

function cleanPosition(position: Position): Required<Position> {
  return { x: Number(position.x), y: Number(position.y), z: Number(position.z ?? 0) };
}

function iconForKey(key: string): PoiIcon | undefined {
  const exact: Record<string, PoiIcon> = {
    "blips.market": "247shop",
    "blips.autoSchool": "autoSchool",
    "blips.fireFighter": "fireStation",
    "blips.gasStation": "gasStation",
    "blips.goPostal": "goPostal",
    "blips.motel": "hotel",
    "blips.port": "port",
    "blips.roadRepair": "roadRepair",
    "blips.trashCollector": "trashCollector",
  };
  if (exact[key]) return exact[key];
  if (key.startsWith("blips.fireFighter")) return "fireStation";
  if (key.startsWith("blips.vehicleShop")) return "vehicleShopPremium";
  return undefined;
}

const JOB_LABELS: Record<string, string> = {
  port: "Работа в порту",
  goPost: "Разносчик почты",
  trashCollector: "Мусорщик",
  fireFighter: "Пожарный",
  roadRepair: "Дорожный рабочий",
  constructionSite: "Грузчик на стройке",
  farm: "Работа на ферме",
  taxiDriver: "Таксист",
  supplyCourier: "Курьер снабжения",
};
const VEHICLE_SHOP_BLIP_TO_ID: Record<string, string> = {
  "blips.vehicleShopEconom": "econom",
  "blips.vehicleShopAverage": "average",
  "blips.vehicleShopLuxury": "luxury",
  "blips.vehicleShopMotorcycle": "motorcycle",
  "blips.vehicleShopCommercial": "commercial",
  "blips.vehicleShopDump": "dump",
  "blips.vehicleShopBoats": "boat",
};

const JOB_ICONS: Record<string, PoiIcon> = {
  port: "port",
  goPost: "goPostal",
  trashCollector: "trashCollector",
  fireFighter: "fireStation",
  roadRepair: "roadRepair",
};

const source = arg("source");
const output = arg("output");
const moduleUrl = (path: string) => pathToFileURL(resolve(source, path)).href;

const [
  pedsModule,
  blipInfoModule,
  atmsModule,
  zonesModule,
  policeModule,
  hospitalsModule,
  parkingModule,
  jobsModule,
  metroModule,
  hotelsModule,
  ruModule,
] = await Promise.all([
  import(moduleUrl("apps/shared/data/dialoguePeds.ts")),
  import(moduleUrl("apps/shared/data/blipInfo.ts")),
  import(moduleUrl("apps/shared/data/atms.ts")),
  import(moduleUrl("apps/shared/data/safeZones.ts")),
  import(moduleUrl("apps/shared/data/policeStations.ts")),
  import(moduleUrl("apps/shared/data/hospital.ts")),
  import(moduleUrl("apps/shared/data/parkingLots.ts")),
  import(moduleUrl("apps/shared/data/jobs.ts")),
  import(moduleUrl("apps/shared/data/metro.ts")),
  import(moduleUrl("apps/shared/data/hotels.ts")),
  import(moduleUrl("apps/shared/translations/ru.ts")),
]);

const ru = ruModule.default as unknown;
const blipInfo = blipInfoModule.BLIP_INFO as Record<string, { kind?: string }>;
const allowedKinds = new Set<PoiKind>(["job", "service", "vehicles", "housing", "activity", "faction", "publicTransport"]);
const pois: Poi[] = [];

for (const [index, ped] of (pedsModule.DialoguePeds as Array<{ position: Position; marker?: { name?: string; infoKey?: string; dimension?: number; sprite?: number; color?: number } }>).entries()) {
  if (!ped.marker || Number(ped.marker.dimension ?? 0) !== 0) continue;
  const key = ped.marker.infoKey ?? ped.marker.name ?? "blips.point";
  const kind = blipInfo[key]?.kind;
  if (!allowedKinds.has(kind as PoiKind)) continue;
  const shopId = VEHICLE_SHOP_BLIP_TO_ID[key];
  pois.push({
    id: `ped:${index}`,
    label: translate(ru, ped.marker.name ?? key),
    kind: kind as PoiKind,
    group: "poi",
    position: cleanPosition(ped.position),
    icon: iconForKey(key),
    sprite: Number.isFinite(ped.marker.sprite) ? ped.marker.sprite : undefined,
    color: Number.isFinite(ped.marker.color) ? ped.marker.color : undefined,
    meta: shopId ? { type: "vehicleShop", linkedPage: `/insights/dealership#shop-${shopId}` } : undefined,
  });
}

for (const [index, position] of (atmsModule.atmPositions as Position[]).entries()) {
  pois.push({ id: `atm:${index}`, label: "Банкомат", kind: "service", group: "atm", position: cleanPosition(position), icon: "atm", sprite: 108, color: 2 });
}

for (const [index, hospital] of (hospitalsModule.hospitals as Array<{ name: string; infoKey: string; coords: Position }>).entries()) {
  pois.push({
    id: `hospital:${index}`,
    label: hospital.name || translate(ru, hospital.infoKey),
    kind: "faction",
    group: "poi",
    position: cleanPosition(hospital.coords),
    icon: "hospital",
    sprite: 61,
    color: 1,
  });
}

for (const parking of parkingModule.parkingLots as Array<{ id: string; name: string; position: Position }>) {
  pois.push({ id: `parking:${parking.id}`, label: parking.name, kind: "vehicles", group: "poi", position: cleanPosition(parking.position), icon: "parking" });
}

for (const [job, position] of Object.entries(jobsModule.jobPositions as Record<string, Position>)) {
  pois.push({
    id: `job:${job}`,
    label: JOB_LABELS[job] ?? job,
    kind: "job",
    group: "poi",
    position: cleanPosition(position),
    icon: JOB_ICONS[job],
    meta: { type: "jobStart" },
  });
}

for (const [index, station] of (metroModule.metroStations as Array<{ name: string; infoKey: string; coord: Position }>).entries()) {
  pois.push({
    id: `metro:${index}`,
    label: station.name || translate(ru, station.infoKey),
    kind: "publicTransport",
    group: "poi",
    position: cleanPosition(station.coord),
    sprite: 795,
    meta: { type: "metroStation" },
  });
}

for (const hotel of hotelsModule.hotelsData as Array<{ id: number; type: string; position: Position }>) {
  pois.push({
    id: `hotel:${hotel.id}`,
    label: hotel.type === "motel" ? `Мотель №${hotel.id}` : `Отель №${hotel.id}`,
    kind: "housing",
    group: "poi",
    position: cleanPosition(hotel.position),
    icon: "hotel",
    meta: { type: hotel.type },
  });
}

const zones = (zonesModule.SAFE_ZONES as Array<{ id: string; nameKey: string; shape: unknown }>).map((zone) => ({
  id: `safe:${zone.id}`,
  label: translate(ru, zone.nameKey),
  kind: "safe" as const,
  shape: zone.shape,
}));

for (const station of policeModule.policeStationZones as Array<{ id: string; zone: Array<{ x: number; y: number }> }>) {
  zones.push({ id: `police:${station.id}`, label: `Полицейский участок · ${station.id}`, kind: "police", shape: { kind: "poly", points: station.zone } });
}

const sourceCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const payload = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  sourceCommit,
  pois,
  zones,
};

await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.next`;
await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await rename(temporary, output);
console.log(JSON.stringify({ output, sourceCommit, pois: pois.length, zones: zones.length }));
