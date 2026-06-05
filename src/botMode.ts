import { config } from "./config.js";
import { db } from "./db/database.js";
import { nowIso } from "./utils/dates.js";

export type BotMode = "active" | "readonly";

type AppSettingRow = {
  value: string;
  updated_at: string;
};

const BOT_MODE_KEY = "bot_mode";

function isBotMode(value: string): value is BotMode {
  return value === "active" || value === "readonly";
}

export function getBotMode(): BotMode {
  return getBotModeState().mode;
}

export function getBotModeState(): { mode: BotMode; updatedAt: string | null } {
  const row = db.prepare("SELECT value, updated_at FROM app_settings WHERE key = ?").get(BOT_MODE_KEY) as AppSettingRow | undefined;
  if (!row) {
    return { mode: config.botDefaultMode, updatedAt: null };
  }

  return {
    mode: isBotMode(row.value) ? row.value : config.botDefaultMode,
    updatedAt: row.updated_at,
  };
}

export function setBotMode(mode: BotMode): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(BOT_MODE_KEY, mode, nowIso());
}

export function isBotReadonly(): boolean {
  return getBotMode() === "readonly";
}
