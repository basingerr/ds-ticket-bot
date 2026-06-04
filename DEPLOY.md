# VDS deployment

This guide assumes Ubuntu/Debian, Node.js 22 LTS, nginx, and systemd.

## 1. Server basics

Create an app user:

```bash
sudo useradd --system --create-home --home-dir /opt/ds-ticket-bot --shell /usr/sbin/nologin ds-ticket-bot
```

Install packages:

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx build-essential
```

Install Node.js 22 using your preferred method. Verify:

```bash
node -v
npm -v
```

## 2. Upload project

Put the project in:

```text
/opt/ds-ticket-bot
```

For example, clone a private repo there or upload the project files. Then:

```bash
cd /opt/ds-ticket-bot
sudo chown -R ds-ticket-bot:ds-ticket-bot /opt/ds-ticket-bot
```

## 3. Configure env

Create:

```bash
sudo cp .env.production.example .env
sudo nano .env
```

Set:

```env
PUBLIC_BASE_URL=https://tickets.basinger.cc
DATABASE_URL=file:./data/tickets.sqlite
PORT=3000
```

Keep `.env` private.

## 4. Build

```bash
sudo -u ds-ticket-bot npm ci
sudo -u ds-ticket-bot npm run build
sudo -u ds-ticket-bot mkdir -p data
```

Register Discord command:

```bash
sudo -u ds-ticket-bot npm run register-commands:prod
```

## 5. nginx and HTTPS

Copy nginx config:

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/ds-ticket-bot
sudo nano /etc/nginx/sites-available/ds-ticket-bot
sudo ln -s /etc/nginx/sites-available/ds-ticket-bot /etc/nginx/sites-enabled/ds-ticket-bot
sudo nginx -t
sudo systemctl reload nginx
```

Issue TLS cert:

```bash
sudo certbot --nginx -d tickets.basinger.cc
```

Check:

```bash
curl https://tickets.basinger.cc/health
```

## 6. systemd

Install service:

```bash
sudo cp deploy/ds-ticket-bot.service /etc/systemd/system/ds-ticket-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now ds-ticket-bot
sudo systemctl status ds-ticket-bot
```

Logs:

```bash
journalctl -u ds-ticket-bot -f
```

## 7. Trello webhook

Create a webhook for the production URL:

```bash
sudo -u ds-ticket-bot npm run trello:webhook:prod -- create
sudo -u ds-ticket-bot npm run trello:webhook:prod -- list
```

Delete the old ngrok webhook after production works:

```bash
sudo -u ds-ticket-bot npm run trello:webhook:prod -- delete <old_ngrok_webhook_id>
```

## 8. Smoke test

1. Create a Discord Forum Post in the configured channel.
2. Confirm Trello card was created.
3. Move the Trello card to another list.
4. Confirm Discord thread receives the status message.
5. Run `/sync-ticket` in the thread.

## Useful commands

Restart:

```bash
sudo systemctl restart ds-ticket-bot
```

View logs:

```bash
journalctl -u ds-ticket-bot -n 100 --no-pager
```

Backup SQLite:

```bash
sudo cp /opt/ds-ticket-bot/data/tickets.sqlite /opt/ds-ticket-bot/data/tickets.sqlite.backup
```
