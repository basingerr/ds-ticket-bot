import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  Interaction,
  Message,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  PartialMessage,
  TextInputBuilder,
  TextInputStyle,
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
import { qaFixedButtonId, qaNeedsWorkButtonId, upsertStatusMessage } from "./statusMessage.js";
import { buildTrelloDescription, fetchStarterMessage, trelloCardNameFromThreadName } from "./ticketContent.js";
import { applyStatusReaction } from "./statusReaction.js";
import { logger } from "../utils/logger.js";
import {
  handleBotHealthCommand,
  handleBotLogsCommand,
  handleBotModeCommand,
  handleSyncTicketCommand,
  handleTesterStatsCommand,
} from "./commands.js";

const qaNeedsWorkModalIdPrefix = "qa_feedback:needs_work_modal";
const qaNeedsWorkDetailsInputId = "qa_feedback:needs_work_details";
const pendingQaFeedbackThreadIds = new Set<string>();

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

async function sendQaReplyAlert(input: {
  client: Client;
  thread: ThreadChannel;
  discordUrl: string;
  trelloCardUrl: string | null;
  status: string;
  content: string;
}): Promise<void> {
  if (!config.qaReplyAlertStatuses.includes(input.status)) {
    return;
  }

  const channel = await input.client.channels.fetch(config.qaReplyAlertChannelId);
  if (!channel?.isSendable()) {
    logger.warn("qa reply alert channel unavailable", {
      channel_id: config.qaReplyAlertChannelId,
      discord_thread_id: input.thread.id,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle("QA ответил по тикету в тестировании")
    .setDescription(truncateText(input.content, 900))
    .addFields(
      { name: "Тикет", value: `[${truncateText(input.thread.name, 120)}](${input.discordUrl})` },
      { name: "Статус", value: input.status, inline: true },
    )
    .setTimestamp();

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Discord")
      .setStyle(ButtonStyle.Link)
      .setURL(input.discordUrl),
  );

  if (input.trelloCardUrl) {
    buttons.addComponents(
      new ButtonBuilder()
        .setLabel("Trello")
        .setStyle(ButtonStyle.Link)
        .setURL(input.trelloCardUrl),
    );
  }

  await channel.send({ embeds: [embed], components: [buttons] });
}

function discordThreadUrl(thread: ThreadChannel): string {
  return `https://discord.com/channels/${config.discord.guildId}/${thread.id}`;
}

function isQaFeedbackStatus(status: string): boolean {
  return config.qaReplyAlertStatuses.includes(status);
}

async function findQaFeedbackContext(interaction: ButtonInteraction | ModalSubmitInteraction): Promise<{
  thread: ThreadChannel;
  link: NonNullable<ReturnType<typeof findByDiscordThreadId>>;
} | null> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({
      content: "Это действие доступно только внутри ticket thread.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const thread = interaction.channel;
  if (thread.parentId !== config.discord.forumChannelId) {
    await interaction.reply({
      content: "Это не настроенный ticket forum.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  if (isBotReadonly()) {
    await interaction.reply({
      content: "Бот сейчас в readonly-режиме. QA feedback отключен.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  const link = findByDiscordThreadId(thread.id);
  if (!link) {
    await interaction.reply({
      content: "Связка с Trello-карточкой не найдена.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  if (!isQaFeedbackStatus(link.status)) {
    await interaction.reply({
      content: `QA feedback доступен только в статусе: ${config.qaReplyAlertStatuses.join(", ")}.`,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }

  return { thread, link };
}

function qaNeedsWorkModalId(messageId: string): string {
  return `${qaNeedsWorkModalIdPrefix}:${messageId}`;
}

function qaFeedbackMessageIdFromModalId(customId: string): string | null {
  const prefix = `${qaNeedsWorkModalIdPrefix}:`;
  return customId.startsWith(prefix) ? customId.slice(prefix.length) : null;
}

async function disableQaFeedbackButtons(message: Message, selected: "fixed" | "needs_work"): Promise<void> {
  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(qaFixedButtonId)
        .setLabel(selected === "fixed" ? "Исправлено отправлено" : "Исправлено")
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(qaNeedsWorkButtonId)
        .setLabel(selected === "needs_work" ? "Доработка отправлена" : "Нужна доработка")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    ),
  ];

  await message.edit({ components });
}

async function disableQaFeedbackButtonsFromModal(interaction: ModalSubmitInteraction, thread: ThreadChannel): Promise<void> {
  const messageId = qaFeedbackMessageIdFromModalId(interaction.customId);
  if (!messageId) {
    return;
  }

  const message = await thread.messages.fetch(messageId);
  await disableQaFeedbackButtons(message, "needs_work");
}

function publicQaFeedbackContent(content: string): string {
  return truncateText(content, 1900);
}

async function handleQaFixedButton(interaction: ButtonInteraction): Promise<void> {
  const context = await findQaFeedbackContext(interaction);
  if (!context) {
    return;
  }

  if (pendingQaFeedbackThreadIds.has(context.thread.id)) {
    await interaction.reply({
      content: "QA feedback уже отправляется. Подождите пару секунд.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const content = "QA подтвердил: исправлено.";
  pendingQaFeedbackThreadIds.add(context.thread.id);
  await interaction.deferReply();

  try {
    await addTrelloCardComment(context.link.trelloCardId, content);
  } catch (error) {
    logger.error("error", {
      discord_thread_id: context.thread.id,
      trello_card_id: context.link.trelloCardId,
      action: "qa_fixed_feedback",
      error: error instanceof Error ? error.message : String(error),
    });

    pendingQaFeedbackThreadIds.delete(context.thread.id);
    await interaction.editReply({
      content: "Не удалось отправить подтверждение. Команда проверит вручную.",
    });
    return;
  }

  try {
    await sendQaReplyAlert({
      client: interaction.client,
      thread: context.thread,
      discordUrl: discordThreadUrl(context.thread),
      trelloCardUrl: context.link.trelloCardUrl,
      status: context.link.status,
      content,
    });
  } catch (error) {
    logger.warn("qa fixed feedback alert failed", {
      discord_thread_id: context.thread.id,
      trello_card_id: context.link.trelloCardId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await disableQaFeedbackButtons(interaction.message, "fixed");
  } catch (error) {
    logger.warn("qa fixed feedback buttons disable failed", {
      discord_thread_id: context.thread.id,
      trello_card_id: context.link.trelloCardId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  pendingQaFeedbackThreadIds.delete(context.thread.id);
  await interaction.editReply(publicQaFeedbackContent(content));
}

async function handleQaNeedsWorkButton(interaction: ButtonInteraction): Promise<void> {
  const context = await findQaFeedbackContext(interaction);
  if (!context) {
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(qaNeedsWorkModalId(interaction.message.id))
    .setTitle("Нужна доработка");

  const details = new TextInputBuilder()
    .setCustomId(qaNeedsWorkDetailsInputId)
    .setLabel("Что не так?")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1500);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(details));
  await interaction.showModal(modal);
}

async function handleQaNeedsWorkModal(interaction: ModalSubmitInteraction): Promise<void> {
  const context = await findQaFeedbackContext(interaction);
  if (!context) {
    return;
  }

  if (pendingQaFeedbackThreadIds.has(context.thread.id)) {
    await interaction.reply({
      content: "QA feedback уже отправляется. Подождите пару секунд.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const details = interaction.fields.getTextInputValue(qaNeedsWorkDetailsInputId).trim();
  if (!details) {
    await interaction.reply({
      content: "Пояснение не может быть пустым.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const content = `QA сообщил: нужна доработка.\n${details}`;
  pendingQaFeedbackThreadIds.add(context.thread.id);
  await interaction.deferReply();

  try {
    await addTrelloCardComment(context.link.trelloCardId, content);
  } catch (error) {
    logger.error("error", {
      discord_thread_id: context.thread.id,
      trello_card_id: context.link.trelloCardId,
      action: "qa_needs_work_feedback",
      error: error instanceof Error ? error.message : String(error),
    });

    pendingQaFeedbackThreadIds.delete(context.thread.id);
    await interaction.editReply({
      content: "Не удалось отправить доработку. Команда проверит вручную.",
    });
    return;
  }

  try {
    await sendQaReplyAlert({
      client: interaction.client,
      thread: context.thread,
      discordUrl: discordThreadUrl(context.thread),
      trelloCardUrl: context.link.trelloCardUrl,
      status: context.link.status,
      content,
    });
  } catch (error) {
    logger.warn("qa needs work feedback alert failed", {
      discord_thread_id: context.thread.id,
      trello_card_id: context.link.trelloCardId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await disableQaFeedbackButtonsFromModal(interaction, context.thread);
  } catch (error) {
    logger.warn("qa needs work feedback buttons disable failed", {
      discord_thread_id: context.thread.id,
      trello_card_id: context.link.trelloCardId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  pendingQaFeedbackThreadIds.delete(context.thread.id);
  await interaction.editReply(publicQaFeedbackContent(content));
}

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

async function handleAuthorCommentCreate(message: Message): Promise<void> {
  if (!message.channel.isThread() || message.author.bot) {
    return;
  }

  const thread = message.channel;
  if (thread.parentId !== config.discord.forumChannelId) {
    return;
  }

  if (isBotReadonly()) {
    logger.warn("discord author comment ignored: bot readonly", { discord_thread_id: thread.id });
    return;
  }

  const link = findByDiscordThreadId(thread.id);
  if (!link || message.author.id !== link.discordAuthorId) {
    return;
  }

  const starterMessage = await fetchStarterMessage(thread);
  if (starterMessage?.id === message.id) {
    return;
  }

  const content = message.content.trim();
  if (!content) {
    return;
  }

  try {
    await addTrelloCardComment(link.trelloCardId, `Автор добавил коммент в Discord:\n${content}`);
    await sendQaReplyAlert({
      client: message.client,
      thread,
      discordUrl: message.url,
      trelloCardUrl: link.trelloCardUrl,
      status: link.status,
      content,
    });

    logger.info("trello card comment added from discord author comment", {
      discord_thread_id: thread.id,
      discord_message_id: message.id,
      trello_card_id: link.trelloCardId,
    });
  } catch (error) {
    logger.error("error", {
      discord_thread_id: thread.id,
      discord_message_id: message.id,
      trello_card_id: link.trelloCardId,
      action: "add_trello_comment_from_discord_author_comment",
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

  client.on(Events.MessageCreate, async (message) => {
    await handleAuthorCommentCreate(message);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.isButton()) {
      if (interaction.customId === qaFixedButtonId) {
        await handleQaFixedButton(interaction);
        return;
      }

      if (interaction.customId === qaNeedsWorkButtonId) {
        await handleQaNeedsWorkButton(interaction);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith(`${qaNeedsWorkModalIdPrefix}:`)) {
        await handleQaNeedsWorkModal(interaction);
        return;
      }
    }

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
      return;
    }

    if (interaction.commandName === "bhealth") {
      await handleBotHealthCommand(interaction);
      return;
    }

    if (interaction.commandName === "blogs") {
      await handleBotLogsCommand(interaction);
    }
  });
}
