import { EmbedBuilder, ThreadChannel } from "discord.js";
import { updateDiscordStatusMessageId, type TicketLink } from "../db/ticketLinks.js";
import { logger } from "../utils/logger.js";

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
      "Фикс готов к перепроверке. Проверьте заново и отпишите результат в этой теме:",
      "- ок",
      "- не исправлено",
      "- проблема изменилась",
    ].join("\n");
  }

  if (status === "Need Info" || status === "Нужна информация") {
    return "Нужна дополнительная информация. Опишите детали в этой теме.";
  }

  return null;
}

function buildStatusEmbed(status: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(colorForStatus(status))
    .setTitle("Статус тикета")
    .setDescription(`**${status}**`)
    .setTimestamp();

  const note = noteForStatus(status);
  if (note) {
    embed.addFields({ name: "Что дальше", value: note });
  }

  return embed;
}

export async function upsertStatusMessage(thread: ThreadChannel, link: TicketLink, status: string): Promise<string> {
  const embed = buildStatusEmbed(status);

  if (link.discordStatusMessageId) {
    try {
      const message = await thread.messages.fetch(link.discordStatusMessageId);
      await message.edit({ embeds: [embed] });
      return message.id;
    } catch (error) {
      logger.warn("status message edit failed, creating a new one", {
        discord_thread_id: thread.id,
        discord_status_message_id: link.discordStatusMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const message = await thread.send({ embeds: [embed] });
  updateDiscordStatusMessageId(link.id, message.id);
  return message.id;
}
