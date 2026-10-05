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
  logger.info('Starting WellBOT...', { version: '2.0.2', miniAppApi: 'telegram-init-data' });
  const db = new DatabaseService(DATABASE_URL);
  await db.initialize();
  logger.info('Database initialized');

  const bot = new BotHandler(TELEGRAM_BOT_TOKEN, db);
  const scheduler = new ParserScheduler(db, bot);
  installWebAppBridge(bot);

  // The Docker image and compose stack expose port 8080 for the Mini App.
  // Keep the WebApp enabled by default for Telegram Mini App deployments.
  const configuredWebPort = process.env.PORT || process.env.WELLBOT_WEB_PORT || '8080';
  const webPort = Number(configuredWebPort);
  logger.info('WellBOT WebApp configuration', { configuredWebPort, webPort });
  const webServer = webPort > 0 && webPort < 65536
    ? startWebAppServer(webPort, db, TELEGRAM_BOT_TOKEN, undefined, () => scheduler.getMetrics())
    : null;
  if (!webServer) logger.error('WellBOT WebApp server disabled; WELLBOT_WEB_PORT must be a valid TCP port');

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
