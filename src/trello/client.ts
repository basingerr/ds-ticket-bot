import { config } from "../config.js";

type TrelloCardResponse = {
  id: string;
  name: string;
  desc?: string;
  idList: string;
  closed?: boolean;
  dueComplete?: boolean;
  shortUrl?: string;
  url?: string;
};

type TrelloListResponse = {
  id: string;
  name: string;
};

type TrelloWebhookResponse = {
  id: string;
  callbackURL: string;
  idModel: string;
  description?: string;
  active: boolean;
  consecutiveFailures?: number;
};

type TrelloBoardResponse = {
  id: string;
  name: string;
  url?: string;
  closed?: boolean;
};

export type CreatedTrelloCard = {
  id: string;
  url: string | null;
};

export type TrelloCardWithList = {
  id: string;
  idList: string;
  listName: string;
  closed: boolean;
  dueComplete: boolean;
};

export type TrelloCard = {
  id: string;
  name: string;
  desc: string;
  url: string | null;
};

export type TrelloWebhook = {
  id: string;
  callbackUrl: string;
  modelId: string;
  description: string | null;
  active: boolean;
  consecutiveFailures: number | null;
};

export type TrelloBoard = {
  id: string;
  name: string;
  url: string | null;
  closed: boolean;
};

type TrelloBoardCardResponse = {
  id: string;
  name: string;
  desc?: string;
  shortUrl?: string;
  url?: string;
};

function trelloUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(`https://api.trello.com/1${path}`);
  url.searchParams.set("key", config.trello.key);
  url.searchParams.set("token", config.trello.token);

  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

async function trelloRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Trello API error ${response.status}: ${body}`);
  }

  return (await response.json()) as T;
}

function hasDiscordTicketLink(desc: string | undefined, discordThreadId: string): boolean {
  if (!desc) {
    return false;
  }

  const threadLink = `https://discord.com/channels/${config.discord.guildId}/${discordThreadId}`;
  const ticketLinkPattern = new RegExp(String.raw`\*\*Ссылка:\*\*\s*${threadLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\s|$)`);
  const legacyMarker = `Discord thread id: ${discordThreadId}`;

  return ticketLinkPattern.test(desc) || desc.includes(legacyMarker);
}

export async function createTrelloCard(input: {
  name: string;
  desc: string;
}): Promise<CreatedTrelloCard> {
  const body = new URLSearchParams({
    idList: config.trello.inboxListId,
    name: input.name,
    desc: input.desc,
  });

  const card = await trelloRequest<TrelloCardResponse>(trelloUrl("/cards"), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  return {
    id: card.id,
    url: card.url ?? card.shortUrl ?? null,
  };
}

export async function updateTrelloCard(input: {
  cardId: string;
  name?: string;
  desc?: string;
}): Promise<void> {
  const body = new URLSearchParams();

  if (input.name !== undefined) {
    body.set("name", input.name);
  }

  if (input.desc !== undefined) {
    body.set("desc", input.desc);
  }

  if ([...body.keys()].length === 0) {
    return;
  }

  await trelloRequest<TrelloCardResponse>(trelloUrl(`/cards/${encodeURIComponent(input.cardId)}`), {
    method: "PUT",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

export async function moveTrelloCardToList(cardId: string, listId: string): Promise<void> {
  const body = new URLSearchParams({ idList: listId });

  await trelloRequest<TrelloCardResponse>(trelloUrl(`/cards/${encodeURIComponent(cardId)}`), {
    method: "PUT",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

export async function addTrelloCardComment(cardId: string, text: string): Promise<void> {
  const body = new URLSearchParams({ text });

  await trelloRequest<{ id: string }>(trelloUrl(`/cards/${encodeURIComponent(cardId)}/actions/comments`), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

export async function findTrelloCardByDiscordThreadId(discordThreadId: string): Promise<CreatedTrelloCard | null> {
  const cards = await trelloRequest<TrelloBoardCardResponse[]>(
    trelloUrl(`/boards/${encodeURIComponent(config.trello.boardId)}/cards`, {
      fields: "id,name,desc,url,shortUrl",
      filter: "open",
    }),
  );

  const card = cards.find((candidate) => hasDiscordTicketLink(candidate.desc, discordThreadId));

  if (!card) {
    return null;
  }

  return {
    id: card.id,
    url: card.url ?? card.shortUrl ?? null,
  };
}

export async function getTrelloCard(cardId: string): Promise<TrelloCard> {
  const card = await trelloRequest<TrelloCardResponse>(
    trelloUrl(`/cards/${encodeURIComponent(cardId)}`, { fields: "id,name,desc,url,shortUrl" }),
  );

  return {
    id: card.id,
    name: card.name,
    desc: card.desc ?? "",
    url: card.url ?? card.shortUrl ?? null,
  };
}

export async function getTrelloCardWithList(cardId: string): Promise<TrelloCardWithList> {
  const card = await trelloRequest<TrelloCardResponse>(
    trelloUrl(`/cards/${encodeURIComponent(cardId)}`, { fields: "id,idList,name,closed,dueComplete" }),
  );
  const list = await trelloRequest<TrelloListResponse>(
    trelloUrl(`/lists/${encodeURIComponent(card.idList)}`, { fields: "id,name" }),
  );

  return {
    id: card.id,
    idList: card.idList,
    listName: list.name,
    closed: card.closed ?? false,
    dueComplete: card.dueComplete ?? false,
  };
}

export async function getTrelloBoard(): Promise<TrelloBoard> {
  const board = await trelloRequest<TrelloBoardResponse>(
    trelloUrl(`/boards/${encodeURIComponent(config.trello.boardId)}`, { fields: "id,name,url,closed" }),
  );

  return {
    id: board.id,
    name: board.name,
    url: board.url ?? null,
    closed: board.closed ?? false,
  };
}

function mapWebhook(webhook: TrelloWebhookResponse): TrelloWebhook {
  return {
    id: webhook.id,
    callbackUrl: webhook.callbackURL,
    modelId: webhook.idModel,
    description: webhook.description ?? null,
    active: webhook.active,
    consecutiveFailures: webhook.consecutiveFailures ?? null,
  };
}

export async function listTrelloWebhooks(): Promise<TrelloWebhook[]> {
  const webhooks = await trelloRequest<TrelloWebhookResponse[]>(
    trelloUrl(`/tokens/${encodeURIComponent(config.trello.token)}/webhooks`),
  );

  return webhooks.map(mapWebhook);
}

export async function createBoardWebhook(): Promise<TrelloWebhook> {
  const body = new URLSearchParams({
    callbackURL: `${config.publicBaseUrl}/webhooks/trello`,
    idModel: config.trello.boardId,
    description: "Discord Forum to Trello sync bot",
    active: "true",
  });

  const webhook = await trelloRequest<TrelloWebhookResponse>(trelloUrl("/webhooks"), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  return mapWebhook(webhook);
}

export async function deleteTrelloWebhook(webhookId: string): Promise<void> {
  await fetch(trelloUrl(`/webhooks/${encodeURIComponent(webhookId)}`), {
    method: "DELETE",
  }).then(async (response) => {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Trello API error ${response.status}: ${body}`);
    }
  });
}
