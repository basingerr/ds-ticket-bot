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
import { checkDatabaseWritable } from "../db/database.js";
import { findByDiscordThreadId, updateStatus } from "../db/ticketLinks.js";
import { getTrelloBoard, getTrelloCardWithList, listTrelloWebhooks } from "../trello/client.js";
import { statusFromListName } from "../trello/statusMap.js";
import { applyStatusTag } from "./threadTags.js";
import { upsertStatusMessage } from "./statusMessage.js";
import { applyStatusReaction } from "./statusReaction.js";
import { logger } from "../utils/logger.js";

export const syncTicketCommand = new SlashCommandBuilder()
  .setName("sync-ticket")
  .setDescription("Синхронизировать текущий Discord ticket с Trello card.");

export const testerStatsCommand = new SlashCommandBuilder()
  .setName("tester-stats")
  .setDescription("Показать самых активных авторов тем в ticket forum.")
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
  .setDescription("Проверить здоровье Discord/Trello/SQLite bridge.");

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

type HealthCheck = {
  name: string;
  ok: boolean;
  details: string;
};

function okCheck(name: string, details: string): HealthCheck {
  return { name, ok: true, details };
}

function failCheck(name: string, error: unknown): HealthCheck {
  return {
    name,
    ok: false,
    details: error instanceof Error ? error.message : String(error),
  };
}

function checkLine(check: HealthCheck): string {
  return `${check.ok ? "OK" : "FAIL"} **${check.name}** - ${check.details}`;
}

async function runHealthChecks(interaction: ChatInputCommandInteraction): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];

  checks.push(okCheck("Mode", botModeLabel(getBotMode())));
  checks.push(okCheck("Discord client", `ready=${interaction.client.isReady()}, ping=${interaction.client.ws.ping}ms`));

  try {
    const guild = await interaction.client.guilds.fetch(config.discord.guildId);
    checks.push(okCheck("Discord guild", guild.name));
  } catch (error) {
    checks.push(failCheck("Discord guild", error));
  }

  try {
    const channel = await interaction.client.channels.fetch(config.discord.forumChannelId);
    checks.push(
      isConfiguredForumChannel(channel)
        ? okCheck("Discord forum", `${channel.name} (${channel.id})`)
        : { name: "Discord forum", ok: false, details: "configured channel is not a forum channel" },
    );
  } catch (error) {
    checks.push(failCheck("Discord forum", error));
  }

  try {
    checkDatabaseWritable();
    checks.push(okCheck("SQLite", "read/write ok"));
  } catch (error) {
    checks.push(failCheck("SQLite", error));
  }

  try {
    const board = await getTrelloBoard();
    checks.push(okCheck("Trello board", `${board.name}${board.closed ? " (closed)" : ""}`));
  } catch (error) {
    checks.push(failCheck("Trello board", error));
  }

  try {
    const expectedCallback = `${config.publicBaseUrl}/webhooks/trello`;
    const webhooks = await listTrelloWebhooks();
    const matching = webhooks.filter((webhook) => webhook.callbackUrl === expectedCallback);

    if (matching.length === 0) {
      checks.push({ name: "Trello webhook", ok: false, details: `no webhook for ${expectedCallback}` });
    } else {
      const activeCount = matching.filter((webhook) => webhook.active).length;
      const maxFailures = Math.max(...matching.map((webhook) => webhook.consecutiveFailures ?? 0));
      checks.push(okCheck("Trello webhook", `matching=${matching.length}, active=${activeCount}, failures=${maxFailures}`));
    }
  } catch (error) {
    checks.push(failCheck("Trello webhook", error));
  }

  checks.push(okCheck("Public URL", config.publicBaseUrl.startsWith("https://") ? config.publicBaseUrl : `${config.publicBaseUrl} (not https)`));
  checks.push(okCheck("Reconciliation", config.reconcileIntervalMs === 0 ? "disabled" : `${config.reconcileIntervalMs}ms`));

  return checks;
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

  const checks = await runHealthChecks(interaction);
  const failed = checks.filter((check) => !check.ok).length;
  const embed = new EmbedBuilder()
    .setColor(failed === 0 ? 0x22c55e : 0xef4444)
    .setTitle("Bot health")
    .setDescription(checks.map(checkLine).join("\n"))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

export async function handleSyncTicketCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;

  logger.info("sync command executed", {
    discord_thread_id: channel?.id,
    user_id: interaction.user.id,
  });

  if (!channel?.isThread()) {
    await interaction.reply({
      content: "Команду нужно вызвать внутри Discord thread.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const link = findByDiscordThreadId(channel.id);
  if (!link) {
    await interaction.reply({
      content: "Связка с Trello-карточкой не найдена.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const card = await getTrelloCardWithList(link.trelloCardId);
    const status = statusFromListName(card.listName);
    const updatedLink = status !== link.status ? updateStatus(link.id, status) : link;

    await upsertStatusMessage(channel, updatedLink, status);
    await applyStatusTag(channel, status);
    await applyStatusReaction(channel, status);

    await interaction.reply(`Тикет синхронизирован.\nТекущий статус: ${status}.`);
  } catch (error) {
    logger.error("error", {
      discord_thread_id: channel.id,
      trello_card_id: link.trelloCardId,
      action: "sync_ticket_command",
      error: error instanceof Error ? error.message : String(error),
    });

    await interaction.reply({
      content: "Не удалось синхронизировать тикет. Команда проверит вручную.",
      flags: MessageFlags.Ephemeral,
    });
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
