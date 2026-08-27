# Discord Forum to Trello sync bot

Small bridge bot:

- Discord Forum Post creates a Trello card.
- Trello card list move updates a single Discord status embed in the thread.
- SQLite stores `discordThreadId <-> trelloCardId`.
- `/sync-ticket` manually reconciles status from Trello.
- `/tester-stats` shows the most active Discord forum thread authors.
- Trello webhook updates are debounced to avoid status spam during rapid card moves.
- Discord title/description edits update the linked Trello card.
- New meaningful Discord comments from any human participant are copied to Trello comments.
- Deleting or clearing a Discord message never removes already copied Trello context; the bot adds a short audit note instead.
- Trello completion checkbox archives or reopens the Discord thread.
- Trello card archive/delete closes the Discord thread as an exceptional/manual-review case.
- A thread archived manually by a human can archive its Trello card; automatic Discord archival does not. This needs the Discord permission `View Audit Log` for `ReBridge` and is inactive until that permission is granted.
- If a Discord thread was deleted, Trello is not changed automatically. The link is preserved for audit, repeated reconciliation is disabled, and an active card produces one internal alert.
- Moving a card to a final list only changes status; it does not archive the Discord thread by itself.
- Final/exception states update the same Discord status embed instead of posting separate close messages.
- Trello descriptions can be repaired from Discord with a dry-run tool.
- Bot-owned starter message reactions reflect the current ticket status.
- A periodic reconciliation job repairs missed Trello/Discord status changes.
- On QA testing statuses, the status embed shows QA feedback buttons: fixed or needs work.
- Old Discord Forum threads can be backfilled into Trello with a dry-run tool.

The bot is intentionally scoped to one Discord guild, one Discord forum channel, and one Trello board.

## Prerequisites

- A Discord application with a bot token.
- The bot invited to one guild with access to the target Forum channel.
- Discord gateway intents for guilds, messages, message content, and reactions enabled as needed by your Discord application setup.
- `View Audit Log` for the bot role if manual Discord-thread archival should archive the linked Trello card. Do not use Discord auto-archive as a ticket-completion signal.
- A Trello API key/token, board ID, and inbox list ID.
- A public HTTPS URL for Trello webhooks in production.

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
TRELLO_CARD_TITLE_PREFIX=[QA]
TRELLO_LIST_STATUS_MAP_BY_ID_JSON=
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
QA_REPLY_ALERT_STATUSES=Ready for Retest,Тестирование / на сервере,На проверке
```

For local Trello webhook testing, `PUBLIC_BASE_URL` must be a public HTTPS URL that forwards to the local bot, for example an ngrok or cloudflared tunnel.

Optional board-specific configuration:

```env
TRELLO_CARD_TITLE_PREFIX=[QA]
TRELLO_LIST_STATUS_MAP_BY_ID_JSON={"trello_list_id_1":"New","trello_list_id_2":"In Progress","trello_list_id_3":"Verified"}
TRELLO_LIST_STATUS_MAP_JSON={"Inbox":"New","In Progress":"In Progress","Done":"Verified"}
DISCORD_STATUS_TAG_NAMES=New,In Progress,Verified
```

Prefer `TRELLO_LIST_STATUS_MAP_BY_ID_JSON` for production boards, because Trello list names can be renamed without changing their IDs. `TRELLO_LIST_STATUS_MAP_JSON` is kept as a name-based fallback.

Leave `WATCHDOG_ALERT_CHANNEL_ID`, `QA_REPLY_ALERT_CHANNEL_ID`, or `TESTER_STATS_ROLE_IDS` empty to disable those server-specific integrations.

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
npm run backfill:tickets -- --active-only --without-check --exclude=<discord_thread_id>
npm run backfill:tickets -- --active-only --without-check --exclude=<discord_thread_id> --update-discord --apply
```

Discord commands:

```text
/sync-ticket
/tester-stats limit:10 max_threads:500 archived:true
```

Developer ticket review (read-only, no AI API required):

```bash
npm run insights:export
```

The command creates an immutable JSON snapshot under `exports/ticket-review/`. Ask Codex to "Сделай полный обзор тикетов" or "Что изменилось с прошлого анализа?"; the review rules and report format are documented in [`TICKET_REVIEW.md`](./TICKET_REVIEW.md). The exporter only reads Trello and SQLite and never changes Trello or Discord.

Private developer summary page:

```env
INSIGHTS_ENABLED=true
INSIGHTS_USERNAME=team
INSIGHTS_PASSWORD=use-a-long-random-password
INSIGHTS_REPORT_PATH=./exports/ticket-review/published.json
```

The page is served at `GET /insights` with HTTP Basic authentication. It reads the report file on every request, so publishing a new report does not require restarting the bot. Set `INSIGHTS_ENABLED=false` and restart the service to disable the route completely; it then returns `404`. If credentials are missing, the route also fails closed with `404`.

