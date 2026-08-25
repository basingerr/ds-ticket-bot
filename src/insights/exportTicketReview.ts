import Database from "better-sqlite3";
import dotenv from "dotenv";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import {
  buildReviewBundle,
  ensureSemanticSourceCache,
  ensureTicketReviewState,
  loadSemanticSourceCache,
  loadTicketReviewState,
  type ExportedTicketCard,
  type TicketReviewSnapshot,
} from "./ticketReviewArtifacts.js";

dotenv.config();

type TrelloList = {
  id: string;
  name: string;
  closed?: boolean;
};

type TrelloLabel = {
  id: string;
  name: string;
  color: string | null;
};

type TrelloCardResponse = {
  id: string;
  name: string;
  desc?: string;
  idList: string;
  closed?: boolean;
  dueComplete?: boolean;
  dateLastActivity: string;
  shortUrl?: string;
  url?: string;
  labels?: TrelloLabel[];
};

type TrelloActionResponse = {
  id: string;
  type: string;
  date: string;
  data?: {
    text?: string;
    listBefore?: { id: string; name: string };
    listAfter?: { id: string; name: string };
    old?: Record<string, unknown>;
    card?: { id: string; name: string };
  };
  memberCreator?: {
    id: string;
    fullName?: string;
    username?: string;
  };
};

type TicketLinkRow = {
  discord_thread_id: string;
  discord_author_id: string | null;
  trello_card_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  discord_missing_at?: string | null;
  reconcile_disabled_reason?: string | null;
};

type ParsedArgs = {
  closedDays: number;
  actionLimit: number;
  mode: "pulse" | "deep" | "baseline";
};

type PreviousSnapshot = TicketReviewSnapshot & {
  source?: TicketReviewSnapshot["source"] & {
    trelloBoardId?: string;
    actionLimit?: number;
  };
};

const gzipAsync = promisify(gzip);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function numericArg(name: string, fallback: number, min: number, max: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function parseArgs(): ParsedArgs {
  const modeArgument = process.argv.slice(2).find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length);
  const fullAlias = process.argv.slice(2).includes("--full");
  const mode = fullAlias ? "baseline" : (modeArgument ?? "pulse");
  if (mode !== "pulse" && mode !== "deep" && mode !== "baseline") {
    throw new Error("--mode must be pulse, deep, or baseline");
  }
  return {
    closedDays: numericArg("closed-days", 30, 0, 3650),
    actionLimit: numericArg("action-limit", 200, 1, 1000),
    mode,
  };
}

const trelloKey = requiredEnv("TRELLO_KEY");
const trelloToken = requiredEnv("TRELLO_TOKEN");
const trelloBoardId = requiredEnv("TRELLO_BOARD_ID");
const trelloRequestSpacingMs = 150;
let trelloRequestSchedule = Promise.resolve();
let lastTrelloRequestStartedAt = 0;

function trelloUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://api.trello.com/1${path}`);
  url.searchParams.set("key", trelloKey);
  url.searchParams.set("token", trelloToken);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitForTrelloRequestSlot(): Promise<void> {
  const scheduled = trelloRequestSchedule.then(async () => {
    const remaining = trelloRequestSpacingMs - (Date.now() - lastTrelloRequestStartedAt);
    if (remaining > 0) {
      await wait(remaining);
    }
    lastTrelloRequestStartedAt = Date.now();
  });
  trelloRequestSchedule = scheduled.catch(() => undefined);
  await scheduled;
}

async function trelloGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = trelloUrl(path, params);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitForTrelloRequestSlot();
    const response = await fetch(url);
    if (response.ok) {
      return await response.json() as T;
    }

    const body = await response.text();
    if (response.status !== 429 || attempt === 4) {
      throw new Error(`Trello API error ${response.status}: ${body}`);
    }

    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 10_000 * (attempt + 1);
    console.warn(`Trello rate limit reached; retrying in ${Math.ceil(retryAfterMs / 1000)}s`);
    await wait(retryAfterMs);
  }

  throw new Error("Trello request retry loop ended unexpectedly");
}

