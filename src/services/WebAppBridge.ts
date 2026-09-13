import TelegramBot, { Message } from 'node-telegram-bot-api';
import { BotHandler } from '../bot/BotHandler';
import { logger } from '../utils/logger';

export function installWebAppBridge(handler: BotHandler): void {
  const bot = (handler as unknown as { bot: TelegramBot }).bot;
  if (!bot) {
    logger.warn('HUNT WebApp bridge not installed: Telegram bot is unavailable');
    return;
  }

  const webAppUrl = process.env.HUNT_WEBAPP_URL?.trim();
  if (!webAppUrl) {
    logger.info('HUNT Mini App URL is not configured; menu button is disabled');
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(webAppUrl);
  } catch {
    logger.error('HUNT Mini App URL is invalid', { webAppUrl });
    return;
  }

  if (parsedUrl.protocol !== 'https:') {
    logger.error('HUNT Mini App URL must use HTTPS', { webAppUrl });
    return;
  }

  const menuButton = {
    type: 'web_app' as const,
    text: '⚡ HUNT',
    web_app: { url: webAppUrl },
  };

  const configureMenuButton = async (chatId: number): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await bot.setChatMenuButton({ chat_id: chatId, menu_button: menuButton });
        const current = await bot.getChatMenuButton({ chat_id: chatId });
        const verified = current?.type === 'web_app'
          && current.text === menuButton.text
          && current.web_app?.url === webAppUrl;

        if (verified) {
          logger.info('HUNT Mini App menu button verified', { webAppUrl, chatId, attempt });
          return;
        }

        logger.warn('HUNT Mini App menu button verification mismatch', {
          webAppUrl,
          chatId,
          attempt,
          current,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to configure HUNT Mini App menu button', {
          webAppUrl,
          chatId,
          attempt,
          error: message,
        });
      }

      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  };

  // Always configure the concrete private chat. This overrides stale per-chat
  // Telegram menu state instead of relying only on the bot-wide default.
  bot.on('message', (msg: Message) => {
    if (msg.chat.type === 'private' && msg.from) {
      void configureMenuButton(msg.chat.id);
    }
  });

  // Keep the bot-wide default configured for users opening a new private chat.
  void bot.setChatMenuButton({ menu_button: menuButton }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to configure default HUNT menu button', { webAppUrl, error: message });
  });

  bot.on('message', async (msg: Message) => {
    const webAppData = (msg as Message & { web_app_data?: { data?: string } }).web_app_data;
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
        ? payload.trim()
        : (payload && typeof payload === 'object' && 'url' in payload && typeof (payload as { url?: unknown }).url === 'string'
          ? (payload as { url: string }).url.trim()
          : '');

      if (!url || url.length > 4096) {
        await bot.sendMessage(chatId, '❌ Некорректная ссылка. Отправьте ссылку на страницу поиска.');
        return;
      }

      logger.info('HUNT Mini App submitted monitoring URL', { userId, url });
      await handler.handleAddLink(chatId, userId, url);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('HUNT Mini App bridge failed', { userId, error: message });
      await bot.sendMessage(chatId, '❌ Не удалось добавить мониторинг. Попробуйте ещё раз.');
    }
  });

  logger.info('HUNT WebApp bridge installed', { webAppUrl });
}
