import axios from 'axios';
import TelegramBot, { Message } from 'node-telegram-bot-api';
import { BotHandler } from '../bot/BotHandler';
import { logger } from '../utils/logger';

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramMenuButton {
  type: string;
  text?: string;
  web_app?: { url: string };
}

export function installWebAppBridge(handler: BotHandler): void {
  const bot = (handler as unknown as { bot: TelegramBot }).bot;
  if (!bot) {
    logger.warn('HUNT WebApp bridge not installed: Telegram bot is unavailable');
    return;
  }

  const webAppUrl = process.env.HUNT_WEBAPP_URL?.trim();
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!webAppUrl || !botToken) {
    logger.info('HUNT Mini App configuration is incomplete; menu button is disabled');
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

  const normalizedWebAppUrl = parsedUrl.toString();
  const menuButton = {
    type: 'web_app' as const,
    text: '⚡ HUNT',
    web_app: { url: normalizedWebAppUrl },
  };

  const telegramApiBase = ['https:', '', 'api.telegram.org'].join('/');
  const telegramApi = async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
    const response = await axios.post<TelegramApiResponse<T>>(
      `${telegramApiBase}/bot${botToken}/${method}`,
      body,
      { timeout: 10000 },
    );

    if (!response.data.ok || response.data.result === undefined) {
      throw new Error(response.data.description || `Telegram API ${method} failed`);
    }

    return response.data.result;
  };

  const normalizeUrl = (value: string): string => value.replace(/\/+$/, '');
  const expectedUrl = normalizeUrl(normalizedWebAppUrl);
  const configuredChats = new Set<number>();

  const verifyMenuButton = (current: TelegramMenuButton): boolean => (
    current.type === 'web_app'
    && current.text === menuButton.text
    && normalizeUrl(current.web_app?.url || '') === expectedUrl
  );

  const configureMenuButton = async (chatId?: number): Promise<void> => {
    if (chatId !== undefined && configuredChats.has(chatId)) return;

    const scope = chatId === undefined ? {} : { chat_id: chatId };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await telegramApi<boolean>('setChatMenuButton', {
          ...scope,
          menu_button: menuButton,
        });

        const current = await telegramApi<TelegramMenuButton>('getChatMenuButton', scope);

        if (verifyMenuButton(current)) {
          if (chatId !== undefined) configuredChats.add(chatId);
          logger.info('HUNT Mini App menu button verified', {
            webAppUrl: normalizedWebAppUrl,
            chatId,
            scope: chatId === undefined ? 'default' : 'private_chat',
            attempt,
          });
          return;
        }

        logger.warn('HUNT Mini App menu button verification mismatch', {
          webAppUrl: normalizedWebAppUrl,
          chatId,
          attempt,
          current,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to configure HUNT Mini App menu button', {
          webAppUrl: normalizedWebAppUrl,
          chatId,
          attempt,
          error: message,
        });
      }

      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
      }
    }
  };

  // Configure the default menu button as HUNT so it exists even before a
  // private chat has produced a message. Also configure concrete private chats
  // to override any stale per-chat command-menu setting.
  void configureMenuButton();

  bot.on('message', (msg: Message) => {
    if (msg.chat.type === 'private' && msg.from) {
      void configureMenuButton(msg.chat.id);
    }
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

  logger.info('HUNT WebApp bridge installed', { webAppUrl: normalizedWebAppUrl });
}
