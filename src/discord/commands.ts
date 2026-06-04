import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { findByDiscordThreadId, updateStatus } from "../db/ticketLinks.js";
import { getTrelloCardWithList } from "../trello/client.js";
import { statusFromListName } from "../trello/statusMap.js";
import { applyStatusTag } from "./threadTags.js";
import { logger } from "../utils/logger.js";

export const syncTicketCommand = new SlashCommandBuilder()
  .setName("sync-ticket")
  .setDescription("Синхронизировать текущий Discord ticket с Trello card.");

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

    if (status !== link.status) {
      updateStatus(link.id, status);
      await applyStatusTag(channel, status);
    }

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
