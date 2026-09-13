import TelegramBot, { Message, CallbackQuery } from 'node-telegram-bot-api';
import { DatabaseService } from '../database/DatabaseService';
import { RateLimiter } from '../utils/rateLimiter';
import { ParserFactory } from '../parsers/ParserFactory';
import { AdPresenter } from '../services/AdPresenter';
import { TelegramSender } from '../services/TelegramSender';
import { NewAdSelector } from '../services/NewAdSelector';
import { Ad, Platform } from '../types';
import { logger } from '../utils/logger';
import { mapError } from '../utils/errorMapper';
import { LinkAcceptance } from '../utils/linkAcceptance';
import { ParserScheduler } from '../scheduler/ParserScheduler';

export class BotHandler {
  private bot: TelegramBot;
  private db: DatabaseService;
  private rateLimiter: RateLimiter;
  private userStates: Map<number, string> = new Map();
  private adPresenter: AdPresenter;
  private telegramSender: TelegramSender;
  private pendingLinks: Map<number, string> = new Map();
  private scheduler: ParserScheduler | null = null;

  setScheduler(scheduler: ParserScheduler): void { this.scheduler = scheduler; }

  private normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      urlObj.hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
      urlObj.protocol = 'https:';
      return urlObj.toString();
    } catch {
      return url.toLowerCase();
    }
  }

  constructor(token: string, db: DatabaseService, scheduler?: ParserScheduler) {
    this.bot = new TelegramBot(token, { polling: true });
    this.db = db;
    this.rateLimiter = new RateLimiter(10, 60000);
    this.scheduler = scheduler ?? null;
    this.adPresenter = new AdPresenter();
    this.telegramSender = new TelegramSender(this.bot);
    this.setupHandlers();
  }

  // HUNT is the single UI entry point. Keep this as a keyboard-removal
  // payload because several legacy flows still call getMainKeyboard().
  private getMainKeyboard() {
    return { remove_keyboard: true } as TelegramBot.SendMessageOptions['reply_markup'];
  }

  private setupHandlers(): void {
    this.bot.on('message', async (msg: Message) => {
      if (!msg.from || !msg.text) return;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      if (!this.rateLimiter.isAllowed(userId)) {
        await this.bot.sendMessage(chatId, '⚠️ Слишком много запросов. Подождите минуту.'); return;
      }
      if (msg.text === '/start') await this.handleStart(chatId, userId, msg.from.username);
      else if (msg.text === '/clear' || msg.text === '🗑 Очистить объявления') await this.handleClearAds(chatId, userId);
      else if (msg.text === '/stats' || msg.text === '📊 Статистика') await this.handleStats(chatId, userId);
      else if (msg.text === '➕ Добавить ссылку') await this.handleAddLinkButton(chatId, userId);
      else if (msg.text === '📋 Мои ссылки') await this.handleMyLinks(chatId, userId);
      else if (msg.text === '🗑 Удалить все ссылки') await this.handleDeleteAllLinks(chatId, userId);
      else if (msg.text === '📺 Привязать канал') await this.handleAddChannel(chatId, userId);
      else if (msg.text === '📺 Отключить канал') await this.handleRemoveChannel(chatId, userId);
      else if (msg.text === '📺 Статус канала') await this.handleChannelStatus(chatId, userId);
      else if (msg.text.startsWith('/addchannel')) await this.handleAddChannelCommand(chatId, userId, msg.text);
      else if (msg.text === '/removechannel') await this.handleRemoveChannel(chatId, userId);
      else if (this.userStates.get(userId) === 'awaiting_url') await this.handleAddLink(chatId, userId, msg.text);
      else if (this.userStates.get(userId) === 'awaiting_channel') await this.handleAddChannelCommand(chatId, userId, msg.text);
      else if (msg.text.startsWith('http://') || msg.text.startsWith('https://')) await this.handleDirectLink(chatId, userId, msg.text);
    });

    this.bot.on('callback_query', async (query: CallbackQuery) => {
      if (!query.message || !query.from) return;
      const chatId = query.message.chat.id;
      const userId = query.from.id;
      const data = query.data;
      if (!this.rateLimiter.isAllowed(userId)) { await this.bot.answerCallbackQuery(query.id, { text: 'Слишком много запросов' }); return; }
      await this.bot.answerCallbackQuery(query.id);
      if (data === 'add_link') await this.handleAddLinkButton(chatId, userId);
      else if (data === 'my_links') await this.handleMyLinks(chatId, userId);
      else if (data?.startsWith('delete_')) {
        const linkId = parseInt(data.replace('delete_', ''), 10);
        if (Number.isSafeInteger(linkId) && linkId > 0) await this.handleDeleteLink(chatId, userId, linkId);
      } else if (data === 'delete_all') await this.handleDeleteAllLinks(chatId, userId);
      else if (data === 'confirm_delete_all') await this.handleConfirmDeleteAll(chatId, userId);
      else if (data === 'cancel_delete_all') await this.handleCancelDeleteAll(chatId);
      else if (data === 'confirm_clear_ads') await this.handleConfirmClearAds(chatId, userId);
      else if (data === 'cancel_clear_ads') await this.handleCancelClearAds(chatId);
      else if (data?.startsWith('check_')) {
        const linkId = parseInt(data.replace('check_', ''), 10);
        if (Number.isSafeInteger(linkId) && linkId > 0) await this.handleCheckLink(chatId, userId, linkId);
      } else if (data === 'confirm_add_link') await this.handleConfirmAddLink(chatId, userId);
      else if (data === 'cancel_add_link') await this.handleCancelAddLink(chatId, userId);
    });

    this.bot.on('polling_error', (error: Error) => logger.error('Telegram polling error', { error: error.message }));
    logger.info('Bot handlers initialized');
  }

  async handleStart(chatId: number, userId: number, username?: string): Promise<void> {
    try {
      await this.db.createUser(userId, username || null);
      await this.bot.sendMessage(chatId, '👋 Привет! HUNT отслеживает новые объявления на Kufar, Onliner и av.by.\n\nОткрой HUNT кнопкой ниже или через кнопку меню Telegram.', { reply_markup: this.getMainKeyboard() });
      logger.info('User started bot', { userId, username });
    } catch (error: any) {
      logger.error('Failed to handle /start', { userId, error: error.message });
      await this.bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.');
    }
  }

  async handleAddLinkButton(chatId: number, userId: number): Promise<void> {
    try {
      await this.db.createUser(userId, null);
      const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; }
      if (await this.db.getUserLinksCount(user.id) >= 10) { await this.bot.sendMessage(chatId, '⚠️ Достигнут лимит в 10 ссылок. Удалите старые ссылки.'); return; }
      this.userStates.set(userId, 'awaiting_url');
      await this.bot.sendMessage(chatId, '📎 Отправьте ссылку на страницу поиска с фильтрами:\n\n• Kufar.by - страница категории с фильтрами\n• Onliner.by - Барахолка, Авто, Недвижимость\n• av.by - страница поиска с фильтрами\n\n⚠️ Не отправляйте ссылки на конкретные объявления!', { reply_markup: this.getMainKeyboard() });
    } catch (error: any) {
      logger.error('Failed to handle add link button', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.');
    }
  }

  async handleAddLink(chatId: number, userId: number, url: string): Promise<void> {
    try {
      this.userStates.delete(userId);
      if (url === '❌ Отмена') { await this.bot.sendMessage(chatId, '❌ Отменено.', { reply_markup: this.getMainKeyboard() }); return; }
      url = this.normalizeUrl(url);
      const assessment = LinkAcceptance.assess(url);
      if (!assessment.ok || !assessment.platform) { await this.bot.sendMessage(chatId, `❌ ${assessment.reason || 'Некорректная ссылка'}\n\nПоддерживаются страницы поиска Kufar, Onliner и av.by.`); return; }
      await this.db.createUser(userId, null);
      const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; }
      const existingLinks = await this.db.getUserLinks(user.id);
      if (existingLinks.some(link => link.url === url)) { await this.bot.sendMessage(chatId, '⚠️ Эта ссылка уже добавлена!'); return; }
      await this.bot.sendMessage(chatId, '⏳ Проверяю ссылку...');
      const parser = ParserFactory.getParser(assessment.platform);
      if (!parser) { await this.bot.sendMessage(chatId, '❌ Парсер не найден.'); return; }
      let testAds: Ad[] = [];
      try {
        testAds = await parser.parseUrl(url);
        if (!testAds.length) { await this.bot.sendMessage(chatId, '❌ По этой ссылке не найдено объявлений.\n\nПопробуйте другую ссылку.'); return; }
      } catch (error: any) { logger.error('Failed to test parse link', { userId, url, error: error.message }); await this.bot.sendMessage(chatId, mapError(error)); return; }
      await this.db.createLink(user.id, url, assessment.platform);
      const platformEmoji: Record<Platform, string> = { kufar: '🟢', onliner: '🔵', av: '🚗' };
      await this.bot.sendMessage(chatId, `✅ Ссылка добавлена и работает!\n\n${platformEmoji[assessment.platform]} ${assessment.platform.toUpperCase()}\n${url}\n\nНайдено объявлений: ${testAds.length}\n\nВы получите уведомление о новых объявлениях.`, { reply_markup: this.getMainKeyboard() });
      if (this.scheduler) { logger.info('Triggering immediate parse after link add', { userId, url }); this.scheduler.triggerParse(); }
      const previewAds = NewAdSelector.pick(testAds, 5).reverse();
      await this.bot.sendMessage(chatId, `📋 Последние ${previewAds.length} объявлений:`);
      const formattedAds = await Promise.all(previewAds.map(ad => this.adPresenter.format(ad)));
      for (const formatted of formattedAds) await this.telegramSender.send(chatId, formatted);
      logger.info('Link added', { userId, platform: assessment.platform, url, adsFound: testAds.length });
    } catch (error: any) {
      logger.error('Failed to add link', { userId, url, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, mapError(error));
    }
  }

  async handleDirectLink(chatId: number, userId: number, url: string): Promise<void> {
    try {
      url = this.normalizeUrl(url);
      const assessment = LinkAcceptance.assess(url);
      if (!assessment.ok || !assessment.platform) { await this.bot.sendMessage(chatId, `❌ ${assessment.reason || 'Эта ссылка не поддерживается.'}`); return; }
      const parser = ParserFactory.getParser(assessment.platform);
      if (!parser) { await this.bot.sendMessage(chatId, '❌ Парсер не найден.'); return; }
      await this.db.createUser(userId, null);
      const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; }
      if (await this.db.getUserLinksCount(user.id) >= 10) { await this.bot.sendMessage(chatId, '⚠️ Достигнут лимит в 10 ссылок. Удалите старые ссылки.'); return; }
      const existingLinks = await this.db.getUserLinks(user.id);
      if (existingLinks.some(link => link.url === url)) { await this.bot.sendMessage(chatId, '⚠️ Эта ссылка уже добавлена в ваш список!'); return; }
      await this.bot.sendMessage(chatId, '⏳ Проверяю ссылку...');
      const testAds = await parser.parseUrl(url);
      if (!testAds.length) { await this.bot.sendMessage(chatId, '❌ По этой ссылке не найдено объявлений.'); return; }
      this.pendingLinks.set(userId, url);
      const platformEmoji: Record<Platform, string> = { kufar: '🟢', onliner: '🔵', av: '🚗' };
      await this.bot.sendMessage(chatId, `${platformEmoji[assessment.platform]} ${assessment.platform.toUpperCase()}\n${url}\n\nНайдено объявлений: ${testAds.length}`);
      const previewAds = NewAdSelector.pick(testAds, 5).reverse();
      await this.bot.sendMessage(chatId, '📋 5 самых свежих объявлений:');
      const formattedAds = await Promise.all(previewAds.map(ad => this.adPresenter.format(ad)));
      for (const formatted of formattedAds) await this.telegramSender.send(chatId, formatted);
      await this.bot.sendMessage(chatId, '❓ Хотите добавить эту ссылку для отслеживания новых объявлений?', { reply_markup: { inline_keyboard: [[{ text: '✅ Добавить эту ссылку', callback_data: 'confirm_add_link' }, { text: '❌ Отмена', callback_data: 'cancel_add_link' }]] } });
      logger.info('Direct link preview shown', { userId, platform: assessment.platform, url, adsFound: testAds.length });
    } catch (error: any) {
      logger.error('Failed to handle direct link', { userId, url, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, mapError(error));
    }
  }

  async handleConfirmAddLink(chatId: number, userId: number): Promise<void> {
    try {
      let url = this.pendingLinks.get(userId);
      if (!url) { await this.bot.sendMessage(chatId, '❌ Ссылка не найдена. Попробуйте отправить её снова.'); return; }
      url = this.normalizeUrl(url);
      const assessment = LinkAcceptance.assess(url);
      if (!assessment.ok || !assessment.platform) { await this.bot.sendMessage(chatId, '❌ Ошибка валидации ссылки.'); this.pendingLinks.delete(userId); return; }
      await this.db.createUser(userId, null);
      const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); this.pendingLinks.delete(userId); return; }
      if (await this.db.getUserLinksCount(user.id) >= 10) { await this.bot.sendMessage(chatId, '⚠️ Достигнут лимит в 10 ссылок.'); this.pendingLinks.delete(userId); return; }
      const existingLinks = await this.db.getUserLinks(user.id);
      if (existingLinks.some(link => link.url === url)) { await this.bot.sendMessage(chatId, '⚠️ Эта ссылка уже добавлена.'); this.pendingLinks.delete(userId); return; }
      await this.db.createLink(user.id, url, assessment.platform);
      this.pendingLinks.delete(userId);
      await this.bot.sendMessage(chatId, '✅ Ссылка добавлена! Вы будете получать уведомления о новых объявлениях.', { reply_markup: this.getMainKeyboard() });
      if (this.scheduler) { logger.info('Triggering immediate parse after direct link confirmation', { userId, url }); this.scheduler.triggerParse(); }
      logger.info('Link confirmed and added', { userId, platform: assessment.platform, url });
    } catch (error: any) {
      logger.error('Failed to confirm add link', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось добавить ссылку.'); this.pendingLinks.delete(userId);
    }
  }

  async handleCancelAddLink(chatId: number, userId: number): Promise<void> { try { this.pendingLinks.delete(userId); await this.bot.sendMessage(chatId, '❌ Добавление ссылки отменено.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to cancel add link', { userId, error: error.message }); } }

  async handleMyLinks(chatId: number, userId: number): Promise<void> {
    try {
      await this.db.createUser(userId, null); const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; }
      const links = await this.db.getUserLinks(user.id);
      if (!links.length) { await this.bot.sendMessage(chatId, '📋 У вас пока нет ссылок.', { reply_markup: { inline_keyboard: [[{ text: '➕ Добавить ссылку', callback_data: 'add_link' }]] } }); return; }
      const platformEmoji: Record<Platform, string> = { kufar: '🟢', onliner: '🔵', av: '🚗' };
      for (const link of links) {
        if (!platformEmoji[link.platform as Platform]) continue;
        const status = link.is_active ? '✅ Активна' : '❌ Неактивна';
        await this.bot.sendMessage(chatId, `${platformEmoji[link.platform as Platform]} ${link.platform.toUpperCase()}\n\n${link.url}\n\nСтатус: ${status}`, { reply_markup: { inline_keyboard: [[{ text: '🔍 Проверить', callback_data: `check_${link.id}` }, { text: '🗑 Удалить', callback_data: `delete_${link.id}` }]] } });
      }
    } catch (error: any) { logger.error('Failed to show links', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось загрузить ссылки.'); }
  }

  async handleDeleteLink(chatId: number, userId: number, linkId: number): Promise<void> {
    try {
      const link = await this.db.getLinkForUser(linkId, userId);
      if (!link) { await this.bot.sendMessage(chatId, '❌ Ссылка не найдена или уже удалена.'); return; }
      await this.db.deleteLink(linkId, userId);
      await this.bot.sendMessage(chatId, '✅ Ссылка удалена.');
      logger.info('Link deleted', { linkId, userId });
    } catch (error: any) { logger.error('Failed to delete link', { linkId, userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось удалить ссылку.'); }
  }

  async handleDeleteAllLinks(chatId: number, userId: number): Promise<void> {
    try {
      await this.db.createUser(userId, null); const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; }
      const links = await this.db.getUserLinks(user.id);
      if (!links.length) { await this.bot.sendMessage(chatId, '📋 У вас нет ссылок для удаления.'); return; }
      await this.bot.sendMessage(chatId, `⚠️ Вы уверены, что хотите удалить все ${links.length} ссылок?\n\nЭто действие нельзя отменить!`, { reply_markup: { inline_keyboard: [[{ text: '✅ Да, удалить все', callback_data: 'confirm_delete_all' }, { text: '❌ Отмена', callback_data: 'cancel_delete_all' }]] } });
    } catch (error: any) { logger.error('Failed to handle delete all links', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); }
  }

  async handleConfirmDeleteAll(chatId: number, userId: number): Promise<void> {
    try {
      const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; }
      const links = await this.db.getUserLinks(user.id); for (const link of links) await this.db.deleteLink(link.id, userId);
      await this.bot.sendMessage(chatId, `✅ Удалено ${links.length} ссылок.`, { reply_markup: this.getMainKeyboard() });
      logger.info('All links deleted', { userId, count: links.length });
    } catch (error: any) { logger.error('Failed to delete all links', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось удалить ссылки.'); }
  }

  async handleCancelDeleteAll(chatId: number): Promise<void> { try { await this.bot.sendMessage(chatId, '❌ Удаление отменено.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to cancel delete all', { error: error.message }); } }

  async handleConfirmClearAds(chatId: number, userId: number): Promise<void> {
    try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const deletedCount = await this.db.clearAdsByUserId(user.id); await this.bot.sendMessage(chatId, `✅ Очищено ${deletedCount} объявлений.\n\nБот начнёт заново отслеживать все объявления как новые.`, { reply_markup: this.getMainKeyboard() }); logger.info('Ads cleared', { userId, deletedCount }); }
    catch (error: any) { logger.error('Failed to confirm clear ads', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось очистить объявления.'); }
  }

  async handleCancelClearAds(chatId: number): Promise<void> { try { await this.bot.sendMessage(chatId, '❌ Очистка отменена.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to cancel clear ads', { userId: 'unknown', error: 'cancelled' }); } }

  async handleCheckLink(chatId: number, userId: number, linkId: number): Promise<void> {
    try {
      const link = await this.db.getLinkForUser(linkId, userId);
      if (!link) { await this.bot.sendMessage(chatId, '❌ Ссылка не найдена или вам недоступна.'); return; }
      await this.bot.sendMessage(chatId, '⏳ Проверяю ссылку...');
      const parser = ParserFactory.getParser(link.platform as Platform);
      if (!parser) { await this.bot.sendMessage(chatId, `❌ Парсер для платформы "${link.platform}" не найден.`); return; }
      const ads = await parser.parseUrl(link.url);
      const previewAds = NewAdSelector.pick(ads, 5).reverse();
      await this.bot.sendMessage(chatId, `📋 Найдено ${ads.length} объявлений. Показываю 5 самых свежих:`);
      const formattedAds = await Promise.all(previewAds.map(ad => this.adPresenter.format(ad)));
      for (const formatted of formattedAds) await this.telegramSender.send(chatId, formatted);
      logger.info('Link checked', { linkId, userId, adsFound: ads.length });
    } catch (error: any) { logger.error('Failed to check link', { linkId, userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, mapError(error)); }
  }

  async sendNotification(telegramId: number, ad: Ad): Promise<void> {
    try { const formatted = await this.adPresenter.format(ad); await this.telegramSender.send(telegramId, { ...formatted, text: `📢 Новое объявление!\n\n${formatted.text}` }); }
    catch (error: any) { if (error.response?.statusCode === 403) logger.warn('User blocked bot', { telegramId }); else logger.error('Failed to send notification', { telegramId, adId: ad.id, error: error.message }); }
  }

  async sendPriceDropNotification(telegramId: number, priceDrop: any): Promise<void> {
    try { const ad = await this.db.getAdByExternalId(priceDrop.externalId); if (!ad) return; const formatted = await this.adPresenter.format(ad); await this.telegramSender.send(telegramId, { ...formatted, text: `💰 СНИЖЕНИЕ ЦЕНЫ!\n\n${formatted.text}\n\n💸 Было: ${priceDrop.oldPrice}\n🆕 Стало: ${priceDrop.newPrice}\n📉 Изменение: ${priceDrop.changePercent}%` }); }
    catch (error: any) { logger.error('Failed to send price drop notification', { telegramId, adId: priceDrop.adId, error: error.message }); }
  }

  async handleAddChannel(chatId: number, userId: number): Promise<void> {
    try { await this.db.createUser(userId, null); await this.bot.sendMessage(chatId, '📺 Для привязки канала:\n\n1. Добавьте бота в канал как администратора\n2. Укажите ID канала в HUNT\n3. HUNT проверит права и включит публикацию.\n\nID обычно выглядит так: -1001234567890', { reply_markup: this.getMainKeyboard() }); this.userStates.set(userId, 'awaiting_channel'); }
    catch (error: any) { logger.error('Failed to handle add channel', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); }
  }

  async handleRemoveChannel(chatId: number, userId: number): Promise<void> {
    try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user) { await this.bot.sendMessage(chatId, '❌ Ошибка.', { reply_markup: this.getMainKeyboard() }); return; } await this.db.deactivateAllChannelSubscriptions(user.id); await this.bot.sendMessage(chatId, '✅ Канал отключён.\n\nТеперь уведомления будут приходить только в личку.', { reply_markup: this.getMainKeyboard() }); }
    catch (error: any) { logger.error('Failed to handle remove channel', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); }
  }

  async handleChannelStatus(chatId: number, userId: number): Promise<void> {
    try { let user = await this.db.getUser(userId); if (!user) { await this.db.createUser(userId, null); user = await this.db.getUser(userId); } if (!user) { await this.bot.sendMessage(chatId, '❌ Ошибка.', { reply_markup: this.getMainKeyboard() }); return; } const subscription = await this.db.getActiveChannelSubscription(user.id); if (!subscription) { await this.bot.sendMessage(chatId, '📺 Канал не привязан.\n\nОткрой HUNT → Канал для подключения.', { reply_markup: this.getMainKeyboard() }); return; } const channelInfo = subscription.channel_username ? `@${subscription.channel_username}` : `ID: ${subscription.channel_id}`; await this.bot.sendMessage(chatId, `📺 Привязанный канал:\n${channelInfo}\n\n${subscription.channel_title || ''}`, { reply_markup: this.getMainKeyboard() }); }
    catch (error: any) { logger.error('Failed to handle channel status', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); }
  }

  async handleAddChannelCommand(chatId: number, userId: number, text: string): Promise<void> {
    try { const match = text.match(/^\/addchannel\s+(-?\d+)/); if (!match) { await this.bot.sendMessage(chatId, '❌ Неверный формат.\n\nИспользуйте HUNT → Канал.', { reply_markup: this.getMainKeyboard() }); return; } const channelId = parseInt(match[1], 10); await this.db.createUser(userId, null); const dbUser = await this.db.getUser(userId); if (!dbUser) { await this.bot.sendMessage(chatId, '❌ Ошибка создания пользователя.', { reply_markup: this.getMainKeyboard() }); return; } await this.db.createChannelSubscription(dbUser.id, channelId, null, null); this.userStates.delete(userId); await this.bot.sendMessage(chatId, `✅ Канал ${channelId} привязан!\n\nТеперь уведомления будут приходить в канал и в личку.`, { reply_markup: this.getMainKeyboard() }); }
    catch (error: any) { logger.error('Failed to add channel', { userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`, { reply_markup: this.getMainKeyboard() }); }
  }

  async handleClearAds(chatId: number, userId: number): Promise<void> {
    try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } await this.bot.sendMessage(chatId, '🗑 Это удалит все сохранённые объявления из базы данных.\n\nСсылки останутся на месте, и бот начнёт заново отслеживать все объявления как новые.\n\nПродолжить?', { reply_markup: { inline_keyboard: [[{ text: '✅ Да, очистить объявления', callback_data: 'confirm_clear_ads' }, { text: '❌ Отмена', callback_data: 'cancel_clear_ads' }]] } }); }
    catch (error: any) { logger.error('Failed to handle /clear', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); }
  }

  async handleStats(chatId: number, userId: number): Promise<void> {
    try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const links = await this.db.getUserLinks(user.id); const stats = await this.db.getUserAdsCount(user.id); const totalAds = stats.reduce((sum, stat) => sum + stat.count, 0); const statsByLink = stats.map(stat => `  ${stat.linkPlatform.toUpperCase()}: ${stat.count} объявлений`); await this.bot.sendMessage(chatId, `📊 Статистика:\n\n🔗 Ссылок: ${links.length}\n📄 Всего объявлений в базе: ${totalAds}\n\n${statsByLink.length ? statsByLink.join('\n') : 'Нет данных'}`, { reply_markup: this.getMainKeyboard() }); }
    catch (error: any) { logger.error('Failed to handle /stats', { userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`); }
  }

  stop(): void { this.bot.stopPolling(); }
}
