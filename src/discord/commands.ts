import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ForumChannel,
  GuildMemberRoleManager,
  MessageFlags,
  SlashCommandBuilder,
  Snowflake,
  ThreadChannel,
} from "discord.js";
import { getBotMode, setBotMode, type BotMode } from "../botMode.js";
import { config } from "../config.js";
import { findByDiscordThreadId, updateStatus } from "../db/ticketLinks.js";
import { healthCheckLine, runHealthChecks } from "../healthChecks.js";
import { getTrelloCardWithList } from "../trello/client.js";
import { statusFromTrelloList } from "../trello/statusMap.js";
import { applyStatusTag } from "./threadTags.js";
import { upsertStatusMessage } from "./statusMessage.js";
import { applyStatusReaction } from "./statusReaction.js";
import { getRecentLogs, logger, type LogEntry, type LogLevel } from "../utils/logger.js";

export const syncTicketCommand = new SlashCommandBuilder()
  .setName("sync-ticket")
  .setDescription("Синхронизировать текущий Discord ticket с Trello card.")
  .setDefaultMemberPermissions(null);

export const testerStatsCommand = new SlashCommandBuilder()
  .setName("tester-stats")
  .setDescription("Показать самых активных авторов тем в ticket forum.")
  .setDefaultMemberPermissions(null)
  .addIntegerOption((option) =>
    option
      .setName("limit")
      .setDescription("Сколько авторов показать.")
      .setMinValue(1)
      .setMaxValue(20),
  )
  .addIntegerOption((option) =>
    option
      .setName("max_threads")
      .setDescription("Максимум тем для просмотра, чтобы команда не работала слишком долго.")
      .setMinValue(50)
      .setMaxValue(1000),
  )
  .addBooleanOption((option) =>
    option
      .setName("archived")
      .setDescription("Включить архивные темы. По умолчанию: да."),
  );

export const botModeCommand = new SlashCommandBuilder()
  .setName("bot-mode")
  .setDescription("Показать или переключить аварийный режим бота.")
  .setDefaultMemberPermissions(null)
  .addStringOption((option) =>
    option
      .setName("mode")
      .setDescription("Новый режим. Без значения команда покажет текущий режим.")
      .addChoices(
        { name: "active", value: "active" },
        { name: "readonly", value: "readonly" },
      ),
  );

export const botHealthCommand = new SlashCommandBuilder()
  .setName("bhealth")
  .setDescription("Проверить здоровье Discord/Trello/SQLite bridge.")
  .setDefaultMemberPermissions(null);

export const botLogsCommand = new SlashCommandBuilder()
  .setName("blogs")
  .setDescription("Показать последние логи текущего процесса бота.")
  .setDefaultMemberPermissions(null)
  .addStringOption((option) =>
    option
      .setName("level")
      .setDescription("Фильтр уровня логов.")
      .addChoices(
        { name: "all", value: "all" },
        { name: "info", value: "info" },
        { name: "warn", value: "warn" },
        { name: "error", value: "error" },
      ),
  )
  .addIntegerOption((option) =>
    option
      .setName("limit")
      .setDescription("Сколько строк показать.")
      .setMinValue(5)
      .setMaxValue(50),
  );

function hasAnyAllowedRole(interaction: ChatInputCommandInteraction, roleIds: string[]): boolean {
  const allowedRoleIds = new Set(roleIds);
  if (allowedRoleIds.size === 0) {
    return false;
  }

  const roles = interaction.member?.roles;
  if (!roles) {
    return false;
  }

  if (Array.isArray(roles)) {
    return roles.some((roleId) => allowedRoleIds.has(roleId));
  }

  if (roles instanceof GuildMemberRoleManager) {
    return roles.cache.some((role) => allowedRoleIds.has(role.id));
  }

  return false;
}

function canManageBotMode(interaction: ChatInputCommandInteraction): boolean {
  return config.botAdminUserIds.includes(interaction.user.id) || hasAnyAllowedRole(interaction, config.botAdminRoleIds);
}

function canUseTesterStats(interaction: ChatInputCommandInteraction): boolean {
  return hasAnyAllowedRole(interaction, config.testerStatsRoleIds);
}

