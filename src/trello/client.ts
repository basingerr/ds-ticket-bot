import { config } from "../config.js";

type TrelloCardResponse = {
  id: string;
  name: string;
  desc?: string;
  idList: string;
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

export type CreatedTrelloCard = {
  id: string;
  url: string | null;
};

export type TrelloCardWithList = {
  id: string;
  idList: string;
  listName: string;
};

export type TrelloWebhook = {
  id: string;
  callbackUrl: string;
  modelId: string;
  description: string | null;
  active: boolean;
  consecutiveFailures: number | null;
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

export async function findTrelloCardByDiscordThreadId(discordThreadId: string): Promise<CreatedTrelloCard | null> {
  const cards = await trelloRequest<TrelloBoardCardResponse[]>(
    trelloUrl(`/boards/${encodeURIComponent(config.trello.boardId)}/cards`, {
      fields: "id,name,desc,url,shortUrl",
      filter: "open",
    }),
  );

  const marker = `Discord thread id: ${discordThreadId}`;
  const card = cards.find((candidate) => candidate.desc?.includes(marker));

  if (!card) {
    return null;
  }

  return {
    id: card.id,
    url: card.url ?? card.shortUrl ?? null,
  };
}

export async function getTrelloCardWithList(cardId: string): Promise<TrelloCardWithList> {
  const card = await trelloRequest<TrelloCardResponse>(
    trelloUrl(`/cards/${encodeURIComponent(cardId)}`, { fields: "id,idList,name" }),
  );
  const list = await trelloRequest<TrelloListResponse>(
    trelloUrl(`/lists/${encodeURIComponent(card.idList)}`, { fields: "id,name" }),
  );

  return {
    id: card.id,
    idList: card.idList,
    listName: list.name,
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
