import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ReviewDepth = "pulse" | "deep" | "baseline";

export type TicketComment = {
  id: string;
  date: string;
  author: string | null;
  authorUsername: string | null;
  source: "discord" | "qa" | "trello";
  text: string;
};

export type TicketStatusChange = {
  date: string;
  from: string | null;
  to: string | null;
};

export type ExportedTicketCard = {
  id: string;
  name: string;
  description: string;
  url: string | null;
  list: { id: string; name: string; closed: boolean | null };
  reviewState: "active" | "done" | "archived";
  closed: boolean;
  dueComplete: boolean;
  labels: Array<{ id: string; name: string; color: string | null }>;
  dateLastActivity: string;
  sourceRevision: string;
  staleDays: number | null;
  ageDays: number | null;
  discord: Record<string, unknown>;
  storedBotStatus: string | null;
  linkedAt: string | null;
  linkUpdatedAt: string | null;
  reconciliationDisabledReason: string | null;
  commentCount: number;
  qaNeedsWorkCount: number;
  failedRetestSignalCount: number;
  reopenCount: number;
  comments: TicketComment[];
  statusHistory: TicketStatusChange[];
  contentHash: string;
};

export type TicketReviewSnapshot = {
  schemaVersion: number;
  generatedAt: string;
  source?: Record<string, unknown>;
  summary: Record<string, unknown>;
  cards: ExportedTicketCard[];
};

export type SemanticSourceRecord = {
  sourceId: string;
  contentHash: string;
  meaning: string;
  classification: "bug" | "exploit" | "feature" | "feedback" | "non-bug" | "unknown";
  subsystem: string | null;
  clusterId: string | null;
  evidenceQuality: "high" | "medium" | "low" | "unknown";
  recoveryBehavior: string | null;
  needsInfo: string | null;
  reviewedAt: string;
};

export type SemanticSourceCache = {
  schemaVersion: 1;
  updatedAt: string | null;
  records: SemanticSourceRecord[];
};

export type TicketReviewState = {
  schemaVersion: 1;
  lastReviewedSnapshot: string | null;
  updatedAt: string | null;
};

const emptyCache: SemanticSourceCache = { schemaVersion: 1, updatedAt: null, records: [] };

export async function loadSemanticSourceCache(path: string): Promise<SemanticSourceCache> {
  if (!existsSync(path)) {
    return emptyCache;
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SemanticSourceCache>;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) {
    throw new Error(`Unsupported semantic source cache: ${path}`);
  }
  return { schemaVersion: 1, updatedAt: parsed.updatedAt ?? null, records: parsed.records };
}

