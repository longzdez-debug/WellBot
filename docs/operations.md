# WellBOT production operations

## Observability

The bot exposes a Prometheus-compatible endpoint at `GET /metrics`. It is intentionally separate from the authenticated Mini App API.

Key signals:
- `wellbot_scheduler_failures_total`
- `wellbot_scheduler_link_failures_total`
- `wellbot_scheduler_oldest_link_age_ms`
- `wellbot_scheduler_cycle_p95_ms`
- `wellbot_notification_pending`
- `wellbot_notification_oldest_age_ms`
- `wellbot_notification_failed_total`
- `wellbot_db_pool_waiting`
- `wellbot_http_rate_limited_total`
- `wellbot_api_errors_total`

Recommended alerts:
- scheduler failures: increase for 5 minutes
- oldest active link age: greater than 3x the configured parse interval
- notification oldest age: greater than 10 minutes
- notification pending: continuously growing for 10 minutes
- database pool waiting: greater than 0 for 2 minutes
- HTTP 5xx: greater than 2% for 5 minutes
- HTTP rate limiting: sustained growth, indicating abuse or a broken client
- process health: `/healthz` returns non-2xx for 2 consecutive probes

Every HTTP request receives `X-Request-Id` and `X-Trace-Id`. Preserve these IDs when correlating application logs with a failing request.

## Database backup and restore

The PostgreSQL volume is persistent, but a volume is not a backup. Production must have an external backup policy.

Daily logical backup:

```bash
mkdir -p backups
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" > "backups/wellbot-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Restore into a disposable PostgreSQL instance first:

```bash
createdb wellbot_restore
pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" wellbot-YYYYMMDDTHHMMSSZ.dump
```

Do not restore directly over production until the dump has been verified in an isolated database.

Minimum production policy:
- retain at least 14 daily backups
- keep at least 4 weekly backups
- keep at least 3 monthly backups
- encrypt backups at rest
- store backups outside the PostgreSQL host
- perform a restore drill at least monthly
- alert when the latest successful backup is older than 25 hours

## Deployment / rollback

The application is stateless apart from PostgreSQL. Keep the previous production image available until the new version has passed:
1. image startup
2. `/healthz`
3. database connectivity
4. scheduler startup
5. notification outbox drain

If a release causes elevated errors, stop the new container and redeploy the previous image. Do not delete the PostgreSQL volume during rollback.

## Security

Set `WELLBOT_ALLOWED_ORIGINS` to the exact trusted Mini App origins in production. Keep `WELLBOT_API_RATE_LIMIT` at a conservative value and tune it from the `wellbot_http_rate_limited_total` metric.

Never place the Telegram bot token, database password, raw Telegram init data, or complete user payloads into logs or telemetry.
