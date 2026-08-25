import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";

export type PublishedDeath = {
  cause: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  timestamp: string;
  killed_by_player: boolean;
};

type MapPoint = { x: number; y: number; z: number };
type MapPoi = {
  id: string;
  label: string;
  kind: "job" | "service" | "vehicles" | "housing" | "activity" | "faction" | "publicTransport";
  group: "poi" | "atm";
  position: MapPoint;
  icon?: "247shop" | "airport" | "atm" | "autoSchool" | "cityHall" | "dump" | "fireStation" | "gasStation" | "goPostal" | "hospital" | "hotel" | "parking" | "policeStation" | "port" | "roadRepair" | "trashCollector" | "vehicleShopPremium";
  sprite?: number;
  color?: number;
};
type MapZone = {
  id: string;
  label: string;
  kind: "safe" | "police";
  shape: { kind: "circle"; x: number; y: number; radius: number; minZ?: number; maxZ?: number }
    | { kind: "poly"; points: Array<{ x: number; y: number }>; minZ?: number; maxZ?: number };
};
export type PublishedMapContext = {
  schemaVersion: 1;
  generatedAt: string;
  sourceCommit: string;
  pois: MapPoi[];
  zones: MapZone[];
};

type RawDeath = Partial<{
  cause: unknown;
  pos_x: unknown;
  pos_y: unknown;
  pos_z: unknown;
  timestamp: unknown;
  killer_id: unknown;
  killed_by_player: unknown;
}>;

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeDeath(value: unknown): PublishedDeath | null {
  if (!value || typeof value !== "object") return null;
  const row = value as RawDeath;
  const posX = finiteNumber(row.pos_x);
  const posY = finiteNumber(row.pos_y);
  const posZ = finiteNumber(row.pos_z);
  if (posX === null || posY === null || posZ === null || typeof row.cause !== "string") {
    return null;
  }

  return {
    cause: row.cause.trim().slice(0, 64) || "unknown",
    pos_x: posX,
    pos_y: posY,
    pos_z: posZ,
    timestamp: typeof row.timestamp === "string" ? row.timestamp.slice(0, 32) : "",
    killed_by_player: typeof row.killed_by_player === "boolean"
      ? row.killed_by_player
      : finiteNumber(row.killer_id) !== null && Number(row.killer_id) >= 0,
  };
}

export async function loadPublishedDeaths(): Promise<PublishedDeath[]> {
  const path = resolve(process.cwd(), config.insights.deathsDataPath);
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: unknown[] }).data
      : null;

  if (!rows) throw new Error("death insights file has no data array");
  const deaths = rows.map(sanitizeDeath).filter((row): row is PublishedDeath => row !== null);
  if (deaths.length === 0) throw new Error("death insights file has no valid events");
  return deaths;
}

const poiKinds = new Set<MapPoi["kind"]>(["job", "service", "vehicles", "housing", "activity", "faction", "publicTransport"]);
const poiIcons = new Set<NonNullable<MapPoi["icon"]>>(["247shop", "airport", "atm", "autoSchool", "cityHall", "dump", "fireStation", "gasStation", "goPostal", "hospital", "hotel", "parking", "policeStation", "port", "roadRepair", "trashCollector", "vehicleShopPremium"]);

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || null;
}

function sanitizePoi(value: unknown): MapPoi | null {
  if (!value || typeof value !== "object") return null;
  const poi = value as Partial<MapPoi>;
  const id = cleanText(poi.id, 96);
  const label = cleanText(poi.label, 96);
  const x = finiteNumber(poi.position?.x);
  const y = finiteNumber(poi.position?.y);
  const z = finiteNumber(poi.position?.z);
  if (!id || !label || !poiKinds.has(poi.kind as MapPoi["kind"]) || (poi.group !== "poi" && poi.group !== "atm") || x === null || y === null || z === null) return null;
  if (x < -10000 || x > 13000 || y < -10000 || y > 13000) return null;
  const icon = poiIcons.has(poi.icon as NonNullable<MapPoi["icon"]>) ? poi.icon : undefined;
  const spriteValue = finiteNumber(poi.sprite);
  const colorValue = finiteNumber(poi.color);
  const sprite = spriteValue !== null && Number.isInteger(spriteValue) && spriteValue >= 0 && spriteValue <= 1000 ? spriteValue : undefined;
  const color = colorValue !== null && Number.isInteger(colorValue) && colorValue >= 0 && colorValue <= 255 ? colorValue : undefined;
  return { id, label, kind: poi.kind as MapPoi["kind"], group: poi.group, position: { x, y, z }, icon, sprite, color };
}

function sanitizeZone(value: unknown): MapZone | null {
  if (!value || typeof value !== "object") return null;
  const zone = value as Partial<MapZone>;
  const id = cleanText(zone.id, 96);
  const label = cleanText(zone.label, 96);
  if (!id || !label || (zone.kind !== "safe" && zone.kind !== "police") || !zone.shape) return null;
  const minZ = finiteNumber(zone.shape.minZ) ?? undefined;
  const maxZ = finiteNumber(zone.shape.maxZ) ?? undefined;
  if (zone.shape.kind === "circle") {
    const x = finiteNumber(zone.shape.x);
    const y = finiteNumber(zone.shape.y);
    const radius = finiteNumber(zone.shape.radius);
    if (x === null || y === null || radius === null || radius <= 0 || radius > 1000 || x < -10000 || x > 13000 || y < -10000 || y > 13000) return null;
    return { id, label, kind: zone.kind, shape: { kind: "circle", x, y, radius, minZ, maxZ } };
  }
  if (zone.shape.kind === "poly" && Array.isArray(zone.shape.points)) {
    const points = zone.shape.points.slice(0, 100).map((point) => ({ x: finiteNumber(point.x), y: finiteNumber(point.y) }));
    if (points.length < 3 || points.some((point) => point.x === null || point.y === null)) return null;
    if (points.some((point) => point.x! < -10000 || point.x! > 13000 || point.y! < -10000 || point.y! > 13000)) return null;
    return { id, label, kind: zone.kind, shape: { kind: "poly", points: points as Array<{ x: number; y: number }>, minZ, maxZ } };
  }
  return null;
}

export async function loadPublishedMapContext(): Promise<PublishedMapContext> {
  const path = resolve(process.cwd(), config.insights.deathsContextPath);
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PublishedMapContext>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.pois) || !Array.isArray(parsed.zones)) {
    throw new Error("unsupported death map context schema");
  }
  const pois = parsed.pois.map(sanitizePoi).filter((poi): poi is MapPoi => poi !== null);
  const zones = parsed.zones.map(sanitizeZone).filter((zone): zone is MapZone => zone !== null);
  return {
    schemaVersion: 1,
    generatedAt: cleanText(parsed.generatedAt, 40) ?? "",
    sourceCommit: cleanText(parsed.sourceCommit, 64) ?? "",
    pois,
    zones,
  };
}
