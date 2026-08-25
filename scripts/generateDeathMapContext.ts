import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Position = { x: number; y: number; z?: number };
type PoiKind = "job" | "service" | "vehicles" | "housing" | "activity" | "faction" | "publicTransport";
type PoiIcon = "247shop" | "airport" | "atm" | "autoSchool" | "cityHall" | "dump" | "fireStation" | "gasStation" | "goPostal" | "hospital" | "hotel" | "parking" | "policeStation" | "port" | "roadRepair" | "trashCollector" | "vehicleShopPremium";

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

const source = arg("source");
const output = arg("output");
const moduleUrl = (path: string) => pathToFileURL(resolve(source, path)).href;

const [pedsModule, blipInfoModule, atmsModule, zonesModule, policeModule, hospitalsModule, parkingModule, ruModule] = await Promise.all([
  import(moduleUrl("apps/shared/data/dialoguePeds.ts")),
  import(moduleUrl("apps/shared/data/blipInfo.ts")),
  import(moduleUrl("apps/shared/data/atms.ts")),
  import(moduleUrl("apps/shared/data/safeZones.ts")),
  import(moduleUrl("apps/shared/data/policeStations.ts")),
  import(moduleUrl("apps/shared/data/hospital.ts")),
  import(moduleUrl("apps/shared/data/parkingLots.ts")),
  import(moduleUrl("apps/shared/translations/ru.ts")),
]);

const ru = ruModule.default as unknown;
const blipInfo = blipInfoModule.BLIP_INFO as Record<string, { kind?: string }>;
const allowedKinds = new Set<PoiKind>(["job", "service", "vehicles", "housing", "activity", "faction", "publicTransport"]);
const pois: Array<{ id: string; label: string; kind: PoiKind; group: string; position: Required<Position>; icon?: PoiIcon; sprite?: number; color?: number }> = [];

for (const [index, ped] of (pedsModule.DialoguePeds as Array<{ position: Position; marker?: { name?: string; infoKey?: string; dimension?: number; sprite?: number; color?: number } }>).entries()) {
  if (!ped.marker || Number(ped.marker.dimension ?? 0) !== 0) continue;
  const key = ped.marker.infoKey ?? ped.marker.name ?? "blips.point";
  const kind = blipInfo[key]?.kind;
  if (!allowedKinds.has(kind as PoiKind)) continue;
  pois.push({
    id: `ped:${index}`,
    label: translate(ru, ped.marker.name ?? key),
    kind: kind as PoiKind,
    group: "poi",
    position: cleanPosition(ped.position),
    icon: iconForKey(key),
    sprite: Number.isFinite(ped.marker.sprite) ? ped.marker.sprite : undefined,
    color: Number.isFinite(ped.marker.color) ? ped.marker.color : undefined,
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
  schemaVersion: 1,
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
