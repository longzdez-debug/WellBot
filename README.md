# HUNT

**HUNT** — Telegram listing monitor for resellers. Add a search URL with filters, and the bot watches it continuously and sends new listings to Telegram as soon as they appear in the source feed.

## MVP

- 🟢 Kufar search monitoring with preserved URL filters
- 🔵 Onliner search monitoring
- 🚗 Av.by search monitoring
- ⚡ Default polling interval: **5 seconds** (minimum 1 second)
- 🚀 Concurrent parsing of up to 20 search URLs by default
- 🧠 Baseline snapshot on first run — existing listings are not spammed as "new"
- 🔁 Duplicate protection per Telegram user
- 📉 Price-drop detection
- 🛡️ Telegram rate limiting and retries for transient `429` responses
- 📱 Telegram Mini App for adding a Kufar monitor
- 🗄️ PostgreSQL persistence
- 🐳 Docker / Docker Compose deployment

> The 5-second setting is a polling target. Actual detection latency also depends on when the marketplace makes a listing visible to its search/API feed and on network/Telegram delivery time. HUNT does not claim an exact one-second guarantee.

## Stack

- Node.js 22
- TypeScript (strict)
- Telegram Bot API via `node-telegram-bot-api`
- PostgreSQL 16
- Axios / Cheerio
- Docker Compose
- GitHub Actions CI

## Quick start with Docker

### 1. Configure environment

```bash
cp .env.example .env
```

Set at minimum:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
DATABASE_URL=postgresql://bot_user:your_password@localhost:5432/wellbot
HUNT_WEBAPP_URL=https://hunt.example.com/
HUNT_WEB_PORT=8080
PARSE_INTERVAL_SECONDS=5
PARSE_CONCURRENCY=20
```

For the included Compose stack, `DB_PASSWORD` controls the PostgreSQL password and the container builds `DATABASE_URL` automatically.

### 2. Start

```bash
docker compose up -d --build
```

The bot and the HUNT Mini App are served by the same application container. The built-in web server listens on port `8080`.

For production, put an HTTPS reverse proxy (for example, Caddy or Nginx) in front of port `8080` and set `HUNT_WEBAPP_URL` to the public HTTPS URL.

### 3. Logs / status

```bash
docker compose ps
docker compose logs -f bot
```

Look for:

```text
HUNT WebApp server started
Parser scheduler started
Parsing cycle completed
NEW AD DETECTED!
```

## Telegram setup

1. Create a bot with `@BotFather` and copy its token to `.env`.
2. Start the bot with `/start`.
3. Use **➕ Добавить ссылку** or open the HUNT Mini App.
4. Paste a supported marketplace search URL with the filters you want.
5. HUNT performs an initial baseline snapshot, then alerts on subsequent new listings.

### HUNT Mini App

Set `HUNT_WEBAPP_URL` to the public HTTPS URL of the web server. The bot exposes an **⚡ Открыть HUNT** button in private chats when this variable is configured.

The Mini App sends the entered search URL back to the bot using Telegram Web App data; the same server-side URL validation and persistence path is then used as for normal Telegram input.

## Monitoring configuration

| Variable | Default | Meaning |
|---|---:|---|
| `PARSE_INTERVAL_SECONDS` | `5` | Polling interval; values below 1 second are clamped to 1 second |
| `PARSE_CONCURRENCY` | `20` | Maximum search URLs parsed in parallel, clamped to 1–50 |
| `HUNT_WEB_PORT` | disabled | Built-in Mini App server port |
| `HUNT_WEBAPP_URL` | empty | Public HTTPS Mini App URL |

## Supported search links

The server validates supported search pages before creating a monitor. For Kufar, use a search/category URL (`kufar.by/l/*`) rather than a direct listing URL. URL query parameters and filters are preserved for the parser.

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

## Reliability model

- A running parse cycle cannot overlap another cycle.
- A trigger arriving during a cycle is queued and executed immediately after the current cycle.
- First successful parse of a new monitor creates a baseline without notifications.
- New listings are deduplicated before Telegram delivery.
- Telegram sender enforces per-chat/global pacing and retries rate-limit responses.
- Repeated parser failures increment an error counter; persistently failing links can be disabled.

## Development

```bash
npm ci
npm run build
npm test -- --runInBand
```

CI runs the same build and test commands on Node 22.

## Repository

- GitHub: `https://github.com/longzdez-debug/WellBot`
- Active development branch: `feature/hunt-ui`
- Pull request: `https://github.com/longzdez-debug/WellBot/pull/1`

## License

MIT
