import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../config.js";

// Loader + sanitizer for the vehicle dealership catalog (schemaVersion 1).
// Server-only source file; everything served to the browser is whitelisted here.

export type CatalogVehicle = {
  model: string;
  name: string;
  price: number;
  custom: boolean;
  class: string | null;
  classId: number | null;
  seats: number | null;
  speedKmh: number | null;
  stats: { braking: number; traction: number; acceleration: number; agility: number } | null;
};

export type CatalogShop = {
  id: string;
  label: string;
  count: number;
  priceMin: number;
  priceMax: number;
  priceAvg: number;
  position: { x: number; y: number; z: number } | null;
  vehicles: CatalogVehicle[];
};

export type PublishedVehicleCatalog = {
  schemaVersion: 1;
  generatedAt: string;
  sourceCommit: string;
  shops: CatalogShop[];
};

const MAX_SHOPS = 32;
const MAX_VEHICLES_PER_SHOP = 500;

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || null;
}

function intInRange(value: unknown, min: number, max: number): number | null {
  const parsed = finiteNumber(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function clamp01x(value: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < 0) return 0;
  return Math.min(parsed, 10);
}

function sanitizeVehicle(value: unknown): CatalogVehicle | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const model = cleanText(raw.model, 64);
  const price = intInRange(raw.price, 0, 100_000_000);
  if (!model || price === null) return null;
  const rawStats = raw.stats && typeof raw.stats === "object" ? (raw.stats as Record<string, unknown>) : null;
  return {
    model,
    name: cleanText(raw.name, 96) ?? model,
    price,
    custom: raw.custom === true,
    class: cleanText(raw.class, 32),
    classId: intInRange(raw.classId, 0, 100),
    seats: intInRange(raw.seats, 0, 64),
    speedKmh: intInRange(raw.speedKmh, 0, 2000),
    stats: rawStats
      ? {
          braking: clamp01x(rawStats.braking),
          traction: clamp01x(rawStats.traction),
          acceleration: clamp01x(rawStats.acceleration),
          agility: clamp01x(rawStats.agility),
        }
      : null,
  };
}

function sanitizeShop(value: unknown): CatalogShop | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = cleanText(raw.id, 48);
  const label = cleanText(raw.label, 64);
  if (!id || !label) return null;
  const vehicles = Array.isArray(raw.vehicles)
    ? raw.vehicles.slice(0, MAX_VEHICLES_PER_SHOP).map(sanitizeVehicle).filter((vehicle): vehicle is CatalogVehicle => vehicle !== null)
    : [];
  const position =
    raw.position && typeof raw.position === "object"
      ? (() => {
          const point = raw.position as Record<string, unknown>;
          const x = finiteNumber(point.x);
          const y = finiteNumber(point.y);
          const z = finiteNumber(point.z);
          return x !== null && y !== null && z !== null ? { x, y, z } : null;
        })()
      : null;
  const prices = vehicles.map((vehicle) => vehicle.price);
  return {
    id,
    label,
    count: vehicles.length,
    priceMin: intInRange(raw.priceMin, 0, 100_000_000) ?? (prices.length ? Math.min(...prices) : 0),
    priceMax: intInRange(raw.priceMax, 0, 100_000_000) ?? (prices.length ? Math.max(...prices) : 0),
    priceAvg: intInRange(raw.priceAvg, 0, 100_000_000)
      ?? (prices.length ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length) : 0),
    position,
    vehicles,
  };
}

export function sanitizeVehicleCatalog(parsed: unknown): PublishedVehicleCatalog {
  const value = parsed as Partial<PublishedVehicleCatalog>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.shops)) {
    throw new Error("unsupported vehicle catalog schema");
  }
  const shops = value.shops
    .slice(0, MAX_SHOPS)
    .map(sanitizeShop)
    .filter((shop): shop is CatalogShop => shop !== null);
  return {
    schemaVersion: 1,
    generatedAt: cleanText(value.generatedAt, 40) ?? "",
    sourceCommit: cleanText(value.sourceCommit, 64) ?? "",
    shops,
  };
}

export async function loadPublishedVehicleCatalog(): Promise<PublishedVehicleCatalog> {
  const path = resolve(process.cwd(), config.insights.vehicleCatalogPath);
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return sanitizeVehicleCatalog(parsed);
}