`published.json` is server-only internal data and must remain inside the ignored `exports/` directory. See [`TICKET_REVIEW.md`](./TICKET_REVIEW.md) for its publishing workflow.

Private death heatmap:

```text
GET /insights/deaths
```

The heatmap uses the same HTTP Basic authentication as `/insights`. It reads the current server-only ClickHouse result file from `INSIGHTS_DEATHS_DATA_PATH`, HD GTA map tiles from `INSIGHTS_DEATHS_TILES_PATH`, and sanitized public map context from `INSIGHTS_DEATHS_CONTEXT_PATH`. The response strips `player_id` and `killer_id`; the browser only receives cause, coordinates, timestamp, and a `killed_by_player` flag. Optional map layers show public POIs, ATMs, safe/police zones, deaths near POIs, and timeline playback. Known POIs use the original Rejoin GPS SVG icons at close zoom; the context also preserves GTA blip sprite/color IDs for future atlas coverage. Criminal and organization locations are excluded by the context generator. Replace the source files manually when a new slice is needed; no bot restart is required.

Generate `map-context.json` from a local checkout of `rejoin-server`:

```bash
npm run insights:deaths-context -- --source=/path/to/rejoin-server --output=./exports/death-insights/map-context.json
```

Content map:

```text
GET /insights/map
```

Same HTTP Basic authentication as `/insights`. Shows player-facing content (jobs,
services, vehicle shops, housing, activities, factions, public transport) on the HD
GTA map, with category filters, search, a synced list, safe/police zone layers, and
`?cat=`/`?poi=` deep links. It reuses the death-map atlas tiles
(`INSIGHTS_MAP_TILES_PATH`, defaults to the death atlas dir) and reads a sanitized
`schemaVersion: 2` context from `INSIGHTS_MAP_CONTEXT_PATH`. Criminal and
organization locations are excluded by the generator. Regenerate the context from a
local `rejoin-server` checkout:

```bash
npm run insights:map-context -- --source=/path/to/rejoin-server --output=./exports/map-insights/map-context.json
```

Vehicle dealership catalog:

```text
GET /insights/dealership
```

Same HTTP Basic authentication. Card grid with vehicle preview images, class / seats
/ top speed + handling stat bars, click-to-copy spawn model, salon pills, search,
sort, custom/vanilla and dev-filter chips, a per-model modal (all salons + prices,
full stats), and a collapsible dev-analytics panel (placeholder-handling customs,
multi-salon models, price/speed extremes per class, class summary, missing data).
Deep links `?salon/q/sort/origin/class/flags` and `#shop-<id>` anchors — the content
map's salon markers link here. Reads a sanitized `schemaVersion: 1` file from
`INSIGHTS_VEHICLE_CATALOG_PATH`. Regenerate from a local `rejoin-server` checkout,
then fetch the vanilla preview images (custom `rejoin_*` models have no upstream art
and fall back to a placeholder):

```bash
npm run insights:vehicle-catalog -- --source=/path/to/rejoin-server --output=./exports/vehicle-catalog/vehicle-catalog.json
npm run insights:vehicle-images
```

Images are downloaded once from docs.fivem.net into `INSIGHTS_VEHICLE_IMG_PATH` and
served from there, so the strict Insights CSP is unchanged.

Design plan and roadmap: [`docs/insights-content-map-plan.md`](./docs/insights-content-map-plan.md).

Project command mode is documented in [`THE_MANAGER.md`](./THE_MANAGER.md). “The Manager” combines current evidence, accumulated semantic memory, and owner decision principles to answer what matters and what the team should do next on any day. Its working ledger and briefs stay in ignored `reports/the-manager/`; it does not replace Trello or add an automated management service.

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
sudo systemctl start ds-ticket-bot-backup.service
git pull --ff-only origin main
npm ci
npm run build
sudo systemctl restart ds-ticket-bot
sudo journalctl -u ds-ticket-bot -n 80 --no-pager
curl -fsS https://tickets.basinger.cc/health
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
npm run backfill:tickets:prod -- --active-only --without-check --exclude=<discord_thread_id>
npm run backfill:tickets:prod -- --active-only --without-check --exclude=<discord_thread_id> --update-discord --apply
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
npm run backfill:tickets:prod -- --active-only --without-check --exclude=<discord_thread_id>
npm run backfill:tickets:prod -- --active-only --without-check --exclude=<discord_thread_id> --update-discord --apply

# Trello webhooks
npm run trello:webhook:prod -- list
npm run trello:webhook:prod -- create
npm run trello:webhook:prod -- delete <webhook_id>

# SQLite backups
sudo systemctl status ds-ticket-bot-backup.timer
sudo journalctl -u ds-ticket-bot-backup.service -n 50 --no-pager
sudo ls -lh /opt/ds-ticket-bot/backups
sudo systemctl start ds-ticket-bot-backup.service
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
