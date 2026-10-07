import * as dotenv from 'dotenv';
import { URL } from 'node:url';
import dns from 'node:dns';
import net from 'node:net';
import { DatabaseService } from './database/DatabaseService';
import { BotHandler } from './bot/BotHandler';
import { installWebAppBridge } from './services/WebAppBridge';
import { ParserScheduler } from './scheduler/ParserScheduler';
import { startWebAppServer } from './services/WebAppServer';
import { installRuntimeGuards } from './services/RuntimeGuards';
import { logger } from './utils/logger';

dotenv.config();
installRuntimeGuards();
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    const message = name + ' is not set';
    console.error('[WellBOT FATAL] ' + message);
    logger.error(message);
    process.exit(1);
  }
  return value;
}

function safeError(error: unknown): { message: string; code?: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    const value = error as Error & { code?: string };
    return { message: value.message, code: value.code, name: value.name, stack: value.stack };
  }
  return { message: String(error) };
}

async function main() {
  const buildRevision = process.env.WELLBOT_BUILD_REV || '4da3f8712bcba07d8c58f92ebeeb9e642256c343';
  logger.info('Starting WellBOT...', { version: '2.0.4', buildRevision, miniAppApi: 'telegram-init-data' });
  const configuredWebPort = process.env.PORT || '3000';
  const webPort = Number(configuredWebPort);
  console.log('[WellBOT] HTTP startup', JSON.stringify({ port: configuredWebPort, platformPort: process.env.PORT || null, host: '0.0.0.0' }));
  logger.info('WellBOT WebApp configuration', { configuredWebPort, webPort, host: '0.0.0.0', platformPort: process.env.PORT || null });
  if (!Number.isInteger(webPort) || webPort <= 0 || webPort >= 65536) throw new Error('PORT must be a valid TCP port');

  logger.info('Checking required environment variables');
  const TELEGRAM_BOT_TOKEN = requiredEnv('TELEGRAM_BOT_TOKEN').trim();
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is empty');
  logger.info('TELEGRAM_BOT_TOKEN is configured');
  const DATABASE_URL = requiredEnv('DATABASE_URL');
  logger.info('DATABASE_URL is configured');

  const dbUrl = new URL(DATABASE_URL);
  const dbHost = dbUrl.hostname;
  const dbPort = dbUrl.port || '5432';
  const dbName = dbUrl.pathname.replace(/^\//, '') || '(default)';
  logger.info('PostgreSQL endpoint', { host: dbHost, port: dbPort, database: dbName });
  try {
    const addresses = await dns.promises.lookup(dbHost, { all: true });
    logger.info('PostgreSQL DNS resolved', { host: dbHost, addresses: addresses.map(item => ({ address: item.address, family: item.family })) });
  } catch (error) {
    const details = safeError(error);
    logger.warn('PostgreSQL DNS lookup failed', { host: dbHost, message: details.message, code: details.code });
  }
  const db = new DatabaseService(DATABASE_URL);
  logger.info('Connecting to PostgreSQL...');
  try {
    await db.initialize();
  } catch (error) {
    const details = safeError(error);
    console.error('[WellBOT FATAL] PostgreSQL initialization failed', JSON.stringify({
      message: details.message, code: details.code, name: details.name,
    }));
    logger.error('PostgreSQL initialization failed', {
      message: details.message, code: details.code, name: details.name,
    });
    throw error;
  }

  const dbHealth = await db.healthCheck();
  logger.info('Database initialized', { database: dbHealth.database, serverVersion: dbHealth.serverVersion });

  let scheduler: ParserScheduler | null = null;
  let shuttingDown = false;
  const webServer = await startWebAppServer(
    webPort,
    db,
    TELEGRAM_BOT_TOKEN,
    undefined,
    async () => {
      if (!scheduler) return { scheduler: { running: false }, notifications: {}, generatedAt: new Date().toISOString() };
      const metrics = await scheduler.getMetrics();
      return { ...metrics, scheduler: { ...metrics.scheduler, running: !shuttingDown, busy: metrics.scheduler.running } };
    },
  );
  const bot = new BotHandler(TELEGRAM_BOT_TOKEN, db);
  scheduler = new ParserScheduler(db, bot);
  installWebAppBridge(bot);
  scheduler.start();

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    await scheduler?.stop();
    bot.stop();
    await webServer.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  logger.info('WellBOT is running!', { buildRevision });
}

main().catch((error: unknown) => {
  const details = safeError(error);
  console.error('[WellBOT FATAL] Startup failed', JSON.stringify({
    message: details.message, code: details.code, name: details.name, stack: details.stack,
  }));
  logger.error('Fatal startup error', {
    message: details.message, code: details.code, name: details.name, stack: details.stack,
  });
  process.exit(1);
});
