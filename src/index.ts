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
  if (!value) { logger.error(name + ' is not set'); process.exit(1); }
  return value;
}

async function main() {
  logger.info('Starting WellBOT...', { version: '2.0.4', miniAppApi: 'telegram-init-data' });
  const configuredWebPort = process.env.PORT || '3000';
  const webPort = Number(configuredWebPort);
  console.log('[WellBOT] HTTP startup', JSON.stringify({ port: configuredWebPort, platformPort: process.env.PORT || null, host: '0.0.0.0' }));
  logger.info('WellBOT WebApp configuration', { configuredWebPort, webPort, host: '0.0.0.0', platformPort: process.env.PORT || null });
  if (!Number.isInteger(webPort) || webPort <= 0 || webPort >= 65536) throw new Error('PORT must be a valid TCP port');
  const TELEGRAM_BOT_TOKEN = requiredEnv('TELEGRAM_BOT_TOKEN');
  const DATABASE_URL = requiredEnv('DATABASE_URL');
  const db = new DatabaseService(DATABASE_URL);
  await db.initialize();
  const dbHealth=await db.healthCheck();
  logger.info('Database initialized',{database:dbHealth.database,serverVersion:dbHealth.serverVersion});
  let scheduler: ParserScheduler | null = null;
  const webServer = await startWebAppServer(
    webPort,
    db,
    TELEGRAM_BOT_TOKEN,
    undefined,
    async () => scheduler ? await scheduler.getMetrics() : { scheduler: { running: false }, notifications: {}, generatedAt: new Date().toISOString() },
  );
  const bot = new BotHandler(TELEGRAM_BOT_TOKEN, db);
  scheduler = new ParserScheduler(db, bot);
  installWebAppBridge(bot);
  scheduler.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    await scheduler?.stop(); bot.stop(); await webServer.close(); await db.close(); process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  logger.info('WellBOT is running!');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error('Fatal error', { error: message, stack });
  process.exit(1);
});
