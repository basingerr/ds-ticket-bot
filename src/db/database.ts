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
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function closeDatabase(): void {
  db.close();
}
