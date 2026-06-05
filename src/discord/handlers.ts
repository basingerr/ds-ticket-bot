import {
  ChannelType,
  Client,
  Events,
  Interaction,
  Message,
  MessageFlags,
  PartialMessage,
  ThreadChannel,
} from "discord.js";
import { isBotReadonly } from "../botMode.js";
import { config } from "../config.js";
import { createTicketLink, findByDiscordThreadId } from "../db/ticketLinks.js";
import {
  addTrelloCardComment,
  createTrelloCard,
  findTrelloCardByDiscordThreadId,
  updateTrelloCard,
  type CreatedTrelloCard,
} from "../trello/client.js";
import { applyStatusTag } from "./threadTags.js";
import { upsertStatusMessage } from "./statusMessage.js";
import { buildTrelloDescription, fetchStarterMessage, trelloCardNameFromThreadName } from "./ticketContent.js";
import { applyStatusReaction } from "./statusReaction.js";
import { logger } from "../utils/logger.js";
import { handleBotModeCommand, handleSyncTicketCommand, handleTesterStatsCommand } from "./commands.js";

async function handleForumThreadCreate(thread: ThreadChannel): Promise<void> {
  if (thread.parentId !== config.discord.forumChannelId) {
    return;
  }

  logger.info("discord forum post detected", { discord_thread_id: thread.id });

  if (isBotReadonly()) {
    logger.warn("discord forum post ignored: bot readonly", { discord_thread_id: thread.id });
    return;
  }

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
  const description = await buildTrelloDescription({ authorId, thread, starterMessage });
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
        name: trelloCardNameFromThreadName(thread.name),
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
    const link = createTicketLink({
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

    await upsertStatusMessage(thread, link, "New");
    await applyStatusTag(thread, "New");
    await applyStatusReaction(thread, "New");

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

async function handleForumThreadUpdate(oldThread: ThreadChannel, newThread: ThreadChannel): Promise<void> {
  if (newThread.parentId !== config.discord.forumChannelId || oldThread.name === newThread.name) {
    return;
  }

  if (isBotReadonly()) {
    logger.warn("discord thread title update ignored: bot readonly", { discord_thread_id: newThread.id });
    return;
  }

  const link = findByDiscordThreadId(newThread.id);
  if (!link) {
    return;
  }

  const trelloName = trelloCardNameFromThreadName(newThread.name);

  try {
    await updateTrelloCard({
      cardId: link.trelloCardId,
      name: trelloName,
    });
    await addTrelloCardComment(link.trelloCardId, `Автор обновил название: "${newThread.name}".`);

    logger.info("trello card title updated from discord", {
      discord_thread_id: newThread.id,
      trello_card_id: link.trelloCardId,
    });
  } catch (error) {
    logger.error("error", {
      discord_thread_id: newThread.id,
      trello_card_id: link.trelloCardId,
      action: "update_trello_card_title_from_discord",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveMessage(message: Message | PartialMessage): Promise<Message | null> {
  try {
    return message.partial ? await message.fetch() : message;
  } catch {
    return null;
  }
}

async function handleStarterMessageUpdate(oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage): Promise<void> {
  const resolvedNewMessage = await resolveMessage(newMessage);
  if (!resolvedNewMessage || !resolvedNewMessage.channel.isThread()) {
    return;
  }

  const thread = resolvedNewMessage.channel;
  if (thread.parentId !== config.discord.forumChannelId) {
    return;
  }

  if (isBotReadonly()) {
    logger.warn("discord starter message update ignored: bot readonly", { discord_thread_id: thread.id });
    return;
  }

  const starterMessage = await fetchStarterMessage(thread);
  if (!starterMessage || starterMessage.id !== resolvedNewMessage.id) {
    return;
  }

  const oldContent = "content" in oldMessage ? oldMessage.content : null;
  if (oldContent === resolvedNewMessage.content) {
    return;
  }

  const link = findByDiscordThreadId(thread.id);
  if (!link) {
    return;
  }

  const authorId = resolvedNewMessage.author.id ?? thread.ownerId ?? null;
  const description = await buildTrelloDescription({ authorId, thread, starterMessage: resolvedNewMessage });

  try {
    await updateTrelloCard({
      cardId: link.trelloCardId,
      desc: description,
    });
    await addTrelloCardComment(link.trelloCardId, "Автор обновил описание тикета.");

    logger.info("trello card description updated from discord", {
      discord_thread_id: thread.id,
      trello_card_id: link.trelloCardId,
    });
  } catch (error) {
    logger.error("error", {
      discord_thread_id: thread.id,
      trello_card_id: link.trelloCardId,
      action: "update_trello_card_description_from_discord",
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

  client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
    if (newThread.type !== ChannelType.PublicThread && newThread.type !== ChannelType.PrivateThread) {
      return;
    }

    await handleForumThreadUpdate(oldThread, newThread);
  });

  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    await handleStarterMessageUpdate(oldMessage, newMessage);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "sync-ticket") {
      if (isBotReadonly()) {
        await interaction.reply({
          content: "Бот сейчас в readonly-режиме. Синхронизация отключена.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await handleSyncTicketCommand(interaction);
      return;
    }

    if (interaction.commandName === "tester-stats") {
      await handleTesterStatsCommand(interaction);
      return;
    }

    if (interaction.commandName === "bot-mode") {
      await handleBotModeCommand(interaction);
    }
  });
}
