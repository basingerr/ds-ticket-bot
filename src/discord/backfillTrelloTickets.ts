import { ChannelType, ForumChannel, Message, ThreadChannel } from "discord.js";
import { config } from "../config.js";
import { initDatabase } from "../db/database.js";
import { createTicketLink, findByDiscordThreadId } from "../db/ticketLinks.js";
import { createTrelloCard, findTrelloCardByDiscordThreadId, type CreatedTrelloCard } from "../trello/client.js";
import { createDiscordClient } from "./client.js";
import { buildTrelloDescription, fetchStarterMessage, trelloCardNameFromThreadName } from "./ticketContent.js";

const apply = process.argv.includes("--apply");
const includeArchived = !process.argv.includes("--active-only");
const excludeCheckMarked = process.argv.includes("--without-check");
const maxThreadsArg = process.argv.find((arg) => arg.startsWith("--max="));
const maxThreads = maxThreadsArg ? Number(maxThreadsArg.slice("--max=".length)) : 1000;

if (!Number.isFinite(maxThreads) || maxThreads <= 0) {
  throw new Error("Invalid --max value");
}

type CollectedThreads = {
  threads: ThreadChannel[];
  scannedActive: number;
  scannedArchived: number;
  hitLimit: boolean;
};

function uniqueThreads(threads: ThreadChannel[]): ThreadChannel[] {
  const seen = new Set<string>();
  const unique: ThreadChannel[] = [];

  for (const thread of threads) {
    if (seen.has(thread.id)) {
      continue;
    }

    seen.add(thread.id);
    unique.push(thread);
  }

  return unique;
}

function oldestThreadDate(threads: ThreadChannel[]): Date | null {
  const timestamps = threads
    .map((thread) => thread.archiveTimestamp ?? thread.createdTimestamp)
    .filter((timestamp): timestamp is number => typeof timestamp === "number");

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.min(...timestamps) - 1);
}

async function collectForumThreads(forum: ForumChannel): Promise<CollectedThreads> {
  const collected: ThreadChannel[] = [];
  let scannedActive = 0;
  let scannedArchived = 0;

  const active = await forum.threads.fetchActive(false);
  const activeThreads = [...active.threads.values()].filter((thread) => thread.parentId === forum.id) as ThreadChannel[];
  scannedActive = activeThreads.length;
  collected.push(...activeThreads);

  if (!includeArchived || collected.length >= maxThreads) {
    return {
      threads: uniqueThreads(collected).slice(0, maxThreads),
      scannedActive,
      scannedArchived,
      hitLimit: collected.length > maxThreads,
    };
  }

  let before: Date | undefined;
  while (collected.length < maxThreads) {
    const archived = await forum.threads.fetchArchived(
      {
        type: "public",
        limit: Math.min(100, maxThreads - collected.length),
        before,
      },
      false,
    );
    const archivedThreads = [...archived.threads.values()].filter((thread) => thread.parentId === forum.id) as ThreadChannel[];

    scannedArchived += archivedThreads.length;
    collected.push(...archivedThreads);

    if (!archived.hasMore || archivedThreads.length === 0) {
      break;
    }

    before = oldestThreadDate(archivedThreads) ?? before;
    if (!before) {
      break;
    }
  }

  return {
    threads: uniqueThreads(collected).slice(0, maxThreads),
    scannedActive,
    scannedArchived,
    hitLimit: collected.length >= maxThreads,
  };
}

async function findOrCreateTrelloCard(thread: ThreadChannel, description: string): Promise<{
  card: CreatedTrelloCard | null;
  action: "found" | "created" | "planned_create";
}> {
  const existing = await findTrelloCardByDiscordThreadId(thread.id);
  if (existing) {
    return { card: existing, action: "found" };
  }

  if (!apply) {
    return { card: null, action: "planned_create" };
  }

  const card = await createTrelloCard({
    name: trelloCardNameFromThreadName(thread.name),
    desc: description,
  });

  return { card, action: "created" };
}

function hasWhiteCheckReaction(message: Message | null): boolean {
  return message?.reactions.cache.some((reaction) => (
    reaction.emoji.name === "✅" ||
    reaction.emoji.name === "white_check_mark"
  )) ?? false;
}

initDatabase();

const client = createDiscordClient();
await client.login(config.discord.token);

try {
  const channel = await client.channels.fetch(config.discord.forumChannelId);
  if (!(channel instanceof ForumChannel) || channel.type !== ChannelType.GuildForum) {
    throw new Error("Configured Discord forum channel not found or is not a forum");
  }

  const collected = await collectForumThreads(channel);
  let checked = 0;
  let skippedLinked = 0;
  let skippedCheckMarked = 0;
  let plannedCreate = 0;
  let foundExistingCard = 0;
  let created = 0;
  let linked = 0;
  let failed = 0;

  for (const thread of collected.threads) {
    checked += 1;

    try {
      const existingLink = findByDiscordThreadId(thread.id);
      if (existingLink) {
        skippedLinked += 1;
        continue;
      }

      const starterMessage = await fetchStarterMessage(thread);
      if (excludeCheckMarked && hasWhiteCheckReaction(starterMessage)) {
        skippedCheckMarked += 1;
        continue;
      }

      const authorId = starterMessage?.author.id ?? thread.ownerId ?? null;
      const description = await buildTrelloDescription({ authorId, thread, starterMessage });
      const result = await findOrCreateTrelloCard(thread, description);

      if (result.action === "planned_create") {
        plannedCreate += 1;
        console.log(`DRY-RUN create ${thread.id} ${thread.name}`);
        continue;
      }

      if (!result.card) {
        throw new Error("Trello card was not created or found");
      }

      if (result.action === "found") {
        foundExistingCard += 1;
      } else {
        created += 1;
      }

      console.log(`${apply ? "LINK" : "DRY-RUN link"} ${thread.id} -> ${result.card.id} ${thread.name}`);

      if (apply) {
        createTicketLink({
          discordGuildId: config.discord.guildId,
          discordChannelId: thread.parentId ?? config.discord.forumChannelId,
          discordThreadId: thread.id,
          discordAuthorId: authorId,
          trelloCardId: result.card.id,
          trelloCardUrl: result.card.url,
          status: "New",
        });
        linked += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(`FAILED ${thread.id} ${thread.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        checked,
        scanned_active: collected.scannedActive,
        scanned_archived: collected.scannedArchived,
        hit_limit: collected.hitLimit,
        skipped_linked: skippedLinked,
        skipped_check_marked: skippedCheckMarked,
        planned_create: plannedCreate,
        found_existing_card: foundExistingCard,
        created,
        linked,
        failed,
      },
      null,
      2,
    ),
  );
} finally {
  client.destroy();
}
