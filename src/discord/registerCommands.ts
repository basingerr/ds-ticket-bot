import { REST, Routes } from "discord.js";
import { config } from "../config.js";
import { syncTicketCommand } from "./commands.js";

const rest = new REST({ version: "10" }).setToken(config.discord.token);

await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
  body: [syncTicketCommand.toJSON()],
});

console.log("Registered Discord slash commands.");
