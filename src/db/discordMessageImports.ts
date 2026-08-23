import { db } from "./database.js";
import { nowIso } from "../utils/dates.js";

type ImportedMessageRow = {
  discord_message_id: string;
  ticket_link_id: number;
  kind: string;
  imported_at: string;
  content_cleared_at: string | null;
  deleted_at: string | null;
};

export type ImportedDiscordMessage = {
  discordMessageId: string;
  ticketLinkId: number;
  kind: "starter" | "comment";
  importedAt: string;
  contentClearedAt: string | null;
  deletedAt: string | null;
};

function mapRow(row: ImportedMessageRow | undefined): ImportedDiscordMessage | null {
  if (!row) {
    return null;
  }

  return {
    discordMessageId: row.discord_message_id,
    ticketLinkId: row.ticket_link_id,
    kind: row.kind === "starter" ? "starter" : "comment",
    importedAt: row.imported_at,
    contentClearedAt: row.content_cleared_at,
    deletedAt: row.deleted_at,
  };
}

export function findImportedDiscordMessage(discordMessageId: string): ImportedDiscordMessage | null {
  return mapRow(
    db.prepare("SELECT * FROM discord_message_imports WHERE discord_message_id = ?").get(discordMessageId) as ImportedMessageRow | undefined,
  );
}

export function recordImportedDiscordMessage(input: {
  discordMessageId: string;
  ticketLinkId: number;
  kind: "starter" | "comment";
}): boolean {
  const result = db.prepare(`
    INSERT INTO discord_message_imports (discord_message_id, ticket_link_id, kind, imported_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_message_id) DO NOTHING
  `).run(input.discordMessageId, input.ticketLinkId, input.kind, nowIso());

  return result.changes > 0;
}

export function markImportedDiscordMessageContentCleared(discordMessageId: string): boolean {
  const result = db.prepare(`
    UPDATE discord_message_imports
    SET content_cleared_at = ?
    WHERE discord_message_id = ? AND content_cleared_at IS NULL
  `).run(nowIso(), discordMessageId);

  return result.changes > 0;
}

export function markImportedDiscordMessageDeleted(discordMessageId: string): ImportedDiscordMessage | null {
  const existing = findImportedDiscordMessage(discordMessageId);
  if (!existing || existing.deletedAt) {
    return null;
  }

  db.prepare("UPDATE discord_message_imports SET deleted_at = ? WHERE discord_message_id = ?").run(nowIso(), discordMessageId);
  return existing;
}
