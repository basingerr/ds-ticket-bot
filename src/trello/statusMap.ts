export const TRELLO_LIST_TO_STATUS: Record<string, string> = {
  Inbox: "New",
  Accepted: "Accepted",
  "In Progress": "In Progress",
  "Ready for Retest": "Ready for Retest",
  Verified: "Verified",
  "Rejected / Duplicate": "Rejected / Duplicate",
  "Need Info": "Need Info",
};

export const STATUS_TAG_NAMES = [
  "New",
  "Accepted",
  "In Progress",
  "Ready for Retest",
  "Verified",
  "Rejected",
  "Duplicate",
  "Need Info",
];

export function statusFromListName(listName: string): string {
  return TRELLO_LIST_TO_STATUS[listName] ?? listName;
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
