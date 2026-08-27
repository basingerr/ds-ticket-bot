import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeVehicleCatalog } from "./vehicleCatalogData.js";

function base(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-27T00:00:00.000Z",
    sourceCommit: "abc123",
    shops: [],
    ...overrides,
  };
}

function shop(overrides: Record<string, unknown> = {}) {
  return {
    id: "econom",
    label: "Эконом",
    priceMin: 8500,
    priceMax: 23000,
    priceAvg: 15000,
    position: { x: -49.4, y: -1684, z: 28.8 },
    vehicles: [
      { model: "asbo", name: "asbo", price: 8500, custom: false, class: "COMPACT", classId: 0, seats: 4, speedKmh: 137, stats: { braking: 0.47, traction: 1.92, acceleration: 0.23, agility: 0.61 } },
    ],
    ...overrides,
  };
}

test("rejects a non-v1 schema", () => {
  assert.throws(() => sanitizeVehicleCatalog(base({ schemaVersion: 2 })));
  assert.throws(() => sanitizeVehicleCatalog({ shops: "nope" }));
});

test("keeps a valid shop and recomputes count", () => {
  const result = sanitizeVehicleCatalog(base({ shops: [shop()] }));
  assert.equal(result.shops.length, 1);
  assert.equal(result.shops[0].count, 1);
  assert.equal(result.shops[0].vehicles[0].class, "COMPACT");
});

test("drops vehicles missing a model or price; keeps null stats", () => {
  const result = sanitizeVehicleCatalog(
    base({
      shops: [
        shop({
          vehicles: [
            { model: "", price: 1 },
            { model: "voodoo2", price: "x" },
            { model: "bfinjection", name: "bfinjection", price: 5000, custom: false, class: null, classId: null, seats: null, speedKmh: null, stats: null },
          ],
        }),
      ],
    }),
  );
  assert.equal(result.shops[0].vehicles.length, 1);
  assert.equal(result.shops[0].vehicles[0].model, "bfinjection");
  assert.equal(result.shops[0].vehicles[0].stats, null);
});

test("clamps stat values and drops unknown vehicle fields", () => {
  const result = sanitizeVehicleCatalog(
    base({
      shops: [
        shop({
          vehicles: [
            { model: "x", price: 1, secret: "drop", stats: { braking: -5, traction: 999, acceleration: 0.3, agility: "bad" } },
          ],
        }),
      ],
    }),
  );
  const vehicle = result.shops[0].vehicles[0];
  assert.equal(vehicle.stats?.braking, 0);
  assert.equal(vehicle.stats?.traction, 10);
  assert.equal(vehicle.stats?.agility, 0);
  assert.ok(!("secret" in vehicle));
});

test("falls back to computed price stats when fields are absent", () => {
  const result = sanitizeVehicleCatalog(
    base({
      shops: [
        {
          id: "dump",
          label: "Свалка",
          vehicles: [
            { model: "a", price: 1000 },
            { model: "b", price: 3000 },
          ],
        },
      ],
    }),
  );
  assert.equal(result.shops[0].priceMin, 1000);
  assert.equal(result.shops[0].priceMax, 3000);
  assert.equal(result.shops[0].priceAvg, 2000);
});
