# Agents context: ds-ticket-bot

## What this project is

Small production bridge between Discord Forum tickets and an internal Trello board.

```text
Discord Forum Post = public ticket for testers
Trello Card = internal task for the team
Bot = one-way bridge plus status feedback
```

The project must stay small. Do not turn it into a full ticket system.

## Current production state

Production host:

```text
VDS: your server
OS: Ubuntu 22.04.5 LTS
App path: /opt/ds-ticket-bot
Public URL: https://your-bot-host.example
Health: https://your-bot-host.example/health
Webhook: https://your-bot-host.example/webhooks/trello
Process: systemd service ds-ticket-bot
Reverse proxy: nginx
Database: /opt/ds-ticket-bot/data/tickets.sqlite
Backups: systemd timer `ds-ticket-bot-backup.timer`, files in `/opt/ds-ticket-bot/backups`
Repo: https://github.com/<owner>/ds-ticket-bot
Branch: main
```

Important: only one bot instance should run with the production Discord token. Do not leave local `npm run dev` running while the VDS service is active, or both instances may receive Discord gateway events.

## What works now

- Discord slash command registration works.
- Discord Forum Post in the configured forum channel creates a Trello card.
- SQLite stores `discord_thread_id <-> trello_card_id`.
- Trello card moves are received through the production HTTPS webhook.
- Trello status updates update a single Discord embed status message instead of posting many messages.
- Trello webhook updates are debounced with `TRELLO_STATUS_DEBOUNCE_MS` to avoid spam while a card is dragged through multiple lists.
- `/sync-ticket` works inside a Discord thread and updates the same status embed.
- Bot tries to apply Discord forum tags best-effort.
- Bot searches existing open Trello cards by Discord thread URL before creating a new card, as a duplicate guard.
- New Trello cards created from Discord get a `[QA]` prefix in the card title.
- Discord thread title edits update the Trello card title and add a Trello comment.
- Discord starter message edits update the Trello card description and add a Trello comment.
- New Discord comments from the original ticket author are copied to Trello comments; the starter message is not duplicated because it is the card description.
- Trello card completion checkbox archives or reopens the Discord thread.
- Trello card archive/delete closes the Discord thread as an exceptional/manual-review case.
- Trello list name `Готово` alone does not archive the Discord thread.
- Final/exception states update the single Discord status embed; do not add separate close messages.
- Bot-owned starter message reactions reflect real board statuses: `🕓`, `🔧`, `🔁`, `✅`, fallback `⚠️`.
- Periodic reconciliation job checks SQLite links against Trello and repairs missed Discord status/archive changes.
- `/bot-mode` provides an admin-only emergency `active`/`readonly` switch persisted in SQLite.
- `/bhealth` provides admin-only private diagnostics for Discord, Trello, SQLite, webhook, mode, public URL, and reconciliation.
- `/blogs` provides admin-only private recent in-memory logs from the current bot process; it does not replace journalctl for logs before restart.
- On QA testing statuses, the status embed shows author-only feedback buttons: fixed or needs work. Button actions add Trello comments and post compact alerts to `QA_REPLY_ALERT_CHANNEL_ID`.

## Current Trello card description format

New cards should be human-readable:

```md
## Discord ticket

**Автор:** Display Name (@username, discord_user_id)
**Тема:** Discord thread title
**Ссылка:** Discord thread link

### Описание
Ticket text

### Вложения
- attachment URLs, only when present
```

Current format should not include a visible or hidden technical `Discord thread id` marker. Duplicate detection uses the Discord thread URL in the `Ссылка` field. The old hidden marker is supported only as a backward-compatible fallback for older cards.

Do not add visible technical id dumps unless the user asks. If changing visible formatting, show the proposed example to the user first.

## Runtime files

```text
src/index.ts                 App entry, Express + Discord client
src/reconcile.ts             Periodic Trello/Discord reconciliation job
src/config.ts                Env config
src/discord/handlers.ts      Discord forum post handling
src/discord/commands.ts      /sync-ticket
src/discord/statusMessage.ts Single editable Discord status embed
src/discord/statusReaction.ts Bot-owned starter-message status reactions
src/discord/ticketContent.ts Shared Trello description/starter-message helpers
src/discord/repairTrelloDescriptions.ts Dry-run/apply repair tool for old descriptions
src/discord/threadTags.ts    Best-effort forum tag updates
src/trello/client.ts         Trello REST client and webhook utilities
src/trello/webhook.ts        Trello webhook receiver and debounced status updates
src/trello/statusMap.ts      Trello list name -> public status mapping
src/db/database.ts           SQLite init and migrations
src/db/ticketLinks.ts        ticket_links repository
deploy/                      systemd and nginx examples
DEPLOY.md                    VDS runbook
```

## Env

