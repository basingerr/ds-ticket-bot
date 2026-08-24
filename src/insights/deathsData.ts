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
