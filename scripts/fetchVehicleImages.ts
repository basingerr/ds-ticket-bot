import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Downloads vanilla vehicle preview images (docs.fivem.net) referenced by the
// generated vehicle catalog into a local dir, so the dealership page can serve
// them from 'self' under the strict Insights CSP. Custom (rejoin_*) models have no
// upstream art and are skipped — the page shows a placeholder for those.
//
//   npm run insights:vehicle-images
//   npm run insights:vehicle-images -- --catalog=./exports/vehicle-catalog/vehicle-catalog.json --out=./exports/vehicle-catalog/img

const UPSTREAM = "https://docs.fivem.net/vehicles/";

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  return value ? resolve(value) : resolve(fallback);
}

const catalogPath = arg("catalog", "./exports/vehicle-catalog/vehicle-catalog.json");
const outDir = arg("out", "./exports/vehicle-catalog/img");

const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
  shops: Array<{ vehicles: Array<{ model: string; custom: boolean }> }>;
};

const models = [
  ...new Set(
    catalog.shops
      .flatMap((shop) => shop.vehicles)
      .filter((vehicle) => !vehicle.custom && /^[a-z0-9_]+$/.test(vehicle.model))
      .map((vehicle) => vehicle.model),
  ),
];

await mkdir(outDir, { recursive: true });
const existing = new Set(await readdir(outDir).catch(() => [] as string[]));

let downloaded = 0;
let missing = 0;
let skipped = 0;

for (const model of models) {
  const file = `${model}.webp`;
  if (existing.has(file)) {
    skipped += 1;
    continue;
  }
  try {
    const response = await fetch(`${UPSTREAM}${model}.webp`);
    if (!response.ok) {
      missing += 1;
      continue;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(resolve(outDir, file), buffer);
    downloaded += 1;
  } catch {
    missing += 1;
  }
}

console.log(JSON.stringify({ outDir, models: models.length, downloaded, skipped, missing }));