Required:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_FORUM_CHANNEL_ID=

TRELLO_KEY=
TRELLO_TOKEN=
TRELLO_BOARD_ID=
TRELLO_INBOX_LIST_ID=

PUBLIC_BASE_URL=https://your-bot-host.example
DATABASE_URL=file:./data/tickets.sqlite
PORT=3000
TRELLO_CARD_TITLE_PREFIX=[QA]
TRELLO_LIST_STATUS_MAP_JSON=
DISCORD_STATUS_TAG_NAMES=
TRELLO_STATUS_DEBOUNCE_MS=2500
RECONCILE_INTERVAL_MS=300000
BOT_DEFAULT_MODE=active
BOT_ADMIN_USER_IDS=
BOT_ADMIN_ROLE_IDS=
TESTER_STATS_ROLE_IDS=
WATCHDOG_ALERT_CHANNEL_ID=
WATCHDOG_INTERVAL_MS=300000
WATCHDOG_RECOVERY_COOLDOWN_MS=1800000
READONLY_ALERT_AFTER_MS=1800000
QA_REPLY_ALERT_CHANNEL_ID=
QA_REPLY_ALERT_STATUSES=Ready for Retest,Тестирование / на сервере
```

Set `RECONCILE_INTERVAL_MS=0` to disable the reconciliation job.

Emergency switch: `/bot-mode` can show/set `active` or `readonly`. Access is limited by `BOT_ADMIN_USER_IDS` or `BOT_ADMIN_ROLE_IDS`. In `readonly`, the bot keeps health, `/bot-mode`, and `/bhealth`, but ignores Discord ticket writes, Trello webhook writes, and reconciliation repairs.

`/tester-stats` is limited to members with roles listed in `TESTER_STATS_ROLE_IDS`.

Watchdog runs periodically and posts degraded/recovered health alerts to `WATCHDOG_ALERT_CHANNEL_ID`. The bot must be able to view/send messages in that channel. It should not spam identical failures; it only posts when the failure signature changes or recovers. It alerts if readonly stays enabled longer than `READONLY_ALERT_AFTER_MS`.

QA feedback alerts are posted to `QA_REPLY_ALERT_CHANNEL_ID` for statuses listed in `QA_REPLY_ALERT_STATUSES`.

Never commit `.env`.

## Common production commands

On VDS:

```bash
cd /opt/ds-ticket-bot
git pull
npm ci
npm run build
sudo systemctl restart ds-ticket-bot
sudo journalctl -u ds-ticket-bot -n 80 --no-pager
```

Webhook utilities:

```bash
npm run trello:webhook:prod -- list
npm run trello:webhook:prod -- create
npm run trello:webhook:prod -- delete <webhook_id>
```

SQLite quick check:

```bash
sqlite3 data/tickets.sqlite "select discord_thread_id, trello_card_id, status, discord_status_message_id, created_at from ticket_links order by id desc limit 5;"
```

SQLite backup timer:

```bash
sudo systemctl status ds-ticket-bot-backup.timer
sudo journalctl -u ds-ticket-bot-backup.service -n 50 --no-pager
sudo ls -lh /opt/ds-ticket-bot/backups
sudo systemctl start ds-ticket-bot-backup.service
```

## Things that bit us already

- A local dev bot and the VDS bot running at the same time caused duplicate Trello cards.
- SQLite was initially root-owned on VDS and the service user could not write: `attempt to write a readonly database`.
- Do not back up live SQLite with plain `cp`; use `sqlite3 .backup`, gzip, and integrity check through `ds-ticket-bot-backup.timer`.
- Port `443` was occupied by old `mtproxy.service`, causing nginx to serve the wrong certificate path. MTProxy was removed.
- GitHub private HTTPS clone does not accept account password. Use public repo, token, or deploy key.
- Trello webhook requires a publicly reachable HTTPS URL. ngrok can work for local testing; production should use your stable HTTPS host.

## What not to build without explicit request

- Tester dashboard
- Web UI
- Analytics
- SLA
- Roles and moderation system
- AI classification
- Full two-way comment sync
- Trello links in public Discord by default
- File downloading/proxying
- Auto-parsing tester replies like "ok / not ok"

## Sensible backlog

High value:

- Add bot-owned reactions to the starter post or status message, without deleting user reactions.
- Add reconciliation job every 5-10 minutes to recover from missed webhooks.
- Add explicit Trello list mapping for the real Russian board statuses if the team wants public wording different from Trello list names.

Lower priority:

- `/ticket-info` command.
- Docker packaging, only if the server standardizes on Docker.
- Better structured logs or log rotation.

## Principle

Keep it a reliable bridge:

```text
Discord Forum Post -> Trello Card -> SQLite link -> Trello move webhook -> Discord status embed
```

Avoid features that make it a separate ticketing platform.
