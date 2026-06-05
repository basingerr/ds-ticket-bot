import { Client } from "discord.js";
import { isBotReadonly } from "./botMode.js";
import { config } from "./config.js";
import { listTicketLinks, updateStatus, type TicketLink } from "./db/ticketLinks.js";
import { applyStatusReaction } from "./discord/statusReaction.js";
import { upsertStatusMessage } from "./discord/statusMessage.js";
import { applyStatusTag } from "./discord/threadTags.js";
import { getTrelloCardWithList } from "./trello/client.js";
import { statusFromListName } from "./trello/statusMap.js";
import { logger } from "./utils/logger.js";

function isTrelloNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Trello API error 404");
}

async function closeMissingTrelloCardThread(
  client: Client,
  link: TicketLink,
): Promise<"updated" | "unchanged" | "skipped"> {
  const channel = await client.channels.fetch(link.discordThreadId);
  if (!channel || !channel.isThread()) {
    logger.warn("reconcile skipped: discord thread not found for missing trello card", {
      discord_thread_id: link.discordThreadId,
      trello_card_id: link.trelloCardId,
    });
    return "skipped";
  }

  if (channel.archived) {
    return "unchanged";
  }

  await channel.send("Тикет закрыт: внутренняя Trello-карточка удалена или больше недоступна. Команда проверит вручную.");
  await channel.setArchived(true, "Trello reconciliation: card missing");
  return "updated";
}

async function reconcileTicketLink(client: Client, link: TicketLink): Promise<"updated" | "unchanged" | "skipped"> {
  let card;
  try {
    card = await getTrelloCardWithList(link.trelloCardId);
  } catch (error) {
    if (isTrelloNotFoundError(error)) {
      return closeMissingTrelloCardThread(client, link);
    }

    throw error;
  }

  const status = statusFromListName(card.listName);
  const shouldBeArchived = card.dueComplete || card.closed;

  const channel = await client.channels.fetch(link.discordThreadId);
  if (!channel || !channel.isThread()) {
    logger.warn("reconcile skipped: discord thread not found", {
      discord_thread_id: link.discordThreadId,
      trello_card_id: link.trelloCardId,
    });
    return "skipped";
  }

  let changed = false;

  if (shouldBeArchived) {
    if (!channel.archived) {
      await channel.send(
        card.dueComplete
          ? "Тикет закрыт: внутренняя карточка отмечена завершенной."
          : "Тикет закрыт: внутренняя Trello-карточка архивирована.",
      );
      await channel.setArchived(true, card.dueComplete ? "Trello reconciliation: ticket completed" : "Trello reconciliation: card archived");
      changed = true;
    }

    if (status !== link.status) {
      updateStatus(link.id, status);
      changed = true;
    }

    return changed ? "updated" : "unchanged";
  }

  if (channel.archived) {
    await channel.setArchived(false, "Trello reconciliation: ticket reopened");
    changed = true;
  }

  if (status !== link.status || !link.discordStatusMessageId) {
    await upsertStatusMessage(channel, link, status);
    updateStatus(link.id, status);
    changed = true;
  }

  await applyStatusTag(channel, status);
  await applyStatusReaction(channel, status);

  return changed ? "updated" : "unchanged";
}

export async function runReconciliation(client: Client): Promise<void> {
  if (isBotReadonly()) {
    logger.warn("reconciliation skipped: bot readonly");
    return;
  }

  const links = listTicketLinks();
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;

  for (const link of links) {
    try {
      const result = await reconcileTicketLink(client, link);

      if (result === "updated") {
        updated += 1;
      } else if (result === "skipped") {
        skipped += 1;
      } else {
        unchanged += 1;
      }
    } catch (error) {
      failed += 1;
      logger.error("error", {
        discord_thread_id: link.discordThreadId,
        trello_card_id: link.trelloCardId,
        action: "reconcile_ticket_link",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("reconciliation complete", {
    checked: links.length,
    updated,
    unchanged,
    skipped,
    failed,
  });
}

export function startReconciliationJob(client: Client): NodeJS.Timeout | null {
  if (config.reconcileIntervalMs === 0) {
    logger.info("reconciliation disabled");
    return null;
  }

  logger.info("reconciliation scheduled", {
    interval_ms: config.reconcileIntervalMs,
  });

  return setInterval(() => {
    void runReconciliation(client);
  }, config.reconcileIntervalMs);
}
