# Discord Forum to Trello sync bot

Small bridge bot:

- Discord Forum Post creates a Trello card.
- Trello card list move posts a status update back into the Discord thread.
- SQLite stores `discordThreadId <-> trelloCardId`.

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and fill values:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_FORUM_CHANNEL_ID=

TRELLO_KEY=
TRELLO_TOKEN=
TRELLO_BOARD_ID=
TRELLO_INBOX_LIST_ID=

PUBLIC_BASE_URL=
DATABASE_URL=file:./data/tickets.sqlite
PORT=3000
```

For local Trello webhook testing, `PUBLIC_BASE_URL` must be a public HTTPS URL that forwards to the local bot, for example an ngrok or cloudflared tunnel.

3. Register the Discord slash command:

```bash
npm run register-commands
```

4. Run the bot:

```bash
npm run dev
```

Manage Trello webhooks:

```bash
npm run trello:webhook -- list
npm run trello:webhook -- create
npm run trello:webhook -- delete <webhook_id>
```

Health endpoint:

```text
GET /health
```

Trello webhook endpoint:

```text
HEAD /webhooks/trello
POST /webhooks/trello
```

## Deployment note

Discord events can work locally if the bot is online and has the right gateway intents.

Trello webhooks require a public HTTPS callback URL. For real usage, deploy the bot to a host with stable HTTPS and set:

```env
PUBLIC_BASE_URL=https://your-bot-host.example
```

Then create a Trello webhook for the board with callback:

```text
https://your-bot-host.example/webhooks/trello
```

See [DEPLOY.md](./DEPLOY.md) for VDS deployment with nginx, HTTPS, and systemd.
