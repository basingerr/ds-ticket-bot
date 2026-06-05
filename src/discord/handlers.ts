import {
  ChannelType,
  Client,
  Events,
  Interaction,
  Message,
  PartialMessage,
  ThreadChannel,
} from "discord.js";
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
import { logger } from "../utils/logger.js";
import { handleSyncTicketCommand } from "./commands.js";

function valueOrNotAvailable(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "not_available";
}

function discordThreadLink(threadId: string): string {
  return `https://discord.com/channels/${config.discord.guildId}/${threadId}`;
}

function trelloCardNameFromThreadName(threadName: string): string {
  return threadName.startsWith("[QA] ") ? threadName : `[QA] ${threadName}`;
}

function attachmentLinks(message: Message | null): string {
  if (!message || message.attachments.size === 0) {
    return "";
  }

  return message.attachments.map((attachment) => `- ${attachment.url}`).join("\n");
}

function formatAuthor(message: Message | null, fallbackAuthorId: string | null): string {
  if (!message) {
    return valueOrNotAvailable(fallbackAuthorId);
  }

  const displayName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
  const username = message.author.discriminator === "0"
    ? `@${message.author.username}`
    : `${message.author.username}#${message.author.discriminator}`;

  return `${displayName} (${username}, ${message.author.id})`;
}

function buildTrelloDescription(input: {
  authorId: string | null;
  thread: ThreadChannel;
  starterMessage: Message | null;
}): string {
  const attachments = attachmentLinks(input.starterMessage);
  const lines = [
    "## Discord ticket",
    "",
    `**Автор:** ${formatAuthor(input.starterMessage, input.authorId)}`,
    `**Тема:** ${input.thread.name}`,
    `**Ссылка:** ${discordThreadLink(input.thread.id)}`,
    "",
    "### Описание",
    valueOrNotAvailable(input.starterMessage?.content),
  ];

  if (attachments) {
    lines.push("", "### Вложения", attachments);
  }

  lines.push(
    "",
    `<!-- Discord thread id: ${input.thread.id} -->`,
  );

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchFirstUserMessage(thread: ThreadChannel): Promise<Message | null> {
  try {
    const messages = await thread.messages.fetch({ limit: 10 });
    return messages
      .filter((message) => !message.author.bot)
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .first() ?? null;
  } catch (error) {
    logger.warn("thread messages unavailable", {
      discord_thread_id: thread.id,
      action: "fetch_first_user_message",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function fetchStarterMessage(thread: ThreadChannel): Promise<Message | null> {
  const attempts = 6;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const starterMessage = await thread.fetchStarterMessage();
      if (starterMessage?.content || starterMessage?.attachments.size) {
        return starterMessage;
      }

      const fallbackMessage = await fetchFirstUserMessage(thread);
      if (fallbackMessage?.content || fallbackMessage?.attachments.size) {
        return fallbackMessage;
      }
    } catch (error) {
      if (attempt === attempts) {
        logger.warn("starter message unavailable", {
          discord_thread_id: thread.id,
          action: "fetch_starter_message",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (attempt < attempts) {
      await sleep(1000);
    }
  }

  return null;
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
  const description = buildTrelloDescription({ authorId, thread, starterMessage: resolvedNewMessage });

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
      await handleSyncTicketCommand(interaction);
    }
  });
}
