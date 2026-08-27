// Local preview of the Insights pages without the Discord/Trello bot.
// Mounts only createInsightsRouter with throwaway credentials.
//
//   npm run insights:preview
//   -> http://dev:dev@localhost:4599/insights
//
// The map/dealership context is read from the exports/ paths in src/config.ts.
// Generate them first from a rejoin-server checkout:
//   npm run insights:map-context     -- --source=<path> --output=./exports/map-insights/map-context.json
//   npm run insights:vehicle-catalog -- --source=<path> --output=./exports/vehicle-catalog/vehicle-catalog.json
// Map tiles are optional locally; without exports/death-insights/atlas the map
// renders on a blank background but every control still works.

process.env.DISCORD_TOKEN ||= "preview";
process.env.DISCORD_CLIENT_ID ||= "preview";
process.env.DISCORD_GUILD_ID ||= "preview";
process.env.DISCORD_FORUM_CHANNEL_ID ||= "preview";
process.env.TRELLO_KEY ||= "preview";
process.env.TRELLO_TOKEN ||= "preview";
process.env.TRELLO_BOARD_ID ||= "preview";
process.env.TRELLO_INBOX_LIST_ID ||= "preview";
process.env.PUBLIC_BASE_URL ||= "http://localhost:4599";
process.env.PORT ||= "4599";
process.env.INSIGHTS_ENABLED = "true";
process.env.INSIGHTS_USERNAME ||= "dev";
process.env.INSIGHTS_PASSWORD ||= "dev";

const express = (await import("express")).default;
const { createInsightsRouter } = await import("../src/insights/web.js");

const port = Number(process.env.PORT ?? 4599);
const app = express();
app.use("/insights", createInsightsRouter());
app.listen(port, () => {
  const user = process.env.INSIGHTS_USERNAME;
  const pass = process.env.INSIGHTS_PASSWORD;
  console.log(`Insights preview:`);
  for (const page of ["", "/map", "/dealership", "/deaths"]) {
    console.log(`  http://${user}:${pass}@localhost:${port}/insights${page}`);
  }
});
