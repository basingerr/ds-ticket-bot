import { Client } from "discord.js";
import express, { Router } from "express";
import { isBotReadonly } from "../botMode.js";
import { config } from "../config.js";
import { findByTrelloCardId, updateStatus } from "../db/ticketLinks.js";
import { getTrelloCardWithList } from "./client.js";
import { statusFromListName, statusFromTrelloList } from "./statusMap.js";
import { applyStatusTag } from "../discord/threadTags.js";
import { upsertCompletedStatusMessage, upsertManualCloseStatusMessage, upsertStatusMessage } from "../discord/statusMessage.js";
import { applyStatusReaction } from "../discord/statusReaction.js";
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
const pendingArchiveUpdates = new Set<string>();

function clearPendingStatusUpdate(trelloCardId: string): void {
  const pending = pendingStatusUpdates.get(trelloCardId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timer);
  pendingStatusUpdates.delete(trelloCardId);
}

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
  await applyStatusReaction(channel, status);
}

async function setDiscordThreadArchiveState(input: {
  client: Client;
  trelloCardId: string;
  archived: boolean;
  state?: "completed" | "manual_close";
  manualCloseReason?: string;
  status?: string;
  reason: string;
}): Promise<void> {
  const { client, trelloCardId, archived, state, manualCloseReason, status, reason } = input;
  if (archived && pendingArchiveUpdates.has(trelloCardId)) {
    logger.info("discord thread archive update already pending", {
      trello_card_id: trelloCardId,
    });
    return;
  }

  if (archived) {
    pendingArchiveUpdates.add(trelloCardId);
  }

  const link = findByTrelloCardId(trelloCardId);
  try {
    if (!link) {
      logger.info("unlinked trello card", { trello_card_id: trelloCardId });
      return;
    }

    const channel = await client.channels.fetch(link.discordThreadId);
    if (!channel || !channel.isThread()) {
      throw new Error("Discord thread not found");
    }

    if (archived && channel.archived) {
      logger.info("discord thread archive state already applied", {
        trello_card_id: trelloCardId,
        discord_thread_id: link.discordThreadId,
      });
      return;
    }

    if (state === "completed") {
      await upsertCompletedStatusMessage(channel, link, status);
      await applyStatusReaction(channel, "Готово");
    }

    if (state === "manual_close") {
      await upsertManualCloseStatusMessage(channel, link, manualCloseReason ?? "Команда проверит вручную.", status);
      await applyStatusReaction(channel, "manual_close");
    }

    if (channel.archived === archived) {
      return;
    }

    await channel.setArchived(archived, reason);

    logger.info(archived ? "discord thread archived" : "discord thread reopened", {
      trello_card_id: trelloCardId,
      discord_thread_id: link.discordThreadId,
    });
  } finally {
    if (archived) {
      pendingArchiveUpdates.delete(trelloCardId);
    }
  }
}

async function syncTrelloCardCurrentStatus(client: Client, trelloCardId: string): Promise<void> {
  const card = await getTrelloCardWithList(trelloCardId);
  const status = statusFromTrelloList(card.idList, card.listName);
  const link = findByTrelloCardId(trelloCardId);
  if (!link) {
    logger.info("unlinked trello card", { trello_card_id: trelloCardId });
    return;
  }

  await updateDiscordThread(client, trelloCardId, status);
  updateStatus(link.id, status);
}

async function handleTrelloClosedState(client: Client, trelloCardId: string): Promise<boolean> {
  const card = await getTrelloCardWithList(trelloCardId);
  const status = statusFromTrelloList(card.idList, card.listName);
  const isComplete = card.dueComplete;
  const isArchivedInTrello = card.closed;

  logger.info("trello card completion state checked", {
    trello_card_id: trelloCardId,
    closed: card.closed,
    due_complete: card.dueComplete,
    is_complete: isComplete,
    is_archived_in_trello: isArchivedInTrello,
  });

  if (isComplete) {
    await setDiscordThreadArchiveState({
      client,
      trelloCardId,
      archived: true,
      state: "completed",
      status,
      reason: "Trello ticket completed",
    });
    return true;
  }

  if (isArchivedInTrello) {
    await setDiscordThreadArchiveState({
      client,
      trelloCardId,
      archived: true,
      state: "manual_close",
      manualCloseReason: "Внутренняя Trello-карточка архивирована. Команда проверит вручную.",
      status,
      reason: "Trello card archived",
    });
    return true;
  }

  await setDiscordThreadArchiveState({
    client,
    trelloCardId,
    archived: false,
    reason: "Trello ticket reopened",
  });
  return false;
}

async function handleTrelloCardDeleted(client: Client, trelloCardId: string): Promise<void> {
  await setDiscordThreadArchiveState({
    client,
    trelloCardId,
    archived: true,
    state: "manual_close",
    manualCloseReason: "Внутренняя Trello-карточка удалена или больше недоступна. Команда проверит вручную.",
    reason: "Trello card deleted",
  });
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
    clearPendingStatusUpdate(trelloCardId);
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

    if (isBotReadonly()) {
      logger.warn("trello webhook ignored: bot readonly", {
        action_type: action?.type,
        trello_card_id: action?.data?.card?.id,
      });
      return;
    }

    const data = action?.data;
    const trelloCardId = data?.card?.id;

    if (action?.type === "deleteCard" && trelloCardId) {
      try {
        await handleTrelloCardDeleted(client, trelloCardId);
      } catch (error) {
        logger.error("error", {
          trello_card_id: trelloCardId,
          action: "sync_discord_thread_from_trello_delete",
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return;
    }

    if (action?.type !== "updateCard") {
      return;
    }

    const listId = data?.listAfter?.id;
    const listName = data?.listAfter?.name;

    if (!trelloCardId) {
      return;
    }

    try {
      const isClosed = await handleTrelloClosedState(client, trelloCardId);
      if (isClosed) {
        clearPendingStatusUpdate(trelloCardId);
        return;
      }

      if (!listName && (data?.old?.closed !== undefined || data?.old?.dueComplete !== undefined)) {
        await syncTrelloCardCurrentStatus(client, trelloCardId);
      }
    } catch (error) {
      logger.error("error", {
        trello_card_id: trelloCardId,
        action: "sync_discord_thread_archive_from_trello",
        error: error instanceof Error ? error.message : String(error),
      });
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

    const status = listId ? statusFromTrelloList(listId, listName) : statusFromListName(listName);
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
