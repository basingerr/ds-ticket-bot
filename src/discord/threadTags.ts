import { ChannelType, ThreadChannel } from "discord.js";
import { STATUS_TAG_NAMES } from "../trello/statusMap.js";
import { logger } from "../utils/logger.js";

export async function applyStatusTag(thread: ThreadChannel, status: string): Promise<void> {
  try {
    const parent = thread.parent;
    if (!parent || parent.type !== ChannelType.GuildForum) {
      return;
    }

    const statusTagNames = new Set(STATUS_TAG_NAMES);
    const currentTags = thread.appliedTags.filter((tagId) => {
      const tag = parent.availableTags.find((availableTag) => availableTag.id === tagId);
      return tag && !statusTagNames.has(tag.name);
    });

    const tagNames = status === "Rejected / Duplicate" ? ["Rejected"] : [status];
    const newTag = parent.availableTags.find((tag) => tagNames.includes(tag.name));

    if (!newTag) {
      return;
    }

    await thread.setAppliedTags([...currentTags, newTag.id]);
  } catch (error) {
    logger.warn("forum tag update failed", {
      discord_thread_id: thread.id,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
