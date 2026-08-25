import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewBundle,
  type ExportedTicketCard,
  type TicketReviewSnapshot,
} from "./ticketReviewArtifacts.js";

function card(overrides: Partial<ExportedTicketCard> = {}): ExportedTicketCard {
  return {
    id: "card-1",
    name: "Broken delivery",
    description: "## Discord ticket\n\n**Автор:** Tester (123456789012345678)\n**Ссылка:** https://discord.com/example\n\n### Описание\nDelivery fails\n\n### Вложения\n- https://cdn.example/file.png?secret=1",
    url: "https://trello.com/c/example",
    list: { id: "todo", name: "To Do", closed: false },
    reviewState: "active",
    closed: false,
    dueComplete: false,
    labels: [],
    dateLastActivity: "2026-08-25T00:00:00.000Z",
    sourceRevision: "revision-1",
    staleDays: 0,
    ageDays: 1,
    discord: {},
    storedBotStatus: null,
    linkedAt: null,
    linkUpdatedAt: null,
    reconciliationDisabledReason: null,
    commentCount: 1,
    qaNeedsWorkCount: 0,
    failedRetestSignalCount: 0,
    reopenCount: 0,
    comments: [{
      id: "comment-1",
      date: "2026-08-25T00:00:00.000Z",
      author: "Tester",
      authorUsername: "tester",
      source: "discord",
      text: "Комментарий из Discord от Tester: Still broken https://cdn.example/log.txt",
    }],
    statusHistory: [],
    contentHash: "hash-1",
    ...overrides,
  };
}

function snapshot(cards: ExportedTicketCard[]): TicketReviewSnapshot {
  return { schemaVersion: 4, generatedAt: "2026-08-25T00:00:00.000Z", summary: {}, cards };
}

test("pulse bundle includes changed records, sanitizes private boilerplate, and reuses exact-hash semantics", () => {
  const previous = card({ contentHash: "old-hash" });
  const current = card();
  const bundle = buildReviewBundle({
    current: snapshot([current]),
    previous: snapshot([previous]),
    currentSnapshotName: "current.json",
    previousSnapshotName: "previous.json",
    depth: "pulse",
    cache: {
      schemaVersion: 1,
      updatedAt: "2026-08-25T00:00:00.000Z",
      records: [{
        sourceId: current.id,
        contentHash: current.contentHash,
        meaning: "Delivery cannot complete",
        classification: "bug",
        subsystem: "jobs",
        clusterId: "delivery",
        evidenceQuality: "high",
        recoveryBehavior: null,
        needsInfo: null,
        reviewedAt: "2026-08-25T00:00:00.000Z",
      }],
    },
  }) as { records: Array<Record<string, unknown>>; summary: Record<string, number> };

  assert.equal(bundle.records.length, 1);
  assert.equal(bundle.records[0].reviewRequired, false);
  assert.equal(bundle.records[0].analysisText, "Delivery fails");
  const comments = bundle.records[0].meaningfulComments as Array<{ text: string }>;
  assert.equal(comments[0].text, "Still broken [link]");
  assert.equal(bundle.summary.semanticCacheHits, 1);
});

test("pulse skips unchanged records while deep includes active records", () => {
  const unchanged = card();
  const cache = { schemaVersion: 1 as const, updatedAt: null, records: [] };
  const pulse = buildReviewBundle({
    current: snapshot([unchanged]),
    previous: snapshot([unchanged]),
    currentSnapshotName: "current.json",
    previousSnapshotName: "previous.json",
    depth: "pulse",
    cache,
  }) as { records: unknown[] };
  const deep = buildReviewBundle({
    current: snapshot([unchanged]),
    previous: snapshot([unchanged]),
    currentSnapshotName: "current.json",
    previousSnapshotName: "previous.json",
    depth: "deep",
    cache,
  }) as { records: unknown[] };

  assert.equal(pulse.records.length, 0);
  assert.equal(deep.records.length, 1);
});

test("bundle reports cards that left the current snapshot window", () => {
  const missing = card({ id: "missing-card", reviewState: "archived" });
  const bundle = buildReviewBundle({
    current: snapshot([]),
    previous: snapshot([missing]),
    currentSnapshotName: "current.json",
    previousSnapshotName: "previous.json",
    depth: "pulse",
    cache: { schemaVersion: 1, updatedAt: null, records: [] },
  }) as { absentFromCurrent: Array<{ id: string }>; summary: Record<string, number> };

  assert.deepEqual(bundle.absentFromCurrent, [{
    id: "missing-card",
    name: "Broken delivery",
    url: "https://trello.com/c/example",
    previousReviewState: "archived",
    previousList: "To Do",
  }]);
  assert.equal(bundle.summary.absentFromCurrent, 1);
});
