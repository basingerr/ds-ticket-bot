import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { config } from "../config.js";

function databasePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("Only file: SQLite DATABASE_URL is supported");
  }

  return resolve(process.cwd(), databaseUrl.slice("file:".length));
}

const databasePath = databasePathFromUrl(config.databaseUrl);
const databaseDir = dirname(databasePath);

if (!existsSync(databaseDir)) {
  mkdirSync(databaseDir, { recursive: true });
}

export const db = new Database(databasePath);

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_guild_id TEXT NOT NULL,
      discord_channel_id TEXT NOT NULL,
      discord_thread_id TEXT NOT NULL UNIQUE,
      discord_author_id TEXT,
      trello_card_id TEXT NOT NULL UNIQUE,
      trello_card_url TEXT,
      discord_status_message_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const columns = db.prepare("PRAGMA table_info(ticket_links)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("discord_status_message_id")) {
    db.exec("ALTER TABLE ticket_links ADD COLUMN discord_status_message_id TEXT");
  }
}

export function closeDatabase(): void {
  db.close();
}
