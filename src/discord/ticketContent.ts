import { Message, ThreadChannel } from "discord.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

function valueOrNotAvailable(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "not_available";
}

function discordThreadLink(threadId: string): string {
  return `https://discord.com/channels/${config.discord.guildId}/${threadId}`;
}

export function trelloCardNameFromThreadName(threadName: string): string {
  const prefix = config.trelloCardTitlePrefix.trim();
  if (!prefix) {
    return threadName;
  }

  const prefixWithSpace = prefix.endsWith(" ") ? prefix : `${prefix} `;
  return threadName.startsWith(prefixWithSpace) ? threadName : `${prefixWithSpace}${threadName}`;
}

function attachmentLinks(message: Message | null): string {
  if (!message || message.attachments.size === 0) {
    return "";
  }

  return message.attachments.map((attachment) => `- ${attachment.url}`).join("\n");
}

function formatMessageAuthor(message: Message): string {
  const displayName = message.member?.displayName ?? message.author.globalName ?? message.author.username;
  const username = message.author.discriminator === "0"
    ? `@${message.author.username}`
    : `${message.author.username}#${message.author.discriminator}`;

  return `${displayName} (${username}, ${message.author.id})`;
}

async function formatAuthor(input: {
  thread: ThreadChannel;
  message: Message | null;
  fallbackAuthorId: string | null;
}): Promise<string> {
  const { thread, message, fallbackAuthorId } = input;

  if (!message) {
    if (!fallbackAuthorId) {
      return "not_available";
    }

    try {
      const member = await thread.guild.members.fetch(fallbackAuthorId);
      const username = member.user.discriminator === "0"
        ? `@${member.user.username}`
        : `${member.user.username}#${member.user.discriminator}`;

      return `${member.displayName} (${username}, ${member.id})`;
    } catch {
      try {
        const user = await thread.client.users.fetch(fallbackAuthorId);
        const username = user.discriminator === "0"
          ? `@${user.username}`
          : `${user.username}#${user.discriminator}`;

        return `${user.globalName ?? user.username} (${username}, ${user.id})`;
      } catch {
        return fallbackAuthorId;
      }
    }
  }

  return formatMessageAuthor(message);
}

export async function buildTrelloDescription(input: {
  authorId: string | null;
  thread: ThreadChannel;
  starterMessage: Message | null;
}): Promise<string> {
  const attachments = attachmentLinks(input.starterMessage);
  const lines = [
    "## Discord ticket",
    "",
    `**Автор:** ${await formatAuthor({
      thread: input.thread,
      message: input.starterMessage,
      fallbackAuthorId: input.authorId,
    })}`,
    `**Тема:** ${input.thread.name}`,
    `**Ссылка:** ${discordThreadLink(input.thread.id)}`,
    "",
    "### Описание",
    valueOrNotAvailable(input.starterMessage?.content),
  ];

  if (attachments) {
    lines.push("", "### Вложения", attachments);
  }

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchFirstUserMessage(thread: ThreadChannel): Promise<Message | null> {
  try {
    const messages = await thread.messages.fetch({ limit: 10 });
    return messages
      .filter((message) => !message.author.bot)
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .first() ?? null;
  } catch (error) {
    logger.warn("thread messages unavailable", {
      discord_thread_id: thread.id,
      action: "fetch_first_user_message",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function fetchStarterMessage(thread: ThreadChannel, options?: { attempts?: number }): Promise<Message | null> {
  const attempts = options?.attempts ?? 6;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const starterMessage = await thread.fetchStarterMessage();
      if (starterMessage?.content || starterMessage?.attachments.size) {
        return starterMessage;
      }

      const fallbackMessage = await fetchFirstUserMessage(thread);
      if (fallbackMessage?.content || fallbackMessage?.attachments.size) {
        return fallbackMessage;
      }
    } catch (error) {
      if (attempt === attempts) {
        logger.warn("starter message unavailable", {
          discord_thread_id: thread.id,
          action: "fetch_starter_message",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (attempt < attempts) {
      await sleep(1000);
    }
  }

  return null;
}
