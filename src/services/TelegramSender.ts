import TelegramBot from 'node-telegram-bot-api';
import { FormattedAd } from './AdPresenter';
import { logger } from '../utils/logger';

export class TelegramSender {
  private bot: TelegramBot;
  private readonly lastSendByChat: Map<number, number> = new Map();
  private readonly retryAfterByChat: Map<number, number> = new Map();
  private readonly MIN_CHAT_INTERVAL_MS = 1050;
  private readonly GLOBAL_MIN_INTERVAL_MS = 35;
  private lastGlobalSendTime = 0;
  private rateLimitQueue: Promise<void> = Promise.resolve();
  private readonly MAX_MEDIA_PER_GROUP = 10;
  private readonly MAX_CAPTION_LENGTH = 1024;
  private readonly MAX_RETRIES = 3;

  constructor(bot: TelegramBot) {
    this.bot = bot;
  }

  private async waitForRateLimit(chatId: number): Promise<void> {
    // Serialize only the short rate-limit reservation section. This prevents
    // concurrent sends for different chats from racing on the global timestamp
    // without serializing the actual Telegram network requests.
    let release!: () => void;
    const previous = this.rateLimitQueue;
    this.rateLimitQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;

    try {
      const now = Date.now();
      const retryUntil = this.retryAfterByChat.get(chatId) ?? 0;
      const chatUntil = (this.lastSendByChat.get(chatId) ?? 0) + this.MIN_CHAT_INTERVAL_MS;
      const globalUntil = this.lastGlobalSendTime + this.GLOBAL_MIN_INTERVAL_MS;
      const waitUntil = Math.max(now, retryUntil, chatUntil, globalUntil);

      if (waitUntil > now) {
        await new Promise(resolve => setTimeout(resolve, waitUntil - now));
      }

      const sentAt = Date.now();
      this.lastSendByChat.set(chatId, sentAt);
      this.lastGlobalSendTime = sentAt;
    } finally {
      release();
    }
  }

  private truncateCaption(text: string): string {
    if (text.length <= this.MAX_CAPTION_LENGTH) return text;
    logger.warn('Caption too long, truncating', { originalLength: text.length, maxLength: this.MAX_CAPTION_LENGTH });
    return text.slice(0, this.MAX_CAPTION_LENGTH);
  }

  private getStatusCode(error: any): number | undefined {
    return error?.response?.statusCode;
  }

  private getRetryAfter(error: any): number {
    const value = Number(error?.response?.body?.parameters?.retry_after ?? error?.response?.body?.retry_after ?? 1);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 30) : 1;
  }

  private async sendOnce(chatId: number, formatted: FormattedAd): Promise<void> {
    await this.waitForRateLimit(chatId);

    if (formatted.media && formatted.media.length >= 1) {
      const mediaToSend = formatted.media.slice(0, this.MAX_MEDIA_PER_GROUP);
      const caption = this.truncateCaption(formatted.text);
      const inputMedia: TelegramBot.InputMediaPhoto[] = mediaToSend.map((url, index) => ({
        type: 'photo',
        media: url,
        caption: index === 0 ? caption : undefined,
        parse_mode: index === 0 ? 'HTML' : undefined,
      }));

      try {
        await this.bot.sendMediaGroup(chatId, inputMedia);
      } catch (error: any) {
        const statusCode = this.getStatusCode(error);
        if (statusCode === 400) {
          logger.warn('Media group rejected, falling back to text notification', {
            chatId,
            error: error?.response?.body?.description || error.message,
          });
          await this.bot.sendMessage(chatId, formatted.text, { parse_mode: 'HTML' });
          return;
        }
        throw error;
      }
      return;
    }

    await this.bot.sendMessage(chatId, formatted.text, { parse_mode: 'HTML' });
  }

  async send(chatId: number, formatted: FormattedAd): Promise<void> {
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt += 1) {
      try {
        await this.sendOnce(chatId, formatted);
        return;
      } catch (error: any) {
        const statusCode = this.getStatusCode(error);
        if (statusCode === 429 && attempt < this.MAX_RETRIES) {
          const retryAfter = this.getRetryAfter(error);
          this.retryAfterByChat.set(chatId, Date.now() + retryAfter * 1000);
          logger.warn('Telegram rate limited, retrying', { chatId, retryAfter, attempt: attempt + 1 });
          continue;
        }

        if (statusCode === 403) {
          logger.warn('User blocked the bot', { chatId });
          return;
        }

        logger.error('Failed to send Telegram message', {
          chatId,
          error: error.message,
          statusCode,
        });
        throw error;
      }
    }
  }

  async sendBatch(chatId: number, ads: FormattedAd[]): Promise<void> {
    for (const ad of ads) {
      await this.send(chatId, ad);
    }
  }
}
