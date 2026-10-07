#!/usr/bin/env bash
set -Eeuo pipefail

# Production deployment with Docker Compose and external managed PostgreSQL. No local DB is created.
# Usage: bash deploy.sh

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed. Install Docker Engine + Compose plugin first." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: Docker Compose v2 plugin is not available." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  if [[ ! -f .env.example ]]; then
    echo "ERROR: .env.example is missing." >&2
    exit 1
  fi
  cp .env.example .env
  echo "Created .env from .env.example."
fi

# Load simple KEY=VALUE entries without printing secrets.
set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || "$TELEGRAM_BOT_TOKEN" == "your_bot_token_here" ]]; then
  echo "ERROR: Set TELEGRAM_BOT_TOKEN in .env before deployment." >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" || "$DATABASE_URL" == *"USER:PASSWORD@HOST"* ]]; then
  echo "ERROR: Set the managed PostgreSQL DATABASE_URL in .env before deployment." >&2
  exit 1
fi

if [[ "${WELLBOT_WEBAPP_URL:-}" == "https://wellbot.example.com/" ]]; then
  echo "WARNING: Replace WELLBOT_WEBAPP_URL with your real public HTTPS URL if you want the Mini App." >&2
fi

# Ensure the database schema is initialized by the application after PostgreSQL becomes healthy.
echo "Building and starting WellBOT..."
docker compose -f docker-compose.prod.yml build --pull bot
docker compose -f docker-compose.prod.yml up -d bot

echo "Waiting for WellBOT health endpoint..."
HEALTH_PORT="${PORT:-3000}"
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$HEALTH_PORT/healthz" >/dev/null 2>&1; then
    echo "WellBOT is healthy."
    docker compose -f docker-compose.prod.yml ps
    echo
echo "Logs: docker compose -f docker-compose.prod.yml logs -f bot"
    exit 0
  fi
  sleep 2
done

echo "ERROR: WellBOT did not become healthy." >&2
docker compose -f docker-compose.prod.yml ps >&2 || true
docker compose -f docker-compose.prod.yml logs --tail=150 bot >&2 || true
exit 1
