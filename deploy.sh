#!/usr/bin/env bash
set -Eeuo pipefail

# One-shot production deployment for a Linux VM with Docker Compose.
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

if [[ -z "${DB_PASSWORD:-}" || "$DB_PASSWORD" == "secure_password" ]]; then
  echo "ERROR: Set a strong DB_PASSWORD in .env before deployment." >&2
  exit 1
fi

if [[ "${HUNT_WEBAPP_URL:-}" == "https://hunt.example.com/" ]]; then
  echo "WARNING: Replace HUNT_WEBAPP_URL with your real public HTTPS URL if you want the Mini App." >&2
fi

# Ensure the database schema is initialized by the application after PostgreSQL becomes healthy.
echo "Building and starting HUNT..."
docker compose pull postgres
docker compose build --pull bot
docker compose up -d postgres

echo "Waiting for PostgreSQL..."
for _ in {1..30}; do
  if docker compose exec -T postgres pg_isready -U bot_user -d wellbot >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! docker compose exec -T postgres pg_isready -U bot_user -d wellbot >/dev/null 2>&1; then
  echo "ERROR: PostgreSQL did not become ready." >&2
  docker compose logs --tail=100 postgres >&2 || true
  exit 1
fi

docker compose up -d bot

echo "Waiting for HUNT health endpoint..."
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "HUNT is healthy."
    docker compose ps
    echo
echo "Logs: docker compose logs -f bot"
    exit 0
  fi
  sleep 2
done

echo "ERROR: HUNT did not become healthy." >&2
docker compose ps >&2 || true
docker compose logs --tail=150 bot >&2 || true
exit 1
