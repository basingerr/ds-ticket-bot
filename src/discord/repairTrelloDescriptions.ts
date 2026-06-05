import { ChannelType } from "discord.js";
import { initDatabase } from "../db/database.js";
import { listTicketLinks } from "../db/ticketLinks.js";
import { createDiscordClient } from "./client.js";
import { buildTrelloDescription, fetchStarterMessage } from "./ticketContent.js";
import { getTrelloCard, updateTrelloCard } from "../trello/client.js";
import { config } from "../config.js";

const apply = process.argv.includes("--apply");
const updateAll = process.argv.includes("--all");

function shouldRepairDescription(desc: string): boolean {
  return (
    updateAll ||
    desc.trim() === "" ||
    desc.includes("not_available") ||
    desc.includes("Discord thread id:") ||
    !desc.includes("## Discord ticket")
  );
}

initDatabase();

const client = createDiscordClient();
await client.login(config.discord.token);

try {
  const links = listTicketLinks();
  let checked = 0;
  let planned = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const link of links) {
    checked += 1;

    try {
      const trelloCard = await getTrelloCard(link.trelloCardId);
      if (!shouldRepairDescription(trelloCard.desc)) {
        skipped += 1;
        continue;
      }

      const channel = await client.channels.fetch(link.discordThreadId);
      if (!channel || !channel.isThread()) {
        throw new Error("Discord thread not found");
      }

      if (channel.parentId !== config.discord.forumChannelId || channel.type !== ChannelType.PublicThread) {
        skipped += 1;
        continue;
      }

      const starterMessage = await fetchStarterMessage(channel);
      const authorId = starterMessage?.author.id ?? channel.ownerId ?? link.discordAuthorId;
      const desc = await buildTrelloDescription({
        authorId,
        thread: channel,
        starterMessage,
      });

      planned += 1;
      console.log(`${apply ? "UPDATE" : "DRY-RUN"} ${link.discordThreadId} -> ${link.trelloCardId} ${trelloCard.name}`);

      if (apply) {
        await updateTrelloCard({
          cardId: link.trelloCardId,
          desc,
        });
        updated += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(
        `FAILED ${link.discordThreadId} -> ${link.trelloCardId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        checked,
        planned,
        updated,
        skipped,
        failed,
      },
      null,
      2,
    ),
  );
} finally {
  client.destroy();
}