export async function ensureSemanticSourceCache(path: string): Promise<void> {
  if (existsSync(path)) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(emptyCache, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export async function loadTicketReviewState(path: string): Promise<TicketReviewState | null> {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<TicketReviewState>;
  if (parsed.schemaVersion !== 1 || (parsed.lastReviewedSnapshot !== null && typeof parsed.lastReviewedSnapshot !== "string")) {
    throw new Error(`Unsupported ticket review state: ${path}`);
  }
  return {
    schemaVersion: 1,
    lastReviewedSnapshot: parsed.lastReviewedSnapshot ?? null,
    updatedAt: parsed.updatedAt ?? null,
  };
}

export async function ensureTicketReviewState(path: string, lastReviewedSnapshot: string | null): Promise<void> {
  if (existsSync(path)) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const state: TicketReviewState = { schemaVersion: 1, lastReviewedSnapshot, updatedAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function cleanText(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let attachments = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^###\s+Вложения/iu.test(trimmed)) {
      attachments = true;
      continue;
    }
    if (attachments && (/^[-*]\s+https?:\/\//iu.test(trimmed) || trimmed === "")) {
      continue;
    }
    attachments = false;
    if (/^##\s+Discord ticket/iu.test(trimmed)
      || /^\*\*(Автор|Тема|Ссылка):\*\*/iu.test(trimmed)
      || /^###\s+Описание/iu.test(trimmed)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n")
    .replace(/https?:\/\/\S+/giu, "[link]")
    .replace(/\b\d{15,20}\b/gu, "[id]")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function cleanComment(value: string): string {
  return cleanText(value)
    .replace(/^(Комментарий из Discord от|Автор добавил коммент в Discord:)\s*[^:\n]+:\s*/iu, "")
    .trim();
}

function changeTypes(current: ExportedTicketCard, previous: ExportedTicketCard | undefined): string[] {
  if (!previous) {
    return ["new"];
  }
  const changes: string[] = [];
  if (current.contentHash !== previous.contentHash) changes.push("content_changed");
  if (current.list.id !== previous.list.id) changes.push("moved");
  if (current.reviewState !== previous.reviewState) changes.push(`state_${previous.reviewState}_to_${current.reviewState}`);
  if (previous.reviewState !== "active" && current.reviewState === "active") changes.push("reopened");
  if ((previous.staleDays ?? 0) < 14 && (current.staleDays ?? 0) >= 14 && current.reviewState === "active") changes.push("newly_stale");
  if (current.reopenCount > previous.reopenCount) changes.push("new_reopen_event");
  return changes;
}

export function buildReviewBundle(options: {
  current: TicketReviewSnapshot;
  previous: TicketReviewSnapshot | null;
  currentSnapshotName: string;
  previousSnapshotName: string | null;
  depth: ReviewDepth;
  cache: SemanticSourceCache;
}): Record<string, unknown> {
  const previousById = new Map((options.previous?.cards ?? []).map((card) => [card.id, card]));
  const cacheById = new Map(options.cache.records.map((record) => [record.sourceId, record]));
  const candidates = options.current.cards.filter((card) => {
    if (options.depth === "baseline") return true;
    if (options.depth === "deep") return card.reviewState === "active";
    const previous = previousById.get(card.id);
    return !previous || previous.contentHash !== card.contentHash || changeTypes(card, previous).length > 0;
  });
  const records = candidates.map((card) => {
    const previous = previousById.get(card.id);
    const cached = cacheById.get(card.id);
    const cacheHit = cached?.contentHash === card.contentHash;
    return {
      id: card.id,
      name: card.name,
      url: card.url,
      changeTypes: changeTypes(card, previous),
      previous: previous ? { reviewState: previous.reviewState, list: previous.list.name, contentHash: previous.contentHash } : null,
      current: {
        reviewState: card.reviewState,
        list: card.list.name,
        contentHash: card.contentHash,
        dateLastActivity: card.dateLastActivity,
        staleDays: card.staleDays,
        labels: card.labels.map((label) => label.name).filter(Boolean),
        signals: {
          qaNeedsWork: card.qaNeedsWorkCount,
          failedRetest: card.failedRetestSignalCount,
          reopens: card.reopenCount,
        },
      },
      analysisText: cleanText(card.description),
      meaningfulComments: card.comments.map((comment) => ({
        date: comment.date,
        source: comment.source,
        text: cleanComment(comment.text),
      })).filter((comment) => comment.text),
      semanticCache: cacheHit ? { status: "hit", record: cached } : { status: "miss" },
      reviewRequired: !cacheHit,
    };
  });
  const changed = records.filter((record) => (record.changeTypes as string[]).includes("content_changed")).length;
  const added = records.filter((record) => (record.changeTypes as string[]).includes("new")).length;
  const currentIds = new Set(options.current.cards.map((card) => card.id));
  const absentFromCurrent = (options.previous?.cards ?? [])
    .filter((card) => !currentIds.has(card.id))
    .map((card) => ({ id: card.id, name: card.name, url: card.url, previousReviewState: card.reviewState, previousList: card.list.name }));
  return {
    schemaVersion: 1,
    generatedAt: options.current.generatedAt,
    depth: options.depth,
    currentSnapshot: options.currentSnapshotName,
    baselineSnapshot: options.previousSnapshotName,
    summary: {
      includedRecords: records.length,
      reviewRequired: records.filter((record) => record.reviewRequired).length,
      semanticCacheHits: records.filter((record) => !record.reviewRequired).length,
      newCards: added,
      changedCards: changed,
      movedCards: records.filter((record) => (record.changeTypes as string[]).includes("moved")).length,
      completedCards: records.filter((record) => (record.changeTypes as string[]).includes("state_active_to_done")).length,
      archivedCards: records.filter((record) => (record.changeTypes as string[]).some((change) => change.endsWith("_to_archived"))).length,
      reopenedCards: records.filter((record) => (record.changeTypes as string[]).includes("reopened")).length,
      newlyStaleCards: records.filter((record) => (record.changeTypes as string[]).includes("newly_stale")).length,
      absentFromCurrent: absentFromCurrent.length,
    },
    instructions: "Analyze records with reviewRequired=true. Reuse exact-hash semanticCache hits. Open the full snapshot only for ambiguity, high impact, or missing necessary evidence.",
    records,
    absentFromCurrent,
  };
}