function botModeLabel(mode: BotMode): string {
  return mode === "active" ? "active - бот работает" : "readonly - бот ничего не создает и не синхронизирует";
}

async function safeEditInteractionReply(interaction: ChatInputCommandInteraction, content: string, action: string): Promise<void> {
  try {
    await interaction.editReply(content);
  } catch (error) {
    logger.error("error", {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleBotModeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  logger.info("bot mode command executed", {
    user_id: interaction.user.id,
    requested_mode: interaction.options.getString("mode"),
  });

  if (!canManageBotMode(interaction)) {
    await interaction.reply({
      content: "Нет доступа к аварийному переключателю бота.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const requestedMode = interaction.options.getString("mode") as BotMode | null;
  if (requestedMode) {
    setBotMode(requestedMode);
    await interaction.reply({
      content: `Режим бота переключен: ${botModeLabel(requestedMode)}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `Текущий режим бота: ${botModeLabel(getBotMode())}.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleBotHealthCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  logger.info("bot health command executed", {
    user_id: interaction.user.id,
  });

  if (!canManageBotMode(interaction)) {
    await interaction.reply({
      content: "Нет доступа к диагностике бота.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const checks = await runHealthChecks(interaction.client);
  const failed = checks.filter((check) => !check.ok).length;
  const embed = new EmbedBuilder()
    .setColor(failed === 0 ? 0x22c55e : 0xef4444)
    .setTitle("Bot health")
    .setDescription(checks.map(healthCheckLine).join("\n"))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

function compactJson(value: unknown, maxLength: number): string {
  const text = JSON.stringify(value);
  if (!text) {
    return "";
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatLogEntry(entry: LogEntry): string {
  const time = entry.timestamp.slice(11, 19);
  const context = entry.context ? ` ${compactJson(entry.context, 220)}` : "";
  return `${time} ${entry.level.toUpperCase()} ${entry.message}${context}`;
}

export async function handleBotLogsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  logger.info("bot logs command executed", {
    user_id: interaction.user.id,
    level: interaction.options.getString("level"),
    limit: interaction.options.getInteger("limit"),
  });

  if (!canManageBotMode(interaction)) {
    await interaction.reply({
      content: "Нет доступа к логам бота.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const level = (interaction.options.getString("level") ?? "all") as LogLevel | "all";
  const limit = interaction.options.getInteger("limit") ?? 20;
  const logs = getRecentLogs({ level, limit });

  if (logs.length === 0) {
    await interaction.reply({
      content: "Логов по этому фильтру пока нет.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = logs.map(formatLogEntry);
  let body = lines.join("\n");
  if (body.length > 3900) {
    body = `${body.slice(0, 3899)}…`;
  }

  await interaction.reply({
    content: [`Последние логи: level=${level}, limit=${limit}`, "", "```text", body, "```"].join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleSyncTicketCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;

  logger.info("sync command executed", {
    discord_thread_id: channel?.id,
    user_id: interaction.user.id,
  });

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.error("error", {
      discord_thread_id: channel?.id,
      action: "sync_ticket_defer_reply",
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!channel?.isThread()) {
    await safeEditInteractionReply(interaction, "Команду нужно вызвать внутри Discord thread.", "sync_ticket_not_thread_reply");
    return;
  }

  const link = findByDiscordThreadId(channel.id);
  if (!link) {
    await safeEditInteractionReply(interaction, "Связка с Trello-карточкой не найдена.", "sync_ticket_missing_link_reply");
    return;
  }

  try {
    const card = await getTrelloCardWithList(link.trelloCardId);
    const status = statusFromTrelloList(card.idList, card.listName);
    const updatedLink = status !== link.status ? updateStatus(link.id, status) : link;

    await upsertStatusMessage(channel, updatedLink, status);
    await applyStatusTag(channel, status);
    await applyStatusReaction(channel, status);

    await safeEditInteractionReply(interaction, `Тикет синхронизирован.\nТекущий статус: ${status}.`, "sync_ticket_success_reply");
  } catch (error) {
    logger.error("error", {
      discord_thread_id: channel.id,
      trello_card_id: link.trelloCardId,
      action: "sync_ticket_command",
      error: error instanceof Error ? error.message : String(error),
    });

    await safeEditInteractionReply(interaction, "Не удалось синхронизировать тикет. Команда проверит вручную.", "sync_ticket_error_reply");
  }
}

type AuthorStats = {
  userId: Snowflake;
  count: number;
};

type CollectedThreads = {
  threads: ThreadChannel[];
  scannedActive: number;
  scannedArchived: number;
  hitLimit: boolean;
};

function isConfiguredForumChannel(channel: unknown): channel is ForumChannel {
  return channel instanceof ForumChannel && channel.type === ChannelType.GuildForum;
}

function uniqueThreads(threads: ThreadChannel[]): ThreadChannel[] {
  const seen = new Set<Snowflake>();
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

async function collectForumThreads(forum: ForumChannel, includeArchived: boolean, maxThreads: number): Promise<CollectedThreads> {
  const collected: ThreadChannel[] = [];
  let scannedActive = 0;
  let scannedArchived = 0;
  let hitLimit = false;

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

  hitLimit = collected.length >= maxThreads;

  return {
    threads: uniqueThreads(collected).slice(0, maxThreads),
    scannedActive,
    scannedArchived,
    hitLimit,
  };
}

function countThreadAuthors(threads: ThreadChannel[]): AuthorStats[] {
  const counts = new Map<Snowflake, number>();

  for (const thread of threads) {
    if (!thread.ownerId) {
      continue;
    }

    counts.set(thread.ownerId, (counts.get(thread.ownerId) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([userId, count]) => ({ userId, count }))
    .sort((left, right) => right.count - left.count || left.userId.localeCompare(right.userId));
}

async function userLabel(interaction: ChatInputCommandInteraction, userId: Snowflake): Promise<string> {
  try {
    const member = await interaction.guild?.members.fetch(userId);
    if (member) {
      return `${member.displayName} (@${member.user.username})`;
    }
  } catch {
    // Fall back to the global user object below.
  }

  try {
    const user = await interaction.client.users.fetch(userId);
    return `@${user.username}`;
  } catch {
    return `<@${userId}>`;
  }
}

export async function handleTesterStatsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!canUseTesterStats(interaction)) {
    await interaction.reply({
      content: "Нет доступа к статистике тикетов.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const limit = interaction.options.getInteger("limit") ?? 10;
  const maxThreads = interaction.options.getInteger("max_threads") ?? 500;
  const includeArchived = interaction.options.getBoolean("archived") ?? true;

  logger.info("tester stats command executed", {
    user_id: interaction.user.id,
    limit,
    max_threads: maxThreads,
    archived: includeArchived,
  });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const channel = await interaction.client.channels.fetch(config.discord.forumChannelId);
    if (!isConfiguredForumChannel(channel)) {
      await interaction.editReply("Настроенный Discord forum channel не найден или это не forum channel.");
      return;
    }

    const collected = await collectForumThreads(channel, includeArchived, maxThreads);
    const stats = countThreadAuthors(collected.threads).slice(0, limit);

    if (stats.length === 0) {
      await interaction.editReply("Не нашел тем с известными авторами в настроенном forum channel.");
      return;
    }

    const lines = await Promise.all(
      stats.map(async (stat, index) => {
        const label = await userLabel(interaction, stat.userId);
        return `${index + 1}. ${label} - ${stat.count}`;
      }),
    );

    const archiveText = includeArchived ? "активные + архивные" : "только активные";
    const limitText = collected.hitLimit ? `\nОстановился на лимите max_threads=${maxThreads}.` : "";

    await interaction.editReply(
      [
        `Самые активные авторы тем (${archiveText}):`,
        "",
        ...lines,
        "",
        `Просмотрено тем: ${collected.threads.length} (active: ${collected.scannedActive}, archived: ${collected.scannedArchived}).${limitText}`,
      ].join("\n"),
    );
  } catch (error) {
    logger.error("error", {
      action: "tester_stats_command",
      error: error instanceof Error ? error.message : String(error),
    });

    await interaction.editReply("Не удалось собрать статистику по forum channel. Проверьте права бота на просмотр тредов.");
  }
}
