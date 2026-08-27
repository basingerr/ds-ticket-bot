import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Vehicle dealership catalog generator. Pure function of a rejoin-server commit:
// which models each salon sells, at what price, with class + speed + stat data.
// Regenerate manually on release.
//
//   npm run insights:vehicle-catalog -- --source=/path/to/rejoin-server \
//     --output=./exports/vehicle-catalog/vehicle-catalog.json

type DealerVehicle = { model: string; price: number };
type Position = { x: number; y: number; z: number; r?: number };

function arg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${prefix}<path>`);
  return resolve(value);
}

const SHOP_LABELS: Record<string, string> = {
  dump: "Свалка · бюджет",
  econom: "Эконом",
  average: "Средний класс",
  luxury: "Люкс",
  commercial: "Коммерческий",
  motorcycle: "Мотоциклы",
  boat: "Лодки",
};

const source = arg("source");
const output = arg("output");
const moduleUrl = (path: string) => pathToFileURL(resolve(source, path)).href;

const [dealershipModule, vehicleModule] = await Promise.all([
  import(moduleUrl("apps/shared/data/vehicleDealership.ts")),
  import(moduleUrl("apps/shared/data/vehicle.ts")),
]);

const vehicleList = dealershipModule.vehicleList as Record<string, DealerVehicle[]>;
const coords = dealershipModule.vehicleDealershipCoords as Record<string, { carPosition: Position }>;
const vehiclesData = vehicleModule.vehiclesData as Record<
  string,
  {
    name: string;
    label?: string;
    info: { class: string; classId: number; seats: number };
    speed: { maxSpeed: number; maxBraking: number; maxTraction: number; acceleration: number; agility: number };
  }
>;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const shops = Object.entries(vehicleList).map(([id, list]) => {
  const prices = list.map((entry) => entry.price);
  const carPosition = coords[id]?.carPosition;
  const vehicles = list.map((entry) => {
    const data = vehiclesData[entry.model.toLowerCase()];
    return {
      model: entry.model,
      name: data?.label || data?.name || entry.model,
      price: entry.price,
      custom: entry.model.toLowerCase().startsWith("rejoin_"),
      class: data?.info.class ?? null,
      classId: data ? data.info.classId : null,
      seats: data?.info.seats ?? null,
      speedKmh: data ? Math.round(data.speed.maxSpeed * 3.6) : null,
      stats: data
        ? {
            braking: round(data.speed.maxBraking),
            traction: round(data.speed.maxTraction),
            acceleration: round(data.speed.acceleration),
            agility: round(data.speed.agility),
          }
        : null,
    };
  });
  return {
    id,
    label: SHOP_LABELS[id] ?? id,
    count: list.length,
    priceMin: Math.min(...prices),
    priceMax: Math.max(...prices),
    priceAvg: Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length),
    position: carPosition
      ? { x: round(carPosition.x, 1), y: round(carPosition.y, 1), z: round(carPosition.z, 1) }
      : null,
    vehicles,
  };
});

const sourceCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const missing = shops.flatMap((shop) => shop.vehicles.filter((vehicle) => vehicle.class === null).map((vehicle) => vehicle.model));
const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceCommit,
  shops,
};

await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.next`;
await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await rename(temporary, output);
console.log(JSON.stringify({
  output,
  sourceCommit,
  shops: shops.length,
  vehicles: shops.reduce((sum, shop) => sum + shop.count, 0),
  missingStats: missing,
}));
