# HUNT

**HUNT** — Telegram listing monitor for resellers. Add a marketplace search URL with filters, and the bot watches it continuously and sends new listings to Telegram as soon as they appear in the source feed.

## Production MVP

- 🟢 Kufar search monitoring with preserved URL filters
- 🔵 Onliner search monitoring
- 🚗 Av.by search monitoring
- ⚡ Default polling interval: **5 seconds** (minimum 1 second)
- 🚀 Concurrent parsing of up to 20 search URLs by default
- 🧠 First-run baseline — existing listings are not spammed as "new"
- 🔁 Duplicate protection per Telegram user
- 📉 Price-drop detection
- 🛡️ Telegram rate limiting and retries for `429`
- 📱 Telegram Mini App for adding a monitor
- 🗄️ PostgreSQL persistence
- 🐳 Docker / Docker Compose deployment
- ❤️ `/health` endpoint and container healthcheck
- 🔄 Restart policy for the bot and database
- 🤖 GitHub Actions build, test and Docker validation

> The 5-second value is a polling target. Actual detection latency also depends on when the marketplace makes a listing visible in its search/API feed and on network/Telegram delivery time. HUNT does not claim an exact one-second guarantee.

## Stack

- Node.js 22
- TypeScript (strict)
- Telegram Bot API via `node-telegram-bot-api`
- PostgreSQL 16
- Axios / Cheerio
- Docker Compose
- GitHub Actions CI

## Fastest production deployment

The repository includes `deploy.sh` for a Linux VM with Docker Compose.

```bash
git clone https://github.com/longzdez-debug/WellBot.git
cd WellBot
cp .env.example .env
nano .env
bash deploy.sh
```

Before running the script, set at minimum:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
DB_PASSWORD=use-a-long-random-password
HUNT_WEBAPP_URL=https://your-domain.example/
PARSE_INTERVAL_SECONDS=5
PARSE_CONCURRENCY=20
```

`deploy.sh` validates the required secrets, starts PostgreSQL, waits for it to become healthy, builds/starts HUNT, and waits for `http://127.0.0.1:8080/health` to pass.

> Never commit `.env` or Telegram/database credentials to Git.

## HTTPS / Mini App

For the Mini App, the built-in HUNT web server listens on port `8080`. Put an HTTPS reverse proxy in front of it and set `HUNT_WEBAPP_URL` to the public HTTPS URL.

A minimal Caddy example is provided in `Caddyfile.example`:

```text
hunt.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

After HTTPS is available, restart the bot so its **⚡ Открыть HUNT** button uses the configured URL.

The Mini App sends the entered search URL back to the bot using Telegram Web App data. The bot then uses the same server-side URL validation and persistence path as normal Telegram input.

## Telegram setup

1. Create a bot with `@BotFather` and copy its token to `.env`.
2. Start HUNT with `/start`.
3. Use **➕ Добавить ссылку** and paste a supported marketplace search URL.
4. The first successful parse creates a silent baseline.
5. New listings found on later cycles are sent to Telegram.

For Kufar, use a search/category URL (`kufar.by/l/*`) rather than a direct listing URL. Search parameters and supported filters are preserved by the parser.

## Monitoring configuration

| Variable | Default | Meaning |
|---|---:|---|
| `PARSE_INTERVAL_SECONDS` | `5` | Polling interval; values below 1 second are clamped to 1 second |
| `PARSE_CONCURRENCY` | `20` | Maximum search URLs parsed in parallel, clamped to 1–50 |
| `HUNT_WEB_PORT` | disabled | Built-in Mini App server port |
| `HUNT_WEBAPP_URL` | empty | Public HTTPS Mini App URL |
| `DB_PASSWORD` | — | PostgreSQL password used by Docker Compose |

## Reliability model

- A running parse cycle cannot overlap another cycle.
- A trigger arriving during a cycle is queued and executed immediately after the current cycle.
- A newly created monitor is parsed immediately rather than waiting for the next scheduled interval.
- First successful parse of a monitor creates a baseline without notifications.
- New listings are deduplicated before Telegram delivery.
- Telegram sender enforces per-chat/global pacing and retries rate-limit responses.
- PostgreSQL persists monitors and ads across container restarts.
- Docker restarts the bot after a process/container failure.

## Operations

```bash
# status
docker compose ps

# live bot logs
docker compose logs -f bot

# recent logs
docker compose logs --tail=200 bot

# health check
curl -fsS http://127.0.0.1:8080/health

# restart after configuration changes
docker compose up -d --build bot

# stop without deleting database data
docker compose down
```

The PostgreSQL volume is named `postgres_data`. Do **not** use `docker compose down -v` unless you intentionally want to delete the database.

## Development

```bash
npm ci
npm run build
npm test -- --runInBand
```

CI runs build, tests and a production Docker build on Node 22.

## Architecture

```text
src/
├── bot/              # Telegram handlers + Mini App bridge
├── database/         # PostgreSQL service and schema
├── parsers/          # Kufar / Onliner / Av.by parsers
├── scheduler/        # concurrent polling, dedup, notifications
├── services/         # Telegram sender, WebApp server, presentation
├── types/            # shared domain types
└── index.ts          # application entry point

web/
├── index.html        # HUNT Mini App UI
├── styles.css
└── app.js            # URL monitor form + Telegram WebApp bridge
```

## Repository

- GitHub: https://github.com/longzdez-debug/WellBot
- Default branch: `main`
- Production merge: `49ecf4a427d7d8f3ec9847a729681261aa460f5c`

## License

MIT
