import {
  createBoardWebhook,
  deleteTrelloWebhook,
  listTrelloWebhooks,
  type TrelloWebhook,
} from "./client.js";

function printWebhook(webhook: TrelloWebhook): void {
  console.log(
    JSON.stringify(
      {
        id: webhook.id,
        callbackUrl: webhook.callbackUrl,
        modelId: webhook.modelId,
        description: webhook.description,
        active: webhook.active,
        consecutiveFailures: webhook.consecutiveFailures,
      },
      null,
      2,
    ),
  );
}

const command = process.argv[2] ?? "list";

if (command === "list") {
  const webhooks = await listTrelloWebhooks();

  if (webhooks.length === 0) {
    console.log("No Trello webhooks found for this token.");
  } else {
    for (const webhook of webhooks) {
      printWebhook(webhook);
    }
  }
} else if (command === "create") {
  const webhook = await createBoardWebhook();
  printWebhook(webhook);
} else if (command === "delete") {
  const webhookId = process.argv[3];

  if (!webhookId) {
    throw new Error("Usage: npm run trello:webhook -- delete <webhook_id>");
  }

  await deleteTrelloWebhook(webhookId);
  console.log(`Deleted Trello webhook ${webhookId}.`);
} else {
  throw new Error("Usage: npm run trello:webhook -- <list|create|delete>");
}
