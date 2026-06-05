import { Client, ForumChannel, ChannelType } from "discord.js";
import { getBotModeState, type BotMode } from "./botMode.js";
import { config } from "./config.js";
import { checkDatabaseWritable } from "./db/database.js";
import { getTrelloBoard, listTrelloWebhooks } from "./trello/client.js";

export type HealthCheck = {
  name: string;
  ok: boolean;
  details: string;
};

function okCheck(name: string, details: string): HealthCheck {
  return { name, ok: true, details };
}

function failCheck(name: string, error: unknown): HealthCheck {
  return {
    name,
    ok: false,
    details: error instanceof Error ? error.message : String(error),
  };
}

function botModeLabel(mode: BotMode): string {
  return mode === "active" ? "active - бот работает" : "readonly - бот ничего не создает и не синхронизирует";
}

function isConfiguredForumChannel(channel: unknown): channel is ForumChannel {
  return channel instanceof ForumChannel && channel.type === ChannelType.GuildForum;
}

export function healthCheckLine(check: HealthCheck): string {
  return `${check.ok ? "OK" : "FAIL"} **${check.name}** - ${check.details}`;
}

export function healthCheckKey(check: HealthCheck): string {
  return `${check.name}:${check.ok ? "ok" : "fail"}:${check.details}`;
}

export async function runHealthChecks(client: Client): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const botModeState = getBotModeState();

  if (
    config.readonlyAlertAfterMs > 0 &&
    botModeState.mode === "readonly" &&
    botModeState.updatedAt &&
    Date.now() - Date.parse(botModeState.updatedAt) >= config.readonlyAlertAfterMs
  ) {
    checks.push({
      name: "Mode",
      ok: false,
      details: `${botModeLabel(botModeState.mode)} since ${botModeState.updatedAt}`,
    });
  } else {
    checks.push(okCheck("Mode", botModeLabel(botModeState.mode)));
  }

  checks.push(okCheck("Discord client", `ready=${client.isReady()}, ping=${client.ws.ping}ms`));

  try {
    const guild = await client.guilds.fetch(config.discord.guildId);
    checks.push(okCheck("Discord guild", guild.name));
  } catch (error) {
    checks.push(failCheck("Discord guild", error));
  }

  try {
    const channel = await client.channels.fetch(config.discord.forumChannelId);
    checks.push(
      isConfiguredForumChannel(channel)
        ? okCheck("Discord forum", `${channel.name} (${channel.id})`)
        : { name: "Discord forum", ok: false, details: "configured channel is not a forum channel" },
    );
  } catch (error) {
    checks.push(failCheck("Discord forum", error));
  }

  try {
    checkDatabaseWritable();
    checks.push(okCheck("SQLite", "read/write ok"));
  } catch (error) {
    checks.push(failCheck("SQLite", error));
  }

  try {
    const board = await getTrelloBoard();
    checks.push(okCheck("Trello board", `${board.name}${board.closed ? " (closed)" : ""}`));
  } catch (error) {
    checks.push(failCheck("Trello board", error));
  }

  try {
    const expectedCallback = `${config.publicBaseUrl}/webhooks/trello`;
    const webhooks = await listTrelloWebhooks();
    const matching = webhooks.filter((webhook) => webhook.callbackUrl === expectedCallback);

    if (matching.length === 0) {
      checks.push({ name: "Trello webhook", ok: false, details: `no webhook for ${expectedCallback}` });
    } else {
      const activeCount = matching.filter((webhook) => webhook.active).length;
      const maxFailures = Math.max(...matching.map((webhook) => webhook.consecutiveFailures ?? 0));
      checks.push({
        name: "Trello webhook",
        ok: activeCount > 0 && maxFailures === 0,
        details: `matching=${matching.length}, active=${activeCount}, failures=${maxFailures}`,
      });
    }
  } catch (error) {
    checks.push(failCheck("Trello webhook", error));
  }

  checks.push({
    name: "Public URL",
    ok: config.publicBaseUrl.startsWith("https://"),
    details: config.publicBaseUrl.startsWith("https://") ? config.publicBaseUrl : `${config.publicBaseUrl} (not https)`,
  });
  checks.push(okCheck("Reconciliation", config.reconcileIntervalMs === 0 ? "disabled" : `${config.reconcileIntervalMs}ms`));

  return checks;
}
