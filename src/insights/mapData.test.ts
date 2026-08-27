import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeMapContext } from "./mapData.js";

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    generatedAt: "2026-08-27T00:00:00.000Z",
    sourceCommit: "abc123",
    pois: [],
    zones: [],
    ...overrides,
  };
}

function poi(overrides: Record<string, unknown> = {}) {
  return {
    id: "job:trashCollector",
    label: "Мусорщик",
    kind: "job",
    group: "poi",
    position: { x: -625.7, y: -1637.8, z: 25.9 },
    ...overrides,
  };
}

test("rejects a non-v2 schema", () => {
  assert.throws(() => sanitizeMapContext(baseContext({ schemaVersion: 1 })));
  assert.throws(() => sanitizeMapContext({}));
});

test("keeps a valid POI and drops unknown fields", () => {
  const result = sanitizeMapContext(baseContext({ pois: [poi({ hacked: "<script>", sprite: 795 })] }));
  assert.equal(result.pois.length, 1);
  assert.equal(result.pois[0].kind, "job");
  assert.equal(result.pois[0].sprite, 795);
  assert.ok(!("hacked" in result.pois[0]));
});

test("drops POIs with an unknown kind or out-of-bounds position", () => {
  const result = sanitizeMapContext(
    baseContext({
      pois: [
        poi({ id: "x:1", kind: "criminal" }),
        poi({ id: "x:2", position: { x: 999999, y: 0, z: 0 } }),
        poi({ id: "x:3", label: "  " }),
      ],
    }),
  );
  assert.equal(result.pois.length, 0);
});

test("sanitizes meta: whitelisted keys only, internal linkedPage only", () => {
  const result = sanitizeMapContext(
    baseContext({
      pois: [
        poi({
          meta: {
            type: "jobStart",
            units: 12,
            linkedPage: "https://evil.example/x",
            secret: "drop me",
          },
        }),
        poi({ id: "salon:econom", kind: "vehicles", meta: { linkedPage: "/insights/dealership#salon-econom" } }),
      ],
    }),
  );
  assert.deepEqual(result.pois[0].meta, { type: "jobStart", units: 12 });
  assert.equal(result.pois[1].meta?.linkedPage, "/insights/dealership#salon-econom");
});

test("keeps circle and poly zones, drops malformed ones", () => {
  const result = sanitizeMapContext(
    baseContext({
      zones: [
        { id: "safe:a", label: "Safe A", kind: "safe", shape: { kind: "circle", x: -1040, y: -2740, radius: 120 } },
        { id: "police:b", label: "Police B", kind: "police", shape: { kind: "poly", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 1 }] } },
        { id: "safe:c", label: "Bad", kind: "safe", shape: { kind: "circle", x: 0, y: 0, radius: 0 } },
        { id: "safe:d", label: "Bad poly", kind: "safe", shape: { kind: "poly", points: [{ x: 1, y: 1 }] } },
      ],
    }),
  );
  assert.equal(result.zones.length, 2);
  assert.deepEqual(result.zones.map((zone) => zone.id), ["safe:a", "police:b"]);
});
