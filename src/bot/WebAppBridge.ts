import TelegramBot, { Message } from 'node-telegram-bot-api';
import { BotHandler } from './BotHandler';
import { logger } from '../utils/logger';

/**
 * Connects the HUNT Mini App to the existing Telegram bot without duplicating
 * the bot's business logic. The Mini App sends a URL via web_app_data and the
 * normal BotHandler link flow performs validation, parsing and persistence.
 */
export function installWebAppBridge(handler: BotHandler): void {
  const bot = (handler as unknown as { bot: TelegramBot }).bot;
  if (!bot) {
    logger.warn('HUNT WebApp bridge not installed: Telegram bot is unavailable');
    return;
  }

  bot.on('message', async (msg: Message) => {
    const webAppData = (msg as Message & {
      web_app_data?: { data?: string };
    }).web_app_data;

    if (!msg.from || !webAppData?.data) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
      let payload: unknown;
      try {
        payload = JSON.parse(webAppData.data);
      } catch {
        payload = webAppData.data;
      }

      const url = typeof payload === 'string'
        ? payload
        : (payload && typeof payload === 'object' && 'url' in payload && typeof (payload as { url?: unknown }).url === 'string'
          ? (payload as { url: string }).url
          : '');

      if (!url) {
        await bot.sendMessage(chatId, '❌ HUNT не получил ссылку. Вставьте ссылку на поиск и попробуйте ещё раз.');
        return;
      }

      logger.info('HUNT Mini App submitted monitoring URL', { userId, url });
      await handler.handleAddLink(chatId, userId, url);
    } catch (error: any) {
      logger.error('HUNT Mini App bridge failed', {
        userId,
        error: error.message,
      });
      await bot.sendMessage(chatId, '❌ Не удалось добавить мониторинг. Попробуйте ещё раз.');
    }
  });

  const webAppUrl = process.env.HUNT_WEBAPP_URL?.trim();
  if (!webAppUrl) {
    logger.info('HUNT Mini App URL is not configured; web_app button is disabled');
    return;
  }

  bot.on('message', async (msg: Message) => {
    if (!msg.from || msg.text !== '/start' || msg.chat.type !== 'private') return;

    try {
      const replyMarkup = {
        keyboard: [[{
          text: '⚡ Открыть HUNT',
          web_app: { url: webAppUrl },
        }]],
        resize_keyboard: true,
        persistent: true,
      } as any;

      await bot.sendMessage(msg.chat.id, '⚡ Открыть HUNT терминал:', {
        reply_markup: replyMarkup,
      });
    } catch (error: any) {
      logger.error('Failed to send HUNT WebApp button', {
        userId: msg.from.id,
        error: error.message,
      });
    }
  });

  logger.info('HUNT Mini App bridge installed', { webAppUrl });
}
