import * as dotenv from 'dotenv';
import { DatabaseService } from './database/DatabaseService';
import { BotHandler } from './bot/BotHandler';
import { installWebAppBridge } from './bot/WebAppBridge';
import { ParserScheduler } from './scheduler/ParserScheduler';
import { startWebAppServer } from './services/WebAppServer';
import { logger } from './utils/logger';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!TELEGRAM_BOT_TOKEN) {
  logger.error('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

if (!DATABASE_URL) {
  logger.error('DATABASE_URL is not set');
  process.exit(1);
}

async function main() {
  logger.info('Starting WellBOT...', { version: '2.1.0', priceDropDedup: 'unique(external_id, old_price, new_price)' });

  const db = new DatabaseService(DATABASE_URL);
  await db.initialize();
  logger.info('Database initialized');

  const bot = new BotHandler(TELEGRAM_BOT_TOKEN, db);

  const scheduler = new ParserScheduler(db, bot);
  bot.setScheduler(scheduler);

  installWebAppBridge(bot);

  const webPort = Number(process.env.HUNT_WEB_PORT || 0);
  const webServer = webPort > 0 && webPort < 65536 ? startWebAppServer(webPort) : null;
  if (!webServer) logger.info('HUNT WebApp server disabled; set HUNT_WEB_PORT to enable it');

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

main().catch((error) => {
  logger.error('Fatal error', { error: error.message, stack: error.stack });
  process.exit(1);
});
