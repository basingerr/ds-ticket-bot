import express from "express";
import { config } from "./config.js";
import { closeDatabase, initDatabase } from "./db/database.js";
import { createDiscordClient } from "./discord/client.js";
import { registerDiscordHandlers } from "./discord/handlers.js";
import { createTrelloWebhookRouter } from "./trello/webhook.js";
import { logger } from "./utils/logger.js";

initDatabase();

const discordClient = createDiscordClient();
registerDiscordHandlers(discordClient);

const app = express();

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.use("/webhooks", createTrelloWebhookRouter(discordClient));

const server = app.listen(config.port, () => {
  logger.info("http server started", {
    port: config.port,
    trello_webhook_url: `${config.publicBaseUrl}/webhooks/trello`,
  });
});

await discordClient.login(config.discord.token);

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info("shutdown started", { signal });

  server.close((error) => {
    if (error) {
      logger.error("error", {
        action: "http_server_close",
        error: error.message,
      });
    }
  });

  discordClient.destroy();
  closeDatabase();

  logger.info("shutdown complete", { signal });
  process.exit(0);
}

process.on("SIGINT", (signal) => {
  void shutdown(signal);
});

process.on("SIGTERM", (signal) => {
  void shutdown(signal);
});
