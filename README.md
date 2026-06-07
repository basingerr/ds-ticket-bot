# Discord Forum to Trello sync bot

Small bridge bot:

- Discord Forum Post creates a Trello card.
- Trello card list move updates a single Discord status embed in the thread.
- SQLite stores `discordThreadId <-> trelloCardId`.
- `/sync-ticket` manually reconciles status from Trello.
- `/tester-stats` shows the most active Discord forum thread authors.
- Trello webhook updates are debounced to avoid status spam during rapid card moves.
- Discord title/description edits update the linked Trello card.
- New Discord comments from the original ticket author are copied to Trello comments.
- Trello completion checkbox archives or reopens the Discord thread.
- Trello card archive/delete closes the Discord thread as an exceptional/manual-review case.
- Moving a card to `Готово` only changes status; it does not archive the Discord thread by itself.
- Final/exception states update the same Discord status embed instead of posting separate close messages.
- Trello descriptions can be repaired from Discord with a dry-run tool.
- Bot-owned starter message reactions reflect the current ticket status.
- A periodic reconciliation job repairs missed Trello/Discord status changes.
- On QA testing statuses, the status embed shows QA feedback buttons: fixed or needs work.
- Old Discord Forum threads can be backfilled into Trello with a dry-run tool.

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
BOT_DEFAULT_MODE=active
BOT_ADMIN_USER_IDS=
BOT_ADMIN_ROLE_IDS=
TESTER_STATS_ROLE_IDS=1253347054000803922,1443903847046053949,1509621366054326352
WATCHDOG_ALERT_CHANNEL_ID=1374256075414442064
WATCHDOG_INTERVAL_MS=300000
WATCHDOG_RECOVERY_COOLDOWN_MS=1800000
READONLY_ALERT_AFTER_MS=1800000
QA_REPLY_ALERT_CHANNEL_ID=1374256075414442064
QA_REPLY_ALERT_STATUSES=Тестирование / на сервере
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

Backfill old Discord Forum threads into Trello and SQLite:

```bash
npm run backfill:tickets
npm run backfill:tickets -- --apply
npm run backfill:tickets -- --active-only --max=200
npm run backfill:tickets -- --active-only --without-check
npm run backfill:tickets -- --active-only --without-check --exclude=1510934252022403172
npm run backfill:tickets -- --active-only --without-check --exclude=1510934252022403172 --update-discord --apply
```

Discord commands:

```text
/sync-ticket
/tester-stats limit:10 max_threads:500 archived:true
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

Backfill old Discord Forum threads on production:

```bash
cd /opt/ds-ticket-bot
npm run backfill:tickets:prod
npm run backfill:tickets:prod -- --apply
npm run backfill:tickets:prod -- --active-only --without-check
npm run backfill:tickets:prod -- --active-only --without-check --exclude=1510934252022403172
npm run backfill:tickets:prod -- --active-only --without-check --exclude=1510934252022403172 --update-discord --apply
```

Emergency readonly switch:

```text
/bot-mode
/bot-mode mode:readonly
/bot-mode mode:active
/bhealth
/blogs
```

Only users listed in `BOT_ADMIN_USER_IDS` or members with roles listed in `BOT_ADMIN_ROLE_IDS` can use it.
In `readonly` mode the bot keeps `/health` and `/bot-mode`, but ignores Discord ticket writes, Trello webhook writes, and reconciliation repairs.
`/bhealth` uses the same admin access and privately checks Discord, Trello, SQLite, webhook, mode, public URL, and reconciliation.
`/blogs` uses the same admin access and privately shows recent in-memory logs from the current bot process.
`/tester-stats` is limited to members with roles listed in `TESTER_STATS_ROLE_IDS`.
Watchdog runs periodically and posts degraded/recovered health alerts to `WATCHDOG_ALERT_CHANNEL_ID`. It also alerts if readonly stays enabled longer than `READONLY_ALERT_AFTER_MS`.
QA feedback alerts are posted to `QA_REPLY_ALERT_CHANNEL_ID` for statuses listed in `QA_REPLY_ALERT_STATUSES`.

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

# Backfill old Discord forum tickets into Trello
npm run backfill:tickets:prod
npm run backfill:tickets:prod -- --apply
npm run backfill:tickets:prod -- --active-only --without-check
npm run backfill:tickets:prod -- --active-only --without-check --exclude=1510934252022403172
npm run backfill:tickets:prod -- --active-only --without-check --exclude=1510934252022403172 --update-discord --apply

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
