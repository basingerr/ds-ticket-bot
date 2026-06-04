import {
  ChannelType,
  Client,
  Events,
  Interaction,
  Message,
  ThreadChannel,
} from "discord.js";
import { config } from "../config.js";
import { createTicketLink, findByDiscordThreadId } from "../db/ticketLinks.js";
import { createTrelloCard, findTrelloCardByDiscordThreadId, type CreatedTrelloCard } from "../trello/client.js";
import { applyStatusTag } from "./threadTags.js";
import { logger } from "../utils/logger.js";
import { handleSyncTicketCommand } from "./commands.js";

function valueOrNotAvailable(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "not_available";
}

function discordThreadLink(threadId: string): string {
  return `https://discord.com/channels/${config.discord.guildId}/${threadId}`;
}

function attachmentLinks(message: Message | null): string {
  if (!message || message.attachments.size === 0) {
    return "not_available";
  }

  return message.attachments.map((attachment) => attachment.url).join("\n");
}

function buildTrelloDescription(input: {
  authorId: string | null;
  thread: ThreadChannel;
  starterMessage: Message | null;
}): string {
  return [
    "Discord ticket",
    "",
    `Автор Discord: ${valueOrNotAvailable(input.authorId)}`,
    `Discord thread id: ${input.thread.id}`,
    `Discord channel id: ${valueOrNotAvailable(input.thread.parentId)}`,
    `Discord guild id: ${config.discord.guildId}`,
    `Discord link: ${discordThreadLink(input.thread.id)}`,
    "",
    "Текст тикета:",
    valueOrNotAvailable(input.starterMessage?.content),
    "",
    "Вложения:",
    attachmentLinks(input.starterMessage),
  ].join("\n");
}

async function fetchStarterMessage(thread: ThreadChannel): Promise<Message | null> {
  try {
    return await thread.fetchStarterMessage();
  } catch (error) {
    logger.warn("starter message unavailable", {
      discord_thread_id: thread.id,
      action: "fetch_starter_message",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function handleForumThreadCreate(thread: ThreadChannel): Promise<void> {
  if (thread.parentId !== config.discord.forumChannelId) {
    return;
  }

  logger.info("discord forum post detected", { discord_thread_id: thread.id });

  const existing = findByDiscordThreadId(thread.id);
  if (existing) {
    logger.info("discord forum post already linked", {
      discord_thread_id: thread.id,
      trello_card_id: existing.trelloCardId,
    });
    return;
  }

  const starterMessage = await fetchStarterMessage(thread);
  const authorId = starterMessage?.author.id ?? thread.ownerId ?? null;
  const description = buildTrelloDescription({ authorId, thread, starterMessage });
  let card: CreatedTrelloCard | null = null;

  try {
    card = await findTrelloCardByDiscordThreadId(thread.id);

    if (card) {
      logger.warn("existing trello card found for discord thread", {
        discord_thread_id: thread.id,
        trello_card_id: card.id,
      });
    } else {
      card = await createTrelloCard({
        name: thread.name,
        desc: description,
      });

      logger.info("trello card created", {
        discord_thread_id: thread.id,
        trello_card_id: card.id,
      });
    }

  } catch (error) {
    logger.error("error", {
      discord_thread_id: thread.id,
      action: "create_trello_card_from_discord_thread",
      error: error instanceof Error ? error.message : String(error),
    });

    await thread.send("Не удалось создать внутренний тикет. Команда проверит вручную.");
    return;
  }

  try {
    createTicketLink({
      discordGuildId: config.discord.guildId,
      discordChannelId: thread.parentId ?? config.discord.forumChannelId,
      discordThreadId: thread.id,
      discordAuthorId: authorId,
      trelloCardId: card.id,
      trelloCardUrl: card.url,
      status: "New",
    });

    logger.info("ticket link saved", {
      discord_thread_id: thread.id,
      trello_card_id: card.id,
    });

    await thread.send("Тикет принят.\nСтатус: New.");
    await applyStatusTag(thread, "New");

    logger.info("discord thread updated", {
      discord_thread_id: thread.id,
      status: "New",
    });
  } catch (error) {
    logger.error("error", {
      discord_thread_id: thread.id,
      trello_card_id: card.id,
      action: "save_ticket_link_or_update_discord_thread",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function registerDiscordHandlers(client: Client): void {
  client.once(Events.ClientReady, (readyClient) => {
    logger.info("bot started", { discord_user: readyClient.user.tag });
  });

  client.on(Events.ThreadCreate, async (thread) => {
    if (thread.type !== ChannelType.PublicThread && thread.type !== ChannelType.PrivateThread) {
      return;
    }

    try {
      await handleForumThreadCreate(thread);
    } catch (error) {
      logger.error("error", {
        discord_thread_id: thread.id,
        action: "thread_create_handler",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "sync-ticket") {
      await handleSyncTicketCommand(interaction);
    }
  });
}
