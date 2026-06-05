import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ThreadChannel } from "discord.js";
import { config } from "../config.js";
import { updateDiscordStatusMessageId, type TicketLink } from "../db/ticketLinks.js";
import { logger } from "../utils/logger.js";

export const qaFixedButtonId = "qa_feedback:fixed";
export const qaNeedsWorkButtonId = "qa_feedback:needs_work";

export type StatusMessageState =
  | { kind: "status"; status: string }
  | { kind: "completed"; status?: string }
  | { kind: "manual_close"; reason: string; status?: string };

function colorForStatus(status: string): number {
  const normalized = status.toLowerCase();

  if (["new", "очередь", "inbox"].includes(normalized)) {
    return 0x8e8e93;
  }

  if (["accepted", "accepted"].includes(normalized)) {
    return 0x3b82f6;
  }

  if (["in progress", "в работе"].includes(normalized)) {
    return 0xf59e0b;
  }

  if (["ready for retest", "тестирование / на сервере"].includes(normalized)) {
    return 0x8b5cf6;
  }

  if (["verified", "готово"].includes(normalized)) {
    return 0x22c55e;
  }

  if (["need info", "нужна информация"].includes(normalized)) {
    return 0xeab308;
  }

  if (["rejected / duplicate", "rejected", "duplicate"].includes(normalized)) {
    return 0xef4444;
  }

  return 0x5865f2;
}

function noteForStatus(status: string): string | null {
  if (status === "Ready for Retest" || status === "Тестирование / на сервере") {
    return [
      "Фикс готов к перепроверке. Проверьте заново и нажмите кнопку ниже:",
      "- Исправлено",
      "- Нужна доработка",
    ].join("\n");
  }

  if (status === "Need Info" || status === "Нужна информация") {
    return "Нужна дополнительная информация. Опишите детали в этой теме.";
  }

  return null;
}

function buildStatusEmbed(status: string, options?: { title?: string; description?: string; color?: number; noteName?: string; note?: string }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(options?.color ?? colorForStatus(status))
    .setTitle(options?.title ?? "Статус тикета")
    .setDescription(options?.description ?? `**${status}**`)
    .setTimestamp();

  const note = options?.note ?? noteForStatus(status);
  if (note) {
    embed.addFields({ name: options?.noteName ?? "Порядок действий", value: note });
  }

  return embed;
}

function buildStatusMessageStateEmbed(state: StatusMessageState): EmbedBuilder {
  if (state.kind === "completed") {
    return buildStatusEmbed(state.status ?? "Завершен", {
      color: 0x22c55e,
      description: "**✅ Завершен**",
      noteName: "Причина",
      note: "Внутренняя карточка отмечена завершенной.",
    });
  }

  if (state.kind === "manual_close") {
    return buildStatusEmbed(state.status ?? "Закрыт вручную", {
      color: 0xef4444,
      description: "**⚠️ Закрыт вручную**",
      noteName: "Причина",
      note: state.reason,
    });
  }

  return buildStatusEmbed(state.status);
}

function buildStatusComponents(state: StatusMessageState): ActionRowBuilder<ButtonBuilder>[] {
  if (state.kind !== "status" || !config.qaReplyAlertStatuses.includes(state.status)) {
    return [];
  }

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(qaFixedButtonId)
        .setLabel("Исправлено")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(qaNeedsWorkButtonId)
        .setLabel("Нужна доработка")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function upsertStatusMessageState(thread: ThreadChannel, link: TicketLink, state: StatusMessageState): Promise<string> {
  const embed = buildStatusMessageStateEmbed(state);
  const components = buildStatusComponents(state);

  if (link.discordStatusMessageId) {
    try {
      const message = await thread.messages.fetch(link.discordStatusMessageId);
      await message.edit({ embeds: [embed], components });
      return message.id;
    } catch (error) {
      logger.warn("status message edit failed, creating a new one", {
        discord_thread_id: thread.id,
        discord_status_message_id: link.discordStatusMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const message = await thread.send({ embeds: [embed], components });
  updateDiscordStatusMessageId(link.id, message.id);
  return message.id;
}

export async function upsertStatusMessage(thread: ThreadChannel, link: TicketLink, status: string): Promise<string> {
  return upsertStatusMessageState(thread, link, { kind: "status", status });
}

export async function upsertCompletedStatusMessage(thread: ThreadChannel, link: TicketLink, status?: string): Promise<string> {
  return upsertStatusMessageState(thread, link, { kind: "completed", status });
}

export async function upsertManualCloseStatusMessage(
  thread: ThreadChannel,
  link: TicketLink,
  reason: string,
  status?: string,
): Promise<string> {
  return upsertStatusMessageState(thread, link, { kind: "manual_close", reason, status });
}
