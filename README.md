# Discord Forum to Trello sync bot

Small bridge bot:

- Discord Forum Post creates a Trello card.
- Trello card list move updates a single Discord status embed in the thread.
- SQLite stores `discordThreadId <-> trelloCardId`.
- `/sync-ticket` manually reconciles status from Trello.
- Trello webhook updates are debounced to avoid status spam during rapid card moves.
- Discord title/description edits update the linked Trello card.
- Trello completion checkbox archives or reopens the Discord thread.
- Trello card archive/delete closes the Discord thread as an exceptional/manual-review case.
- Moving a card to `Готово` only changes status; it does not archive the Discord thread by itself.
- Trello descriptions can be repaired from Discord with a dry-run tool.
- Bot-owned starter message reactions reflect the current ticket status.
- A periodic reconciliation job repairs missed Trello/Discord status changes.

Production:

```text
https://tickets.basinger.cc
```

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
TRELLO_STATUS_DEBOUNCE_MS=2500
RECONCILE_INTERVAL_MS=300000
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

Repair Trello descriptions from saved Discord ticket links:

```bash
npm run repair:descriptions
npm run repair:descriptions -- --apply
npm run repair:descriptions -- --all --apply
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

## Production update

On the VDS:

```bash
cd /opt/ds-ticket-bot
git pull
npm ci
npm run build
sudo systemctl restart ds-ticket-bot
sudo journalctl -u ds-ticket-bot -n 80 --no-pager
```

Repair descriptions on production:

```bash
cd /opt/ds-ticket-bot
npm run repair:descriptions:prod
npm run repair:descriptions:prod -- --apply
```

Do not run a local `npm run dev` with the same Discord token while production is active. Two live bot instances can both receive `threadCreate` events.

## Useful production commands

Run on the VDS from `/opt/ds-ticket-bot`.

```bash
# Update bot from Git and restart
git pull
npm ci
npm run build
sudo systemctl restart ds-ticket-bot

# Logs
sudo journalctl -u ds-ticket-bot -n 80 --no-pager
sudo journalctl -u ds-ticket-bot -f

# Repair old Trello descriptions from Discord
npm run repair:descriptions:prod
npm run repair:descriptions:prod -- --apply
npm run repair:descriptions:prod -- --all --apply

# Trello webhooks
npm run trello:webhook:prod -- list
npm run trello:webhook:prod -- create
npm run trello:webhook:prod -- delete <webhook_id>
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
