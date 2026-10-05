import { logger } from '../utils/logger';

export interface TelegramUser { id: number; username?: string; first_name?: string; }
export interface TelegramChat { id: number; }
export interface TelegramMessage { message_id: number; chat: TelegramChat; from?: TelegramUser; text?: string; }
export interface TelegramCallbackQuery { id: string; from: TelegramUser; message?: TelegramMessage; data?: string; }

export interface TelegramSendOptions { reply_markup?: unknown; parse_mode?: string; caption?: string; }
export interface TelegramInlineKeyboardMarkup { inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>; }
export interface TelegramInputMediaPhoto { type: 'photo'; media: string; caption?: string; parse_mode?: string; }

type Handler<T> = (payload: T) => void | Promise<void>;

class TelegramApiError extends Error {
  readonly response: { statusCode: number; body: unknown };
  constructor(statusCode: number, body: unknown) {
    super(`Telegram API error ${statusCode}`);
    this.name = 'TelegramApiError';
    this.response = { statusCode, body };
  }
}

export class TelegramBotClient {
  private readonly baseUrl: string;
  private polling = true;
  private offset = 0;
  private controller = new AbortController();
  private readonly handlers = new Map<string, Array<Handler<unknown>>>();

  constructor(token: string, options: { polling?: boolean } = {}) {
    if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('invalid_telegram_token');
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    if (options.polling !== false) void this.poll();
  }

  on<T>(event: string, handler: Handler<T>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Handler<unknown>);
    this.handlers.set(event, list);
  }

  private async emit<T>(event: string, payload: T): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload);
  }

  private async api<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = { ok: false, description: 'invalid_json_response' }; }
    if (!response.ok || !(payload as { ok?: boolean })?.ok) {
      const errorBody = payload && typeof payload === 'object' ? payload : { description: 'telegram_request_failed' };
      const statusCode = response.status;
      throw new TelegramApiError(statusCode, errorBody);
    }
    return (payload as { result: T }).result;
  }

  async sendMessage(chatId: number, text: string, options: TelegramSendOptions = {}): Promise<TelegramMessage> {
    return this.api<TelegramMessage>('sendMessage', { chat_id: chatId, text, ...options });
  }

  async sendPhoto(chatId: number, photo: string, options: TelegramSendOptions = {}): Promise<TelegramMessage> {
    return this.api<TelegramMessage>('sendPhoto', { chat_id: chatId, photo, ...options });
  }

  async sendMediaGroup(chatId: number, media: TelegramInputMediaPhoto[]): Promise<TelegramMessage[]> {
    return this.api<TelegramMessage[]>('sendMediaGroup', { chat_id: chatId, media });
  }

  async answerCallbackQuery(id: string, options: { text?: string } = {}): Promise<boolean> {
    return this.api<boolean>('answerCallbackQuery', { callback_query_id: id, ...options });
  }

  stopPolling(): void {
    this.polling = false;
    this.controller.abort();
  }

  private async poll(): Promise<void> {
    while (this.polling) {
      try {
        const updates = await this.api<Array<{ update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }>>(
          'getUpdates',
          { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          this.controller.signal,
        );
        for (const update of updates ?? []) {
          this.offset = update.update_id + 1;
          if (update.message) await this.emit('message', update.message);
          if (update.callback_query) await this.emit('callback_query', update.callback_query);
        }
      } catch (error: unknown) {
        if (!this.polling) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        await this.emit('polling_error', error instanceof Error ? error : new Error(String(error)));
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}

export { TelegramApiError };
