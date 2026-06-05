import { Client, EmbedBuilder, SendableChannels } from "discord.js";
import { config } from "./config.js";
import { healthCheckKey, healthCheckLine, runHealthChecks, type HealthCheck } from "./healthChecks.js";
import { logger } from "./utils/logger.js";

type WatchdogState = {
  lastFailureSignature: string | null;
  lastRecoveryAt: number | null;
};

const state: WatchdogState = {
  lastFailureSignature: null,
  lastRecoveryAt: null,
};

function failureSignature(failed: HealthCheck[]): string {
  return failed.map(healthCheckKey).sort().join("|");
}

function buildWatchdogEmbed(status: "degraded" | "recovered", checks: HealthCheck[]): EmbedBuilder {
  const failed = checks.filter((check) => !check.ok);
  const title = status === "degraded" ? "Bot health degraded" : "Bot health recovered";
  const description = status === "degraded"
    ? failed.map(healthCheckLine).join("\n")
    : checks.map(healthCheckLine).join("\n");

  return new EmbedBuilder()
    .setColor(status === "degraded" ? 0xef4444 : 0x22c55e)
    .setTitle(title)
    .setDescription(description.slice(0, 4000))
    .setTimestamp();
}

async function fetchAlertChannel(client: Client): Promise<SendableChannels | null> {
  if (!config.watchdogAlertChannelId) {
    return null;
  }

  const channel = await client.channels.fetch(config.watchdogAlertChannelId);
  return channel?.isSendable() ? channel : null;
}

async function sendWatchdogAlert(client: Client, embed: EmbedBuilder): Promise<void> {
  const channel = await fetchAlertChannel(client);
  if (!channel) {
    logger.warn("watchdog alert channel unavailable", {
      channel_id: config.watchdogAlertChannelId,
    });
    return;
  }

  await channel.send({ embeds: [embed] });
}

async function runWatchdog(client: Client): Promise<void> {
  const checks = await runHealthChecks(client);
  const failed = checks.filter((check) => !check.ok);

  if (failed.length > 0) {
    const signature = failureSignature(failed);
    if (signature !== state.lastFailureSignature) {
      await sendWatchdogAlert(client, buildWatchdogEmbed("degraded", checks));
      state.lastFailureSignature = signature;
      state.lastRecoveryAt = null;
    }

    logger.warn("watchdog detected degraded health", {
      failed: failed.map((check) => check.name),
    });
    return;
  }

  if (state.lastFailureSignature) {
    const now = Date.now();
    const canSendRecovery = !state.lastRecoveryAt || now - state.lastRecoveryAt >= config.watchdogRecoveryCooldownMs;

    if (canSendRecovery) {
      await sendWatchdogAlert(client, buildWatchdogEmbed("recovered", checks));
      state.lastRecoveryAt = now;
    }

    state.lastFailureSignature = null;
  }
}

export function startWatchdog(client: Client): NodeJS.Timeout | null {
  if (config.watchdogIntervalMs === 0) {
    logger.info("watchdog disabled");
    return null;
  }

  if (!config.watchdogAlertChannelId) {
    logger.info("watchdog disabled: no alert channel configured");
    return null;
  }

  logger.info("watchdog scheduled", {
    interval_ms: config.watchdogIntervalMs,
    alert_channel_id: config.watchdogAlertChannelId,
  });

  void runWatchdog(client).catch((error) => {
    logger.error("error", {
      action: "watchdog_initial_run",
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return setInterval(() => {
    void runWatchdog(client).catch((error) => {
      logger.error("error", {
        action: "watchdog_run",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, config.watchdogIntervalMs);
}
