import TelegramBot, { Message } from 'node-telegram-bot-api';
import { BotHandler } from './BotHandler';
import { logger } from '../utils/logger';

/**
 * Connects the WellBOT Mini App to the existing Telegram bot without duplicating
 * the bot's business logic. The Mini App sends a URL via web_app_data and the
 * normal BotHandler link flow performs validation, parsing and persistence.
 */
export function installWebAppBridge(handler: BotHandler): void {
  const bot = (handler as unknown as { bot: TelegramBot }).bot;
  if (!bot) {
    logger.warn('WellBOT WebApp bridge not installed: Telegram bot is unavailable');
    return;
  }

  const webAppUrl = process.env.WellBOT_WEBAPP_URL?.trim();
  if (!webAppUrl) {
    logger.info('WellBOT Mini App URL is not configured; menu button is disabled');
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(webAppUrl);
  } catch {
    logger.error('WellBOT Mini App URL is invalid', { webAppUrl });
    return;
  }

  if (parsedUrl.protocol !== 'https:') {
    logger.error('WellBOT Mini App URL must use HTTPS', { webAppUrl });
    return;
  }

  const menuButton = {
    type: 'web_app' as const,
    text: '⚡ WellBOT',
    web_app: { url: webAppUrl },
  };

  const configureMenuButton = (chatId?: number): void => {
    void bot.setChatMenuButton({
      ...(chatId !== undefined ? { chat_id: chatId } : {}),
      menu_button: menuButton,
    })
      .then(() => logger.info('WellBOT Mini App menu button configured', { webAppUrl, chatId }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to configure WellBOT Mini App menu button', {
          webAppUrl,
          chatId,
          error: message,
        });
      });
  };

  // Set the default button for chats without an override.
  configureMenuButton();

  // Per-chat menu configuration is refreshed on /start. The visible launcher
  // now lives in the single-button reply keyboard supplied by BotHandler.
  bot.on('message', (msg: Message) => {
    if (msg.text === '/start' && msg.chat.type === 'private') {
      configureMenuButton(msg.chat.id);
    }
  });

  logger.info('WellBOT Mini App bridge installed', { webAppUrl });
}
