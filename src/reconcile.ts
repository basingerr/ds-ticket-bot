import { Client } from "discord.js";
import { config } from "./config.js";
import { listTicketLinks, updateStatus, type TicketLink } from "./db/ticketLinks.js";
import { applyStatusReaction } from "./discord/statusReaction.js";
import { upsertStatusMessage } from "./discord/statusMessage.js";
import { applyStatusTag } from "./discord/threadTags.js";
import { getTrelloCardWithList } from "./trello/client.js";
import { statusFromListName } from "./trello/statusMap.js";
import { logger } from "./utils/logger.js";

async function reconcileTicketLink(client: Client, link: TicketLink): Promise<"updated" | "unchanged" | "skipped"> {
  const card = await getTrelloCardWithList(link.trelloCardId);
  const status = statusFromListName(card.listName);
  const shouldBeArchived = card.closed || card.dueComplete;

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
      await channel.setArchived(true, "Trello reconciliation: ticket closed");
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
