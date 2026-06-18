#!/usr/bin/env bash
set -euo pipefail

DB_PATH="/opt/ds-ticket-bot/data/tickets.sqlite"
BACKUP_DIR="/opt/ds-ticket-bot/backups"
RETENTION_DAYS="30"

if [[ ! -r "$DB_PATH" ]]; then
  echo "ERROR: database is not readable: $DB_PATH" >&2
  exit 1
fi

install -d -m 700 -o root -g root "$BACKUP_DIR"
umask 077

stamp="$(date +%Y%m%d-%H%M%S)"
tmp_backup="$BACKUP_DIR/.tickets-$stamp.sqlite"
final_backup="$BACKUP_DIR/tickets-$stamp.sqlite.gz"

cleanup() {
  rm -f "$tmp_backup" "$tmp_backup.gz"
}
trap cleanup EXIT

sqlite3 "$DB_PATH" ".backup '$tmp_backup'"

check_result="$(sqlite3 "$tmp_backup" 'PRAGMA integrity_check;')"
if [[ "$check_result" != "ok" ]]; then
  echo "ERROR: SQLite integrity check failed: $check_result" >&2
  exit 1
fi

gzip -9 "$tmp_backup"
mv "$tmp_backup.gz" "$final_backup"
chmod 600 "$final_backup"
ln -sfn "$(basename "$final_backup")" "$BACKUP_DIR/latest.sqlite.gz"

find "$BACKUP_DIR" -type f -name 'tickets-*.sqlite.gz' -mtime +"$RETENTION_DAYS" -delete

size="$(du -h "$final_backup" | awk '{print $1}')"
echo "Created $final_backup ($size), integrity_check=ok"
