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
      logger.error('HUNT Mini App bridge failed', {
        userId,
        error: message,
      });
      await bot.sendMessage(chatId, '❌ Не удалось добавить мониторинг. Попробуйте ещё раз.');
    }
  });

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

  const configureMenuButton = (chatId?: number): void => {
    void bot.setChatMenuButton({
      ...(chatId !== undefined ? { chat_id: chatId } : {}),
      menu_button: menuButton,
    })
      .then(() => logger.info('HUNT Mini App menu button configured', { webAppUrl, chatId }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to configure HUNT Mini App menu button', {
          webAppUrl,
          chatId,
          error: message,
        });
      });
  };

  // Set the default button for chats without an override.
  configureMenuButton();

  // Telegram clients can retain a per-chat menu configuration. Re-apply the
  // HUNT button after /start without sending another message to the user.
  bot.on('message', (msg: Message) => {
    if (msg.text === '/start' && msg.chat.type === 'private') {
      configureMenuButton(msg.chat.id);

      // Use the Main Mini App deep link for the chat launch message. This is
      // deliberately different from a raw https://web-app URL: Telegram
      // recognizes the ?startapp link as a Main Mini App launch and invokes
      // the same authenticated WebView flow as the working "Open App" button
      // on the bot profile. This avoids clients that open a Web App URL as a
      // plain browser page and therefore provide empty initData.
      void bot.getMe()
        .then((me) => {
          if (!me.username) throw new Error('Bot username is unavailable');
          const mainAppUrl = `https://t.me/${me.username}?startapp`;
          return bot.sendMessage(msg.chat.id, '⚡ Откройте HUNT кнопкой ниже:', {
            reply_markup: {
              inline_keyboard: [[{
                text: '⚡ Открыть HUNT',
                url: mainAppUrl,
              }]],
            },
          });
        })
        .then(() => logger.info('HUNT Main Mini App launch button sent', { chatId: msg.chat.id }))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('Failed to send HUNT Main Mini App launch button', {
            chatId: msg.chat.id,
            error: message,
          });
        });
    }
  });

  logger.info('HUNT Mini App bridge installed', { webAppUrl });
}
