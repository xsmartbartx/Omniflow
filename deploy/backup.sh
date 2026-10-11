#!/usr/bin/env bash
# Consistent backup of a docker-compose Constans install (safe while it is running).
#
#   deploy/backup.sh [destination-dir]          # default: ./backups
#
# Schedule it (crontab -e):   17 2 * * *  cd /srv/constans && deploy/backup.sh /srv/backups
# The snapshot contains everything EXCEPT the master key. Keep CONSTANS_MASTER_KEY somewhere safe and
# separate — without it, stored secrets in a backup cannot be decrypted.
set -euo pipefail

dest="${1:-./backups}"
keep="${KEEP:-14}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$dest"

# 1. snapshot inside the container (VACUUM INTO: consistent, no downtime)
docker compose exec -T constans constans admin backup "/data/backups/constans-$stamp.db"

# 2. copy it out of the volume
docker compose cp "constans:/data/backups/constans-$stamp.db" "$dest/constans-$stamp.db"
docker compose cp "constans:/data/backups/constans-$stamp.db.artifacts" "$dest/constans-$stamp.db.artifacts" 2>/dev/null || true

# 3. verify the copy before trusting it, then prune old snapshots on both sides
docker compose exec -T constans constans admin verify-audit >/dev/null
docker compose exec -T constans sh -c "ls -1dt /data/backups/constans-*.db 2>/dev/null | tail -n +3 | while read -r f; do rm -rf \"\$f\" \"\$f.artifacts\"; done"
ls -1dt "$dest"/constans-*.db 2>/dev/null | tail -n +$((keep + 1)) | while read -r old; do rm -rf "$old" "$old.artifacts"; done

echo "backup written: $dest/constans-$stamp.db"
