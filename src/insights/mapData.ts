import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";

// Loader + sanitizer for the content-map context (schemaVersion 2). Mirrors the
// death-map context loader in deathsData.ts but carries a wider POI set and an
// optional per-POI `meta` block. Everything served to the browser is whitelisted
// here; unknown fields are dropped.

export type MapPoint = { x: number; y: number; z: number };

export type MapPoiKind =
  | "job"
  | "service"
  | "vehicles"
  | "housing"
  | "activity"
  | "faction"
  | "publicTransport";

export type MapPoiIcon =
  | "247shop"
  | "airport"
  | "atm"
  | "autoSchool"
  | "cityHall"
  | "dump"
  | "fireStation"
  | "gasStation"
  | "goPostal"
  | "hospital"
  | "hotel"
  | "parking"
  | "policeStation"
  | "port"
  | "roadRepair"
  | "trashCollector"
  | "vehicleShopPremium";

export type MapPoiMeta = {
  type?: string;
  priceTier?: string;
  units?: number;
  salaryRange?: string;
  linkedPage?: string;
  note?: string;
};

export type MapPoi = {
  id: string;
  label: string;
  kind: MapPoiKind;
  group: "poi" | "atm";
  position: MapPoint;
  icon?: MapPoiIcon;
  sprite?: number;
  color?: number;
  meta?: MapPoiMeta;
};

export type MapZone = {
  id: string;
  label: string;
  kind: "safe" | "police";
  shape:
    | { kind: "circle"; x: number; y: number; radius: number; minZ?: number; maxZ?: number }
    | { kind: "poly"; points: Array<{ x: number; y: number }>; minZ?: number; maxZ?: number };
};

export type PublishedMapContext = {
  schemaVersion: 2;
  generatedAt: string;
  sourceCommit: string;
  pois: MapPoi[];
  zones: MapZone[];
};

const MAX_POIS = 4000;
const MAX_ZONES = 400;
const MIN_COORD = -10000;
const MAX_COORD = 13000;

const poiKinds = new Set<MapPoiKind>([
  "job",
  "service",
  "vehicles",
  "housing",
  "activity",
  "faction",
  "publicTransport",
]);
const poiIcons = new Set<MapPoiIcon>([
  "247shop",
  "airport",
  "atm",
  "autoSchool",
  "cityHall",
  "dump",
  "fireStation",
  "gasStation",
  "goPostal",
  "hospital",
  "hotel",
  "parking",
  "policeStation",
  "port",
  "roadRepair",
  "trashCollector",
  "vehicleShopPremium",
]);

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || null;
}

function inMapBounds(x: number, y: number): boolean {
  return x >= MIN_COORD && x <= MAX_COORD && y >= MIN_COORD && y <= MAX_COORD;
}

function sanitizeMeta(value: unknown): MapPoiMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const meta: MapPoiMeta = {};
  const type = cleanText(raw.type, 32);
  const priceTier = cleanText(raw.priceTier, 32);
  const salaryRange = cleanText(raw.salaryRange, 48);
  const note = cleanText(raw.note, 160);
  const linkedPage = cleanText(raw.linkedPage, 128);
  const units = finiteNumber(raw.units);
  if (type) meta.type = type;
  if (priceTier) meta.priceTier = priceTier;
  if (salaryRange) meta.salaryRange = salaryRange;
  if (note) meta.note = note;
  if (linkedPage && linkedPage.startsWith("/insights/")) meta.linkedPage = linkedPage;
  if (units !== null && Number.isInteger(units) && units >= 0 && units <= 100000) meta.units = units;
  return Object.keys(meta).length ? meta : undefined;
}

function sanitizePoi(value: unknown): MapPoi | null {
  if (!value || typeof value !== "object") return null;
  const poi = value as Partial<MapPoi>;
  const id = cleanText(poi.id, 96);
  const label = cleanText(poi.label, 96);
  const x = finiteNumber(poi.position?.x);
  const y = finiteNumber(poi.position?.y);
  const z = finiteNumber(poi.position?.z);
  if (!id || !label || !poiKinds.has(poi.kind as MapPoiKind)) return null;
  if (poi.group !== "poi" && poi.group !== "atm") return null;
  if (x === null || y === null || z === null || !inMapBounds(x, y)) return null;
  const icon = poiIcons.has(poi.icon as MapPoiIcon) ? (poi.icon as MapPoiIcon) : undefined;
  const spriteValue = finiteNumber(poi.sprite);
  const colorValue = finiteNumber(poi.color);
  const sprite =
    spriteValue !== null && Number.isInteger(spriteValue) && spriteValue >= 0 && spriteValue <= 1000
      ? spriteValue
      : undefined;
  const color =
    colorValue !== null && Number.isInteger(colorValue) && colorValue >= 0 && colorValue <= 255
      ? colorValue
      : undefined;
  return {
    id,
    label,
    kind: poi.kind as MapPoiKind,
    group: poi.group,
    position: { x, y, z },
    icon,
    sprite,
    color,
    meta: sanitizeMeta(poi.meta),
  };
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
    if (x === null || y === null || radius === null || radius <= 0 || radius > 1000 || !inMapBounds(x, y)) {
      return null;
    }
    return { id, label, kind: zone.kind, shape: { kind: "circle", x, y, radius, minZ, maxZ } };
  }
  if (zone.shape.kind === "poly" && Array.isArray(zone.shape.points)) {
    const points = zone.shape.points.slice(0, 100).map((point) => ({
      x: finiteNumber(point.x),
      y: finiteNumber(point.y),
    }));
    if (points.length < 3 || points.some((point) => point.x === null || point.y === null)) return null;
    if (points.some((point) => !inMapBounds(point.x as number, point.y as number))) return null;
    return {
      id,
      label,
      kind: zone.kind,
      shape: { kind: "poly", points: points as Array<{ x: number; y: number }>, minZ, maxZ },
    };
  }
  return null;
}

export function sanitizeMapContext(parsed: unknown): PublishedMapContext {
  const value = parsed as Partial<PublishedMapContext>;
  if (value.schemaVersion !== 2 || !Array.isArray(value.pois) || !Array.isArray(value.zones)) {
    throw new Error("unsupported map context schema");
  }
  const pois = value.pois
    .slice(0, MAX_POIS)
    .map(sanitizePoi)
    .filter((poi): poi is MapPoi => poi !== null);
  const zones = value.zones
    .slice(0, MAX_ZONES)
    .map(sanitizeZone)
    .filter((zone): zone is MapZone => zone !== null);
  return {
    schemaVersion: 2,
    generatedAt: cleanText(value.generatedAt, 40) ?? "",
    sourceCommit: cleanText(value.sourceCommit, 64) ?? "",
    pois,
    zones,
  };
}

export async function loadPublishedMapContext(): Promise<PublishedMapContext> {
  const path = resolve(process.cwd(), config.insights.mapContextPath);
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return sanitizeMapContext(parsed);
}
