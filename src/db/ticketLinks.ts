import { db } from "./database.js";
import { nowIso } from "../utils/dates.js";

export type TicketLink = {
  id: number;
  discordGuildId: string;
  discordChannelId: string;
  discordThreadId: string;
  discordAuthorId: string | null;
  trelloCardId: string;
  trelloCardUrl: string | null;
  discordStatusMessageId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type TicketLinkRow = {
  id: number;
  discord_guild_id: string;
  discord_channel_id: string;
  discord_thread_id: string;
  discord_author_id: string | null;
  trello_card_id: string;
  trello_card_url: string | null;
  discord_status_message_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type CreateTicketLinkInput = {
  discordGuildId: string;
  discordChannelId: string;
  discordThreadId: string;
  discordAuthorId?: string | null;
  trelloCardId: string;
  trelloCardUrl?: string | null;
  discordStatusMessageId?: string | null;
  status: string;
};

function mapRow(row: TicketLinkRow | undefined): TicketLink | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    discordGuildId: row.discord_guild_id,
    discordChannelId: row.discord_channel_id,
    discordThreadId: row.discord_thread_id,
    discordAuthorId: row.discord_author_id,
    trelloCardId: row.trello_card_id,
    trelloCardUrl: row.trello_card_url,
    discordStatusMessageId: row.discord_status_message_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTicketLink(input: CreateTicketLinkInput): TicketLink {
  const createdAt = nowIso();

  const statement = db.prepare(`
    INSERT INTO ticket_links (
      discord_guild_id,
      discord_channel_id,
      discord_thread_id,
      discord_author_id,
      trello_card_id,
      trello_card_url,
      discord_status_message_id,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  statement.run(
    input.discordGuildId,
    input.discordChannelId,
    input.discordThreadId,
    input.discordAuthorId ?? null,
    input.trelloCardId,
    input.trelloCardUrl ?? null,
    input.discordStatusMessageId ?? null,
    input.status,
    createdAt,
    createdAt,
  );

  const link = findByDiscordThreadId(input.discordThreadId);
  if (!link) {
    throw new Error("Ticket link was inserted but could not be loaded");
  }

  return link;
}

export function findByDiscordThreadId(discordThreadId: string): TicketLink | null {
  const row = db
    .prepare("SELECT * FROM ticket_links WHERE discord_thread_id = ?")
    .get(discordThreadId) as TicketLinkRow | undefined;

  return mapRow(row);
}

export function findByTrelloCardId(trelloCardId: string): TicketLink | null {
  const row = db
    .prepare("SELECT * FROM ticket_links WHERE trello_card_id = ?")
    .get(trelloCardId) as TicketLinkRow | undefined;

  return mapRow(row);
}

export function listTicketLinks(): TicketLink[] {
  const rows = db
    .prepare("SELECT * FROM ticket_links ORDER BY id ASC")
    .all() as TicketLinkRow[];

  return rows.map((row) => {
    const link = mapRow(row);
    if (!link) {
      throw new Error("Ticket link row could not be mapped");
    }

    return link;
  });
}

export function updateStatus(id: number, status: string): TicketLink {
  db.prepare("UPDATE ticket_links SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);

  const row = db.prepare("SELECT * FROM ticket_links WHERE id = ?").get(id) as TicketLinkRow | undefined;
  const link = mapRow(row);
  if (!link) {
    throw new Error("Ticket link was updated but could not be loaded");
  }

  return link;
}

export function updateDiscordStatusMessageId(id: number, discordStatusMessageId: string): TicketLink {
  db.prepare("UPDATE ticket_links SET discord_status_message_id = ?, updated_at = ? WHERE id = ?").run(
    discordStatusMessageId,
    nowIso(),
    id,
  );

  const row = db.prepare("SELECT * FROM ticket_links WHERE id = ?").get(id) as TicketLinkRow | undefined;
  const link = mapRow(row);
  if (!link) {
    throw new Error("Ticket link status message was updated but could not be loaded");
  }

  return link;
}