async function loadCardActions(cards: TrelloCardResponse[], actionLimit: number): Promise<Map<string, TrelloActionResponse[]>> {
  const actionsByCardId = new Map<string, TrelloActionResponse[]>();

  for (let start = 0; start < cards.length; start += 10) {
    const batch = cards.slice(start, start + 10);
    const urls = batch.map((card) => {
      const params = new URLSearchParams({
        filter: "commentCard,updateCard",
        limit: String(actionLimit),
        fields: "id,type,date,data",
        memberCreator: "true",
        memberCreator_fields: "id,fullName,username",
      });
      return `/cards/${encodeURIComponent(card.id)}/actions?${params.toString()}`;
    });
    const responses = await trelloGet<Array<Record<string, unknown>>>("/batch", { urls: urls.join(",") });

    responses.forEach((response, index) => {
      const payload = response["200"];
      if (!Array.isArray(payload)) {
        throw new Error(`Trello batch action request failed for card ${batch[index].id}`);
      }
      actionsByCardId.set(batch[index].id, payload as TrelloActionResponse[]);
    });
  }

  return actionsByCardId;
}

function databasePath(): string | null {
  const databaseUrl = process.env.DATABASE_URL?.trim() || "file:./data/tickets.sqlite";
  if (!databaseUrl.startsWith("file:")) {
    return null;
  }
  return resolve(process.cwd(), databaseUrl.slice("file:".length));
}

function loadTicketLinks(): Map<string, TicketLinkRow> {
  const path = databasePath();
  if (!path || !existsSync(path)) {
    return new Map();
  }

  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const columns = database.prepare("PRAGMA table_info(ticket_links)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const discordMissing = names.has("discord_missing_at") ? "discord_missing_at" : "NULL AS discord_missing_at";
    const disabledReason = names.has("reconcile_disabled_reason")
      ? "reconcile_disabled_reason"
      : "NULL AS reconcile_disabled_reason";
    const rows = database.prepare(`
      SELECT discord_thread_id, discord_author_id, trello_card_id, status, created_at, updated_at,
             ${discordMissing}, ${disabledReason}
      FROM ticket_links
    `).all() as TicketLinkRow[];
    return new Map(rows.map((row) => [row.trello_card_id, row]));
  } finally {
    database.close();
  }
}

function descriptionField(description: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = description.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)`, "i"));
  return match?.[1]?.trim() || null;
}

function discordThreadIdFromUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }
  return url.match(/discord\.com\/channels\/\d+\/(\d+)/iu)?.[1] ?? null;
}

function daysBetween(earlier: string, later: Date): number | null {
  const timestamp = Date.parse(earlier);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.max(0, Math.floor((later.getTime() - timestamp) / 86_400_000));
}

function commentSource(text: string): "discord" | "qa" | "trello" {
  if (/^QA (сообщил|подтвердил):/iu.test(text)) {
    return "qa";
  }
  if (/^(Комментарий из Discord от|Автор добавил коммент в Discord:)/iu.test(text)) {
    return "discord";
  }
  return "trello";
}

function isFinalListName(listName: string): boolean {
  return /^(готово|done|verified|completed|closed|rejected\s*\/\s*duplicate)$/iu.test(listName.trim());
}

function reviewState(card: TrelloCardResponse, listName: string): "active" | "done" | "archived" {
  if (card.closed) {
    return "archived";
  }
  if (card.dueComplete || isFinalListName(listName)) {
    return "done";
  }
  return "active";
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cardSourceRevision(card: TrelloCardResponse): string {
  return stableHash({
    name: card.name,
    description: card.desc ?? "",
    listId: card.idList,
    closed: card.closed ?? false,
    dueComplete: card.dueComplete ?? false,
    dateLastActivity: card.dateLastActivity,
    labels: [...(card.labels ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function previousCardSourceRevision(card: ExportedTicketCard): string {
  if (typeof card.sourceRevision === "string" && card.sourceRevision) {
    return card.sourceRevision;
  }
  return stableHash({
    name: card.name,
    description: card.description,
    listId: card.list.id,
    closed: card.closed,
    dueComplete: card.dueComplete,
    dateLastActivity: card.dateLastActivity,
    labels: [...card.labels].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

async function loadLatestCompatibleSnapshot(exportDir: string, actionLimit: number): Promise<{ name: string; snapshot: PreviousSnapshot } | null> {
  if (!existsSync(exportDir)) {
    return null;
  }
  const names = (await readdir(exportDir))
    .filter((name) => /^snapshot-.*\.json$/u.test(name))
    .sort((left, right) => right.localeCompare(left));
  for (const name of names) {
    try {
      const snapshot = JSON.parse(await readFile(resolve(exportDir, name), "utf8")) as PreviousSnapshot;
      if (snapshot.schemaVersion === 4
        && snapshot.source?.trelloBoardId === trelloBoardId
        && snapshot.source?.actionLimit === actionLimit
        && Array.isArray(snapshot.cards)) {
        return { name, snapshot };
      }
    } catch (error) {
      console.warn(`Skipping unreadable prior snapshot ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

