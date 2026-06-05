import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const value = optional(name, String(fallback));
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric env var: ${name}`);
  }

  return parsed;
}

function optionalCsv(name: string, fallback: string[] = []): string[] {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalBotMode(name: string, fallback: "active" | "readonly"): "active" | "readonly" {
  const value = optional(name, fallback);
  if (value !== "active" && value !== "readonly") {
    throw new Error(`Invalid bot mode env var: ${name}`);
  }

  return value;
}

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    clientId: required("DISCORD_CLIENT_ID"),
    guildId: required("DISCORD_GUILD_ID"),
    forumChannelId: required("DISCORD_FORUM_CHANNEL_ID"),
  },
  trello: {
    key: required("TRELLO_KEY"),
    token: required("TRELLO_TOKEN"),
    boardId: required("TRELLO_BOARD_ID"),
    inboxListId: required("TRELLO_INBOX_LIST_ID"),
  },
  publicBaseUrl: required("PUBLIC_BASE_URL").replace(/\/+$/, ""),
  databaseUrl: optional("DATABASE_URL", "file:./data/tickets.sqlite"),
  port: Number(optional("PORT", "3000")),
  trelloStatusDebounceMs: optionalNumber("TRELLO_STATUS_DEBOUNCE_MS", 2500),
  reconcileIntervalMs: optionalNumber("RECONCILE_INTERVAL_MS", 300000),
  botDefaultMode: optionalBotMode("BOT_DEFAULT_MODE", "active"),
  botAdminUserIds: optionalCsv("BOT_ADMIN_USER_IDS"),
  botAdminRoleIds: optionalCsv("BOT_ADMIN_ROLE_IDS"),
  testerStatsRoleIds: optionalCsv("TESTER_STATS_ROLE_IDS", ["1253347054000803922", "1443903847046053949"]),
};
