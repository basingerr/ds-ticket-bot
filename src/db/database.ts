import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { config } from "../config.js";
import { nowIso } from "../utils/dates.js";

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

    CREATE TABLE IF NOT EXISTS discord_message_imports (
      discord_message_id TEXT PRIMARY KEY,
      ticket_link_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      content_cleared_at TEXT,
      deleted_at TEXT
    );
  `);

  const columns = db.prepare("PRAGMA table_info(ticket_links)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("reconcile_after")) {
    db.exec("ALTER TABLE ticket_links ADD COLUMN reconcile_after INTEGER NOT NULL DEFAULT 0");
  }

  if (!columnNames.has("discord_status_message_id")) {
    db.exec("ALTER TABLE ticket_links ADD COLUMN discord_status_message_id TEXT");
  }

  if (!columnNames.has("reconcile_disabled_at")) {
    db.exec("ALTER TABLE ticket_links ADD COLUMN reconcile_disabled_at TEXT");
  }

  if (!columnNames.has("reconcile_disabled_reason")) {
    db.exec("ALTER TABLE ticket_links ADD COLUMN reconcile_disabled_reason TEXT");
  }

  if (!columnNames.has("discord_missing_at")) {
    db.exec("ALTER TABLE ticket_links ADD COLUMN discord_missing_at TEXT");
  }
}

export function closeDatabase(): void {
  db.close();
}

export function checkDatabaseWritable(): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run("health_check", "ok", nowIso());
}
