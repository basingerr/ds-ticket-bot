import { config } from "../config.js";

export const TRELLO_LIST_TO_STATUS: Record<string, string> = config.trelloListStatusMap;

export const TRELLO_LIST_ID_TO_STATUS: Record<string, string> = config.trelloListStatusMapById;

export const STATUS_TAG_NAMES = config.discordStatusTagNames;

export function statusFromListName(listName: string): string {
  return TRELLO_LIST_TO_STATUS[listName] ?? listName;
}

export function statusFromTrelloList(listId: string, listName: string): string {
  return TRELLO_LIST_ID_TO_STATUS[listId] ?? statusFromListName(listName);
}

export function discordMessageForStatus(status: string): string {
  if (status === "Ready for Retest") {
    return [
      "Статус изменен: Ready for Retest.",
      "",
      "Фикс готов к перепроверке. Проверьте заново и отпишите результат в этой теме:",
      "- ок",
      "- не исправлено",
      "- проблема изменилась",
    ].join("\n");
  }

  if (status === "Need Info") {
    return [
      "Статус изменен: Need Info.",
      "",
      "Нужна дополнительная информация. Опишите детали в этой теме.",
    ].join("\n");
  }

  return `Статус изменен: ${status}.`;
}
