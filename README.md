# WellBOT

**WellBOT** — Telegram listing search for resellers. Create a marketplace search from the WellBOT catalog with category, city, price, condition, seller and mode filters. WellBOT watches it continuously and sends new listings to Telegram.

## Production MVP

- 🟢 Kufar catalog search monitoring
- 🔵 Onliner search monitoring
- 🚗 Av.by search monitoring
- ⚡ Default polling interval: **0.25 seconds**
- 🚀 Concurrent parsing of up to 16 searches by default
- 🧠 First-run baseline — existing listings are not spammed as "new"
- 🔁 Duplicate protection per Telegram user
- 📉 Price-drop detection
- 🛡️ Telegram rate limiting and retries for `429`
- 📱 Telegram Mini App for creating and managing searches
- 📊 Live scheduler and notification performance metrics
- 🗄️ PostgreSQL persistence
- 🐳 Docker / Docker Compose deployment
- ❤️ `/health` endpoint and container healthcheck
- 🔄 Restart policy for the bot and database
- 🤖 GitHub Actions build, test and Docker validation

> The 0.5-second value is the scheduler target between cycles. Actual detection latency also depends on source visibility, parser/network latency and Telegram delivery. WellBOT does not claim an exact end-to-end latency guarantee.

## Production target

Production runs on **DEPLEXO**. The repository is designed so the same Docker Compose stack can be rebuilt and restarted there without changing application code.

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
WELLBOT_WEBAPP_URL=https://your-domain.example/
PARSE_INTERVAL_SECONDS=0.25
PARSE_CONCURRENCY=16
```

`deploy.sh` validates the required secrets, starts PostgreSQL, waits for it to become healthy, builds/starts WellBOT, and waits for `http://127.0.0.1:8080/health` to pass.

> Never commit `.env` or Telegram/database credentials to Git.

## HTTPS / Mini App

For the Mini App, the built-in WellBOT web server listens on port `8080`. Put an HTTPS reverse proxy in front of it and set `WELLBOT_WEBAPP_URL` to the public HTTPS URL.

A minimal Caddy example is provided in `Caddyfile.example`:

```text
wellbot.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

After HTTPS is available, restart the bot so its **⚡ Открыть WellBOT** button uses the configured URL.

The Mini App sends the selected search configuration to the authenticated WebApp API. The server validates the catalog category and persists the search.

## Telegram setup

1. Create a bot with `@BotFather` and copy its token to `.env`.
2. Start WellBOT with `/start`.
3. Use **➕ Добавить поиск** and choose a category plus filters in the catalog.
4. The first successful parse creates a silent baseline.
5. New listings found on later cycles are sent to Telegram.

Kufar searches are generated server-side from the verified WellBOT catalog, so users do not need to paste marketplace URLs.

## Monitoring configuration

| Variable | Default | Meaning |
|---|---:|---|
| `PARSE_INTERVAL_SECONDS` | `0.25` | Polling interval; values are clamped to 100 ms minimum |
| `PARSE_CONCURRENCY` | `16` | Maximum search URLs parsed in parallel, clamped to 1–20 |
| `WELLBOT_WEB_PORT` | disabled | Built-in Mini App server port |
| `WELLBOT_WEBAPP_URL` | empty | Public HTTPS Mini App URL |
| `DB_PASSWORD` | — | PostgreSQL password used by Docker Compose |

## Reliability model

- A running parse cycle cannot overlap another cycle.
- A trigger arriving during a cycle is queued and executed immediately after the current cycle.
- A newly created search is parsed immediately rather than waiting for the next scheduled interval.
- The authenticated `/api/metrics` endpoint exposes scheduler p50/p95 cycle latency and notification counters.
- The Mini App displays a compact performance/health card.
- First successful parse of a search creates a baseline without notifications.
- New listings are deduplicated before Telegram delivery.
- Telegram sender enforces per-chat/global pacing and retries rate-limit responses.
- PostgreSQL persists searches and ads across container restarts.
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
├── parsers/          # Kufar realtime source racing / Onliner / Av.by parsers
├── scheduler/        # concurrent polling, dedup, notifications
├── services/         # Telegram sender, WebApp server, presentation
├── types/            # shared domain types
└── index.ts          # application entry point

web/
├── index.html        # WellBOT Mini App UI
├── styles.css
└── app.js            # search form + Telegram WebApp bridge
```

## Repository

- GitHub: https://github.com/longzdez-debug/WellBot
- Default branch: `main`
- Production deployments should be validated by CI before rollout.

## License

MIT
