import { Message, ThreadChannel } from "discord.js";
import { fetchStarterMessage } from "./ticketContent.js";
import { logger } from "../utils/logger.js";

const STATUS_REACTIONS = ["🕓", "🔧", "🔁", "✅", "⚠️"] as const;

function reactionForStatus(status: string): string {
  const normalized = status.toLowerCase();

  if (normalized === "очередь" || normalized === "new") {
    return "🕓";
  }

  if (normalized === "in progress" || normalized === "в работе") {
    return "🔧";
  }

  if (normalized === "ready for retest" || normalized === "тестирование / на сервере") {
    return "🔁";
  }

  if (normalized === "verified" || normalized === "готово") {
    return "✅";
  }

  return "⚠️";
}

async function removeOwnStatusReactions(message: Message, keepEmoji: string): Promise<void> {
  for (const emoji of STATUS_REACTIONS) {
    if (emoji === keepEmoji) {
      continue;
    }

    const reaction = message.reactions.cache.find((candidate) => candidate.emoji.name === emoji);
    if (!reaction) {
      continue;
    }

    await reaction.users.remove(message.client.user.id);
  }
}

export async function applyStatusReaction(thread: ThreadChannel, status: string): Promise<void> {
  try {
    const message = await fetchStarterMessage(thread, { attempts: 1 });
    if (!message) {
      return;
    }

    const emoji = reactionForStatus(status);
    await removeOwnStatusReactions(message, emoji);

    const existingReaction = message.reactions.cache.find((reaction) => reaction.emoji.name === emoji);
    const botAlreadyReacted = existingReaction
      ? await existingReaction.users.fetch().then((users) => users.has(message.client.user.id))
      : false;

    if (!botAlreadyReacted) {
      await message.react(emoji);
    }
  } catch (error) {
    logger.warn("status reaction update failed", {
      discord_thread_id: thread.id,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
