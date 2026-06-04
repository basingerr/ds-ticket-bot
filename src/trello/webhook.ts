import { Client } from "discord.js";
import express, { Router } from "express";
import { config } from "../config.js";
import { findByTrelloCardId, updateStatus } from "../db/ticketLinks.js";
import { getTrelloCardWithList } from "./client.js";
import { statusFromListName } from "./statusMap.js";
import { applyStatusTag } from "../discord/threadTags.js";
import { upsertStatusMessage } from "../discord/statusMessage.js";
import { logger } from "../utils/logger.js";

type TrelloWebhookBody = {
  action?: {
    type?: string;
    data?: {
      card?: {
        id?: string;
        closed?: boolean;
        dueComplete?: boolean;
      };
      old?: {
        closed?: boolean;
        dueComplete?: boolean;
      };
      listAfter?: {
        id?: string;
        name?: string;
      };
    };
  };
};

type PendingStatusUpdate = {
  timer: NodeJS.Timeout;
  trelloCardId: string;
  status: string;
};

const pendingStatusUpdates = new Map<string, PendingStatusUpdate>();

async function updateDiscordThread(client: Client, trelloCardId: string, status: string): Promise<void> {
  const link = findByTrelloCardId(trelloCardId);
  if (!link) {
    logger.info("unlinked trello card", { trello_card_id: trelloCardId });
    return;
  }

  const channel = await client.channels.fetch(link.discordThreadId);

  if (!channel || !channel.isThread()) {
    throw new Error("Discord thread not found");
  }

  await upsertStatusMessage(channel, link, status);
  await applyStatusTag(channel, status);
}

async function setDiscordThreadArchived(client: Client, trelloCardId: string, archived: boolean): Promise<void> {
  const link = findByTrelloCardId(trelloCardId);
  if (!link) {
    logger.info("unlinked trello card", { trello_card_id: trelloCardId });
    return;
  }

  const channel = await client.channels.fetch(link.discordThreadId);
  if (!channel || !channel.isThread()) {
    throw new Error("Discord thread not found");
  }

  if (channel.archived === archived) {
    return;
  }

  await channel.setArchived(archived, archived ? "Trello ticket closed" : "Trello ticket reopened");

  logger.info(archived ? "discord thread archived" : "discord thread reopened", {
    trello_card_id: trelloCardId,
    discord_thread_id: link.discordThreadId,
  });
}

async function syncTrelloCardCurrentStatus(client: Client, trelloCardId: string): Promise<void> {
  const card = await getTrelloCardWithList(trelloCardId);
  const status = statusFromListName(card.listName);
  await applyTrelloCardMove(client, trelloCardId, status);
}

async function handleTrelloClosedStateChange(client: Client, trelloCardId: string, isClosed: boolean): Promise<void> {
  if (isClosed) {
    await setDiscordThreadArchived(client, trelloCardId, true);
    return;
  }

  await setDiscordThreadArchived(client, trelloCardId, false);
  await syncTrelloCardCurrentStatus(client, trelloCardId);
}

async function applyTrelloCardMove(client: Client, trelloCardId: string, status: string): Promise<void> {
  const link = findByTrelloCardId(trelloCardId);
  if (!link) {
    logger.info("unlinked trello card", { trello_card_id: trelloCardId });
    return;
  }

  if (status === link.status) {
    logger.info("trello card moved duplicate status ignored", {
      trello_card_id: trelloCardId,
      discord_thread_id: link.discordThreadId,
      status,
    });
    return;
  }

  logger.info("trello card moved", {
    trello_card_id: trelloCardId,
    discord_thread_id: link.discordThreadId,
    status,
  });

  try {
    await updateDiscordThread(client, trelloCardId, status);
    updateStatus(link.id, status);

    logger.info("discord thread updated", {
      trello_card_id: trelloCardId,
      discord_thread_id: link.discordThreadId,
      status,
    });
  } catch (error) {
    logger.error("error", {
      trello_card_id: trelloCardId,
      discord_thread_id: link.discordThreadId,
      action: "trello_webhook_update_discord_thread",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function scheduleTrelloCardMove(client: Client, trelloCardId: string, status: string): void {
  const pending = pendingStatusUpdates.get(trelloCardId);
  if (pending) {
    clearTimeout(pending.timer);
  }

  const timer = setTimeout(() => {
    pendingStatusUpdates.delete(trelloCardId);
    void applyTrelloCardMove(client, trelloCardId, status);
  }, config.trelloStatusDebounceMs);

  pendingStatusUpdates.set(trelloCardId, {
    timer,
    trelloCardId,
    status,
  });
}

export function createTrelloWebhookRouter(client: Client): Router {
  const router = Router();

  router.head("/trello", (_request, response) => {
    response.sendStatus(200);
  });

  router.post("/trello", express.json({ limit: "1mb" }), async (request, response) => {
    response.sendStatus(200);

    const body = request.body as TrelloWebhookBody;
    const action = body.action;

    logger.info("trello webhook received", {
      action_type: action?.type,
      trello_card_id: action?.data?.card?.id,
    });

    if (action?.type !== "updateCard") {
      return;
    }

    const data = action.data;
    const trelloCardId = data?.card?.id;
    const listName = data?.listAfter?.name;

    if (!trelloCardId) {
      return;
    }

    const closedChanged = data?.old?.closed !== undefined && data.card?.closed !== undefined;
    const dueCompleteChanged = data?.old?.dueComplete !== undefined && data.card?.dueComplete !== undefined;

    if (closedChanged || dueCompleteChanged) {
      const isClosed = data?.card?.closed === true || data?.card?.dueComplete === true;

      try {
        await handleTrelloClosedStateChange(client, trelloCardId, isClosed);
      } catch (error) {
        logger.error("error", {
          trello_card_id: trelloCardId,
          action: "sync_discord_thread_archive_from_trello",
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return;
    }

    if (!listName) {
      return;
    }

    const link = findByTrelloCardId(trelloCardId);
    if (!link) {
      logger.info("unlinked trello card", { trello_card_id: trelloCardId });
      return;
    }

    const status = statusFromListName(listName);
    const pending = pendingStatusUpdates.get(trelloCardId);
    if (status === link.status && !pending) {
      logger.info("trello card moved duplicate status ignored", {
        trello_card_id: trelloCardId,
        discord_thread_id: link.discordThreadId,
        status,
      });
      return;
    }

    logger.info("trello card move scheduled", {
      trello_card_id: trelloCardId,
      discord_thread_id: link.discordThreadId,
      status,
      debounce_ms: config.trelloStatusDebounceMs,
    });

    scheduleTrelloCardMove(client, trelloCardId, status);
  });

  return router;
}
