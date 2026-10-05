import * as dotenv from 'dotenv';
import { DatabaseService } from './database/DatabaseService';
import { BotHandler } from './bot/BotHandler';
import { installWebAppBridge } from './services/WebAppBridge';
import { ParserScheduler } from './scheduler/ParserScheduler';
import { startWebAppServer } from './services/WebAppServer';
import { installRuntimeGuards } from './services/RuntimeGuards';
import { logger } from './utils/logger';

dotenv.config();
installRuntimeGuards();

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) { logger.error(`${name} is not set`); process.exit(1); }
  return value;
}

async function main() {
  logger.info('Starting WellBOT...', { version: '2.0.2', miniAppApi: 'telegram-init-data' });
  // Start the HTTP listener before database initialization. DEPLEXO performs
  // its readiness probe immediately after the container starts; database
  // connection/migration work must never prevent port 8080 from accepting
  // /healthz during startup.
  const TELEGRAM_BOT_TOKEN = requiredEnv('TELEGRAM_BOT_TOKEN');
  const DATABASE_URL = requiredEnv('DATABASE_URL');
  const db = new DatabaseService(DATABASE_URL);
  // DEPLEXO exposes the port declared in deplexo.yaml. Do not let a generic
  // PORT injected by another runtime move the listener away from 8080: the
  // container HEALTHCHECK and DEPLEXO readiness probe both target this port.
  const configuredWebPort = process.env.WELLBOT_WEB_PORT || '8080';
  const webPort = Number(configuredWebPort);
  logger.info('WellBOT WebApp configuration', {
    configuredWebPort,
    webPort,
    host: '0.0.0.0',
    platformPort: process.env.PORT || null,
  });
  if (!Number.isInteger(webPort) || webPort <= 0 || webPort >= 65536) {
    throw new Error('WELLBOT_WEB_PORT must be a valid TCP port');
  }

  // Construct the application services before opening the listener. They do
  // not start background work until scheduler.start(), while /healthz itself
  // remains dependency-free during PostgreSQL startup.
  const bot = new BotHandler(TELEGRAM_BOT_TOKEN, db);
  const scheduler = new ParserScheduler(db, bot);
  installWebAppBridge(bot);

  // The server is intentionally created before DB initialization. /healthz is
  // dependency-free and must remain available even while PostgreSQL is starting.
  const webServer = await startWebAppServer(webPort, db, TELEGRAM_BOT_TOKEN, undefined, () => scheduler.getMetrics());

  await db.initialize();
  logger.info('Database initialized');

  scheduler.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    await scheduler.stop();
    bot.stop();
    if (webServer) await webServer.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  logger.info('WellBOT is running!');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error('Fatal error', { error: message, stack });
  process.exit(1);
});