async function loadCompatibleSnapshotByName(exportDir: string, name: string | null, actionLimit: number): Promise<{ name: string; snapshot: PreviousSnapshot } | null> {
  if (!name || !/^snapshot-.*\.json$/u.test(name)) {
    return null;
  }
  const path = resolve(exportDir, name);
  if (!existsSync(path)) {
    return null;
  }
  const snapshot = JSON.parse(await readFile(path, "utf8")) as PreviousSnapshot;
  if (snapshot.schemaVersion !== 4
    || snapshot.source?.trelloBoardId !== trelloBoardId
    || snapshot.source?.actionLimit !== actionLimit
    || !Array.isArray(snapshot.cards)) {
    return null;
  }
  return { name, snapshot };
}

async function inferReviewedSnapshotFromLedger(): Promise<string | null> {
  const ledgerPath = resolve(process.cwd(), "reports", "the-manager", "semantic-ledger.json");
  if (!existsSync(ledgerPath)) {
    return null;
  }
  try {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as { sourceReviews?: Array<{ snapshot?: string }> };
    const snapshots = (ledger.sourceReviews ?? [])
      .map((review) => review.snapshot)
      .filter((snapshot): snapshot is string => typeof snapshot === "string" && snapshot.length > 0);
    return snapshots.length > 0 ? basename(snapshots[snapshots.length - 1]) : null;
  } catch (error) {
    console.warn(`Could not infer review boundary from semantic ledger: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const generatedAt = new Date();
  const closedCutoff = new Date(generatedAt.getTime() - args.closedDays * 86_400_000);
  const linksByCardId = loadTicketLinks();
  const exportDir = resolve(process.cwd(), "exports", "ticket-review");
  await mkdir(exportDir, { recursive: true });
  const previousSnapshot = args.mode === "baseline"
    ? null
    : await loadLatestCompatibleSnapshot(exportDir, args.actionLimit);
  const reviewStatePath = resolve(process.cwd(), "reports", "the-manager", "ticket-review-state.json");
  const inferredReviewBoundary = await inferReviewedSnapshotFromLedger() ?? previousSnapshot?.name ?? null;
  await ensureTicketReviewState(reviewStatePath, inferredReviewBoundary);
  const reviewStateMemory = await loadTicketReviewState(reviewStatePath);
  const analysisBaseline = args.mode === "baseline"
    ? null
    : await loadCompatibleSnapshotByName(exportDir, reviewStateMemory?.lastReviewedSnapshot ?? null, args.actionLimit);

  const [lists, allCards] = await Promise.all([
    trelloGet<TrelloList[]>(`/boards/${encodeURIComponent(trelloBoardId)}/lists`, {
      filter: "all",
      fields: "id,name,closed",
    }),
    trelloGet<TrelloCardResponse[]>(`/boards/${encodeURIComponent(trelloBoardId)}/cards`, {
      filter: "all",
      fields: "id,name,desc,idList,closed,dueComplete,dateLastActivity,url,shortUrl,labels",
    }),
  ]);

  const listsById = new Map(lists.map((list) => [list.id, list]));
  const cards = allCards.filter((card) => {
    const state = reviewState(card, listsById.get(card.idList)?.name ?? "Unknown");
    return state === "active"
      || (args.closedDays > 0 && Date.parse(card.dateLastActivity) >= closedCutoff.getTime());
  });
  const previousByCardId = new Map((previousSnapshot?.snapshot.cards ?? []).map((card) => [card.id, card]));
  const cardsNeedingActions = cards.filter((card) => {
    const previous = previousByCardId.get(card.id);
    return !previous || previousCardSourceRevision(previous) !== cardSourceRevision(card);
  });
  const actionsByCardId = await loadCardActions(cardsNeedingActions, args.actionLimit);

  const exportedCards: ExportedTicketCard[] = cards.map((card) => {
    const actions = actionsByCardId.get(card.id) ?? [];
    const previous = previousByCardId.get(card.id);
    const reusedActionHistory = previous && !actionsByCardId.has(card.id) ? previous : null;
    const link = linksByCardId.get(card.id) ?? null;
    const list = listsById.get(card.idList);
    const state = reviewState(card, list?.name ?? "Unknown");
    const discordUrl = descriptionField(card.desc ?? "", "Ссылка");
    const comments = reusedActionHistory?.comments ?? actions
      .filter((action) => action.type === "commentCard" && action.data?.text)
      .map((action) => ({
        id: action.id,
        date: action.date,
        author: action.memberCreator?.fullName ?? action.memberCreator?.username ?? null,
        authorUsername: action.memberCreator?.username ?? null,
        source: commentSource(action.data?.text ?? ""),
        text: action.data?.text ?? "",
      }))
      .sort((left, right) => left.date.localeCompare(right.date));
    const statusHistory = reusedActionHistory?.statusHistory ?? actions
      .filter((action) => action.type === "updateCard" && action.data?.listBefore && action.data?.listAfter)
      .map((action) => ({
        date: action.date,
        from: action.data?.listBefore?.name ?? null,
        to: action.data?.listAfter?.name ?? null,
      }))
      .sort((left, right) => left.date.localeCompare(right.date));
    const qaNeedsWorkCount = comments.filter((comment) => /нужна доработка/iu.test(comment.text)).length;
    const failedRetestSignalCount = comments.filter((comment) => (
      /вс[её]\s+так\s+же\s+воспроизвод|по-прежнему\s+воспроизвод|не\s+исправлен|не\s+починен|still\s+reproduc/iu.test(comment.text)
    )).length;
    const reopenCount = statusHistory.filter((change) => (
      change.from !== null && change.to !== null && isFinalListName(change.from) && !isFinalListName(change.to)
    )).length;
    const meaningfulContent = {
      name: card.name,
      description: card.desc ?? "",
      listId: card.idList,
      closed: card.closed ?? false,
      dueComplete: card.dueComplete ?? false,
      labels: card.labels ?? [],
      comments,
      statusHistory,
    };

    return {
      id: card.id,
      name: card.name,
      description: card.desc ?? "",
      url: card.url ?? card.shortUrl ?? null,
      list: { id: card.idList, name: list?.name ?? "Unknown", closed: list?.closed ?? null },
      reviewState: state,
      closed: card.closed ?? false,
      dueComplete: card.dueComplete ?? false,
      labels: card.labels ?? [],
      dateLastActivity: card.dateLastActivity,
      sourceRevision: cardSourceRevision(card),
      staleDays: daysBetween(card.dateLastActivity, generatedAt),
      ageDays: link ? daysBetween(link.created_at, generatedAt) : null,
      discord: {
        threadId: link?.discord_thread_id ?? discordThreadIdFromUrl(discordUrl),
        authorId: link?.discord_author_id ?? null,
        url: discordUrl,
        author: descriptionField(card.desc ?? "", "Автор"),
        topic: descriptionField(card.desc ?? "", "Тема"),
        missingAt: link?.discord_missing_at ?? null,
      },
      storedBotStatus: link?.status ?? null,
      linkedAt: link?.created_at ?? null,
      linkUpdatedAt: link?.updated_at ?? null,
      reconciliationDisabledReason: link?.reconcile_disabled_reason ?? null,
      commentCount: comments.length,
      qaNeedsWorkCount,
      failedRetestSignalCount,
      reopenCount,
      comments,
      statusHistory,
      contentHash: stableHash(meaningfulContent),
    };
  });

  exportedCards.sort((left, right) => right.dateLastActivity.localeCompare(left.dateLastActivity));
  const countsByList = Object.fromEntries(
    [...new Set(exportedCards.map((card) => card.list.name))]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [name, exportedCards.filter((card) => card.list.name === name).length]),
  );
  const captureMode = previousSnapshot ? "incremental" : "baseline";
  const snapshot: TicketReviewSnapshot = {
    schemaVersion: 4,
    generatedAt: generatedAt.toISOString(),
    source: {
      trelloBoardId,
      databasePath: databasePath(),
      closedDays: args.closedDays,
      actionLimit: args.actionLimit,
      readOnly: true,
      requestedDepth: args.mode,
      captureMode,
      baselineSnapshot: previousSnapshot?.name ?? null,
      reusedActionHistories: cards.length - cardsNeedingActions.length,
      fetchedActionHistories: cardsNeedingActions.length,
    },
    summary: {
      exportedCards: exportedCards.length,
      activeCards: exportedCards.filter((card) => card.reviewState === "active").length,
      recentDoneCards: exportedCards.filter((card) => card.reviewState === "done").length,
      recentArchivedCards: exportedCards.filter((card) => card.reviewState === "archived").length,
      linkedCards: exportedCards.filter((card) => card.discord.threadId).length,
      staleActiveCards14Days: exportedCards.filter((card) => card.reviewState === "active" && (card.staleDays ?? 0) >= 14).length,
      qaNeedsWorkEvents: exportedCards.reduce((total, card) => total + card.qaNeedsWorkCount, 0),
      failedRetestSignals: exportedCards.reduce((total, card) => total + card.failedRetestSignalCount, 0),
      reopenEvents: exportedCards.reduce((total, card) => total + card.reopenCount, 0),
      countsByList,
    },
    cards: exportedCards,
  };

  const timestamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  const outputPath = resolve(exportDir, `snapshot-${timestamp}.json`);
  const serializedSnapshot = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(outputPath, serializedSnapshot, { encoding: "utf8", flag: "wx" });
  const gzipPath = `${outputPath}.gz`;
  await writeFile(gzipPath, await gzipAsync(Buffer.from(serializedSnapshot, "utf8")), { flag: "wx" });

  const semanticCachePath = resolve(process.cwd(), "reports", "the-manager", "ticket-source-cache.json");
  await ensureSemanticSourceCache(semanticCachePath);
  const semanticCache = await loadSemanticSourceCache(semanticCachePath);
  const bundle = buildReviewBundle({
    current: snapshot,
    previous: analysisBaseline?.snapshot ?? null,
    currentSnapshotName: basename(outputPath),
    previousSnapshotName: analysisBaseline?.name ?? null,
    depth: args.mode,
    cache: semanticCache,
  });
  const bundlePath = resolve(exportDir, `review-bundle-${timestamp}.json`);
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  console.log(`Ticket review snapshot written: ${outputPath}`);
  console.log(`Compressed snapshot written: ${gzipPath}`);
  console.log(`Manager review bundle written: ${bundlePath}`);
  console.log(`Capture: ${captureMode}; action histories fetched: ${cardsNeedingActions.length}; reused: ${cards.length - cardsNeedingActions.length}`);
  console.log(`Cards: ${snapshot.summary.exportedCards} (${snapshot.summary.activeCards} active, ${snapshot.summary.recentDoneCards} recent done, ${snapshot.summary.recentArchivedCards} recent archived)`);
  console.log(`Linked to Discord: ${snapshot.summary.linkedCards}; stale active 14d+: ${snapshot.summary.staleActiveCards14Days}; QA needs-work: ${snapshot.summary.qaNeedsWorkEvents}; failed-retest signals: ${snapshot.summary.failedRetestSignals}; reopens: ${snapshot.summary.reopenEvents}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
