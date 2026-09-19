#!/usr/bin/env bash
# End-to-end check of the container deployment, on this machine, in an isolated compose project:
# build → start (hardened: read-only root, no capabilities) → sign in → publish → run → doctor →
# backup → stop → restore → restart → data survived.  Touches nothing of yours: own project, own
# volume, own image tag, all removed at the end.
#
#   deploy/smoke-test.sh            # SMOKE_PORT=18081 by default
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=omniflow-smoke
export OMNIFLOW_IMAGE=omniflow:smoke
export OMNIFLOW_PORT="${SMOKE_PORT:-18081}"
tmp="$(mktemp -d)"
export OMNIFLOW_ENV_FILE="$tmp/env"
base="http://127.0.0.1:${OMNIFLOW_PORT}"

cat >"$tmp/env" <<ENV
OMNIFLOW_ENV=production
OMNIFLOW_ADMIN_EMAIL=admin@example.com
OMNIFLOW_ADMIN_PASSWORD=smoke-test-password-please-ignore
OMNIFLOW_MASTER_KEY=$(openssl rand -base64 32)
OMNIFLOW_PUBLIC_URL=$base
OMNIFLOW_LOG_LEVEL=warn
ENV

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*"; docker compose logs --tail 40 omniflow || true; exit 1; }
cleanup() { docker compose down -v --remove-orphans >/dev/null 2>&1 || true; docker rmi "$OMNIFLOW_IMAGE" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q omniflow)" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  die "the container did not become healthy"
}
omni() { docker compose exec -T -e OMNIFLOW_API_KEY="${KEY:-}" omniflow omniflow "$@"; }

step "build the image"
docker compose build --quiet omniflow
ok "built $OMNIFLOW_IMAGE ($(docker image inspect -f '{{.Size}}' "$OMNIFLOW_IMAGE" | awk '{printf "%.0f MB", $1/1048576}'))"

step "start it"
docker compose up -d omniflow
wait_healthy
ok "healthy"
curl -fsS "$base/healthz" >/dev/null && curl -fsS "$base/readyz" >/dev/null && ok "/healthz and /readyz respond"
curl -fsSI "$base/" | grep -qi "content-security-policy: default-src 'self'" && ok "the console is served with a strict CSP"
curl -fsS "$base/v1/info" | grep -q '"environment":"production"' && ok "running in production mode"

step "hardening"
[ "$(docker compose exec -T omniflow id -u)" = 10001 ] && ok "runs as uid 10001, not root"
docker compose exec -T omniflow sh -c 'touch /app/should-fail 2>/dev/null' && die "the root filesystem is writable" || ok "root filesystem is read-only"
docker compose exec -T omniflow sh -c 'touch /data/ok && rm /data/ok' && ok "the data volume is writable"
docker inspect -f '{{.HostConfig.CapDrop}}' "$(docker compose ps -q omniflow)" | grep -q ALL && ok "all Linux capabilities dropped"

step "use it"
KEY="$(omni admin create-api-key --name smoke --role admin --json | sed -n 's/.*"key": *"\([^"]*\)".*/\1/p')"
[ -n "$KEY" ] || die "could not create an API key"
ok "created an API key from inside the container (no login needed)"
omni publish /app/workflows | tee "$tmp/publish.txt" >/dev/null
grep -q "published hello-world@1.0.0" "$tmp/publish.txt" && ok "published the example workflows"
omni run hello-world --input name=Smoke --wait >"$tmp/run.txt"
grep -q "succeeded" "$tmp/run.txt" && ok "ran hello-world to completion"
omni workflows | grep -q hello-world && ok "listed it through the API"
omni admin verify-audit | grep -q intact && ok "audit hash chain verifies"
omni admin doctor >"$tmp/doctor.txt" || { cat "$tmp/doctor.txt"; die "doctor found problems"; }
ok "doctor: healthy"

step "backup → stop → restore → start"
omni admin backup /data/backups/smoke.db >/dev/null && ok "took a consistent online backup"
docker compose stop omniflow >/dev/null
docker compose run --rm --no-deps -T omniflow omniflow admin restore /data/backups/smoke.db --yes >/dev/null && ok "restored it over the stopped instance"
docker compose start omniflow >/dev/null
wait_healthy
ok "came back healthy"
omni workflows | grep -q hello-world && omni runs | grep -q hello-world && ok "workflows and run history survived"

step "restart (data lives on the volume)"
docker compose restart omniflow >/dev/null
wait_healthy
omni runs | grep -q hello-world && ok "run history persisted across a restart"

printf '\n\033[32mAll deployment checks passed.\033[0m\n'
