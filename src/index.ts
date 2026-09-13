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

const TELEGRAM_BOT_TOKEN = requiredEnv('TELEGRAM_BOT_TOKEN');
const DATABASE_URL = requiredEnv('DATABASE_URL');

async function main() {
  logger.info('Starting WellBOT...', { version: '2.2.0', miniAppApi: 'telegram-init-data' });
  const db = new DatabaseService(DATABASE_URL);
  await db.initialize();
  logger.info('Database initialized');

  const bot = new BotHandler(TELEGRAM_BOT_TOKEN, db);
  const scheduler = new ParserScheduler(db, bot);
  bot.setScheduler(scheduler);
  installWebAppBridge(bot);

  // The Docker image and compose stack expose port 8080 for the Mini App.
  // Keep the WebApp enabled by default so a deployment that does not inject
  // HUNT_WEB_PORT cannot silently publish a Telegram URL that returns 404.
  const webPort = Number(process.env.HUNT_WEB_PORT || 8080);
  const webServer = webPort > 0 && webPort < 65536
    ? startWebAppServer(webPort, db, TELEGRAM_BOT_TOKEN)
    : null;
  if (!webServer) logger.error('HUNT WebApp server disabled; HUNT_WEB_PORT must be a valid TCP port');

  scheduler.start();

  const shutdown = async () => {
    logger.info('Shutting down...');
    scheduler.stop();
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
