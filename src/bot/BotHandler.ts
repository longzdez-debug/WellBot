import TelegramBot, { Message, CallbackQuery } from 'node-telegram-bot-api';
import { DatabaseService } from '../database/DatabaseService';
import { ParserFactory } from '../parsers/ParserFactory';
import { RateLimiter } from '../utils/rateLimiter';
import { AdPresenter } from '../services/AdPresenter';
import { NewAdSelector } from '../services/NewAdSelector';
import { TelegramSender } from '../services/TelegramSender';
import { Ad, Link, Platform } from '../types';
import { logger } from '../utils/logger';
import { mapError } from '../utils/errorMapper';
import { ParserScheduler } from '../scheduler/ParserScheduler';

export class BotHandler {
  private bot: TelegramBot;
  private db: DatabaseService;
  private rateLimiter: RateLimiter;
  private userStates: Map<number, string> = new Map();
  private adPresenter: AdPresenter;
  private telegramSender: TelegramSender;
  private scheduler: ParserScheduler | null = null;

  setScheduler(scheduler: ParserScheduler): void { this.scheduler = scheduler; }

  constructor(token: string, db: DatabaseService, scheduler?: ParserScheduler) {
    this.bot = new TelegramBot(token, { polling: true });
    this.db = db;
    this.rateLimiter = new RateLimiter(10, 60000);
    this.scheduler = scheduler ?? null;
    this.adPresenter = new AdPresenter();
    this.telegramSender = new TelegramSender(this.bot);
    this.setupHandlers();
  }

  private getMainKeyboard() {
    return { remove_keyboard: true } as TelegramBot.SendMessageOptions['reply_markup'];
  }

  private setupHandlers(): void {
    this.bot.on('message', async (msg: Message) => {
      if (!msg.from || !msg.text) return;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      if (!this.rateLimiter.isAllowed(userId)) { await this.bot.sendMessage(chatId, '⚠️ Слишком много запросов. Подождите минуту.'); return; }
      if (msg.text === '/start') await this.handleStart(chatId, userId, msg.from.username);
      else if (msg.text === '/clear' || msg.text === '🗑 Очистить объявления') await this.handleClearAds(chatId, userId);
      else if (msg.text === '/stats' || msg.text === '📊 Статистика') await this.handleStats(chatId, userId);
      else if (msg.text === '➕ Добавить монитор') await this.handleAddLinkButton(chatId, userId);
      else if (msg.text === '📋 Мои мониторы') await this.handleMyLinks(chatId, userId);
      else if (msg.text === '🗑 Удалить все мониторы') await this.handleDeleteAllLinks(chatId, userId);
      else if (msg.text === '📺 Привязать канал') await this.handleAddChannel(chatId, userId);
      else if (msg.text === '📺 Отключить канал') await this.handleRemoveChannel(chatId, userId);
      else if (msg.text === '📺 Статус канала') await this.handleChannelStatus(chatId, userId);
      else if (msg.text.startsWith('/addchannel')) await this.handleAddChannelCommand(chatId, userId, msg.text);
      else if (msg.text === '/removechannel') await this.handleRemoveChannel(chatId, userId);
      
      else if (this.userStates.get(userId) === 'awaiting_channel') await this.handleAddChannelCommand(chatId, userId, msg.text);
      
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
      else if (data?.startsWith('delete_')) { const linkId = parseInt(data.replace('delete_', ''), 10); if (Number.isSafeInteger(linkId) && linkId > 0) await this.handleDeleteLink(chatId, userId, linkId); }
      else if (data === 'delete_all') await this.handleDeleteAllLinks(chatId, userId);
      else if (data === 'confirm_delete_all') await this.handleConfirmDeleteAll(chatId, userId);
      else if (data === 'cancel_delete_all') await this.handleCancelDeleteAll(chatId);
      else if (data === 'confirm_clear_ads') await this.handleConfirmClearAds(chatId, userId);
      else if (data === 'cancel_clear_ads') await this.handleCancelClearAds(chatId);
      else if (data?.startsWith('check_')) { const linkId = parseInt(data.replace('check_', ''), 10); if (Number.isSafeInteger(linkId) && linkId > 0) await this.handleCheckLink(chatId, userId, linkId); }
    });

    this.bot.on('polling_error', (error: Error) => logger.error('Telegram polling error', { error: error.message }));
    logger.info('Bot handlers initialized');
  }

  async handleStart(chatId: number, userId: number, username?: string): Promise<void> {
    try {
      await this.db.createUser(userId, username || null);
      await this.bot.sendMessage(chatId, '👋 Привет! WellBOT отслеживает новые объявления.\n\nОткрой WellBOT через кнопку ⚡ WellBOT и создай радар через каталог категорий — URL больше не вводятся — всё выбирается в каталоге.', { reply_markup: this.getMainKeyboard() });
      logger.info('User started bot', { userId, username });
    } catch (error: any) { logger.error('Failed to handle /start', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.'); }
  }

  async handleAddLinkButton(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } if (await this.db.getUserLinksCount(user.id) >= 10) { await this.bot.sendMessage(chatId, '⚠️ Достигнут лимит в 10 мониторов.'); return; } this.userStates.delete(userId); await this.bot.sendMessage(chatId, '📂 Откройте WellBOT и выберите категорию, город и фильтры.\n\nWellBOT сам создаст и запустит мониторинг — ссылки больше не нужны.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to handle add link button', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); } }

  async handleMyLinks(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const links = await this.db.getUserLinks(user.id); if (!links.length) { await this.bot.sendMessage(chatId, '📋 У вас пока нет мониторов.', { reply_markup: { inline_keyboard: [[{ text: '➕ Добавить монитор', callback_data: 'add_link' }]] } }); return; } const platformEmoji: Record<Platform, string> = { kufar: '🟢', onliner: '🔵', av: '🚗' }; for (const link of links) { if (!platformEmoji[link.platform as Platform]) continue; const status = link.is_active ? '✅ Активна' : '❌ Неактивна'; const config = (link as Link & { config?: any }).config || {}; const category = typeof config.subcategoryId === 'string' ? config.subcategoryId : typeof config.categoryId === 'string' ? config.categoryId : 'Каталог'; const scope = [config.city, config.region].filter(Boolean).join(' · ') || 'Вся Беларусь'; const filters = [config.query, config.minPrice != null ? `от ${config.minPrice}` : '', config.maxPrice != null ? `до ${config.maxPrice}` : '', config.condition === 'new' ? 'Новое' : config.condition === 'used' ? 'Б/у' : '', config.seller === 'company' ? 'Компания' : config.seller === 'private' ? 'Частное лицо' : ''].filter(Boolean).join(' · '); await this.bot.sendMessage(chatId, `${platformEmoji[link.platform as Platform]} ${link.platform.toUpperCase()}\n\n📂 ${category}\n📍 ${scope}${filters ? `\n🔎 ${filters}` : ''}\n\nСтатус: ${status}`, { reply_markup: { inline_keyboard: [[{ text: '🔍 Проверить', callback_data: `check_${link.id}` }, { text: '🗑 Удалить', callback_data: `delete_${link.id}` }]] } }); } } catch (error: any) { logger.error('Failed to show monitors', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось загрузить мониторы.'); } }

  async handleDeleteLink(chatId: number, userId: number, linkId: number): Promise<void> { try { const link = await this.db.getLinkForUser(linkId, userId); if (!link) { await this.bot.sendMessage(chatId, '❌ Монитор не найдена или уже удалена.'); return; } await this.db.deleteLink(linkId, userId); await this.bot.sendMessage(chatId, '✅ Монитор удалена.'); logger.info('Link deleted', { linkId, userId }); } catch (error: any) { logger.error('Failed to delete link', { linkId, userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось удалить ссылку.'); } }

  async handleDeleteAllLinks(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const links = await this.db.getUserLinks(user.id); if (!links.length) { await this.bot.sendMessage(chatId, '📋 У вас нет мониторов для удаления.'); return; } await this.bot.sendMessage(chatId, `⚠️ Вы уверены, что хотите удалить все ${links.length} мониторов?\n\nЭто действие нельзя отменить!`, { reply_markup: { inline_keyboard: [[{ text: '✅ Да, удалить все', callback_data: 'confirm_delete_all' }, { text: '❌ Отмена', callback_data: 'cancel_delete_all' }]] } }); } catch (error: any) { logger.error('Failed to handle delete all links', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); } }

  async handleConfirmDeleteAll(chatId: number, userId: number): Promise<void> { try { const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const links = await this.db.getUserLinks(user.id); for (const link of links) await this.db.deleteLink(link.id, userId); await this.bot.sendMessage(chatId, `✅ Удалено ${links.length} мониторов.`, { reply_markup: this.getMainKeyboard() }); logger.info('All links deleted', { userId, count: links.length }); } catch (error: any) { logger.error('Failed to delete all monitors', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось удалить ссылки.'); } }

  async handleCancelDeleteAll(chatId: number): Promise<void> { try { await this.bot.sendMessage(chatId, '❌ Удаление отменено.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to cancel delete all', { error: 'cancelled' }); } }

  async handleConfirmClearAds(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const deletedCount = await this.db.clearAdsByUserId(user.id); await this.bot.sendMessage(chatId, `✅ Очищено ${deletedCount} объявлений.\n\nБот начнёт заново отслеживать все объявления как новые.`, { reply_markup: this.getMainKeyboard() }); logger.info('Ads cleared', { userId, deletedCount }); } catch (error: any) { logger.error('Failed to confirm clear ads', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось очистить объявления.'); } }

  async handleCancelClearAds(chatId: number): Promise<void> { try { await this.bot.sendMessage(chatId, '❌ Очистка отменена.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to cancel clear ads', { error: 'cancelled' }); } }

  async handleCheckLink(chatId: number, userId: number, linkId: number): Promise<void> { try { const link = await this.db.getLinkForUser(linkId, userId); if (!link) { await this.bot.sendMessage(chatId, '❌ Монитор не найдена или вам недоступна.'); return; } await this.bot.sendMessage(chatId, '⏳ Проверяю монитор...'); const parser = ParserFactory.getParser(link.platform as Platform); if (!parser) { await this.bot.sendMessage(chatId, `❌ Парсер для платформы "${link.platform}" не найден.`); return; } const ads = await parser.parseUrl(link.url); const previewAds = NewAdSelector.pick(ads, 5).reverse(); await this.bot.sendMessage(chatId, `📋 Найдено ${ads.length} объявлений. Показываю 5 самых свежих:`); const formattedAds = await Promise.all(previewAds.map(ad => this.adPresenter.format(ad))); for (const formatted of formattedAds) await this.telegramSender.send(chatId, formatted); logger.info('Link checked', { linkId, userId, adsFound: ads.length }); } catch (error: any) { logger.error('Failed to check link', { linkId, userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, mapError(error)); } }

  async sendNotification(telegramId: number, ad: Ad): Promise<void> { try { const formatted = await this.adPresenter.format(ad); const market = ad.market_status === 'below_market' ? `🟢 НИЖЕ РЫНКА${ad.market_percent != null ? ` · ${Math.abs(ad.market_percent).toFixed(1)}%` : ''}` : ad.market_status === 'above_market' ? `🔴 ВЫШЕ РЫНКА${ad.market_percent != null ? ` · +${ad.market_percent.toFixed(1)}%` : ''}` : ad.market_status === 'market' ? `⚪ В РЫНКЕ${ad.market_percent != null ? ` · ${ad.market_percent >= 0 ? '+' : ''}${ad.market_percent.toFixed(1)}%` : ''}` : ''; const marketLine = market ? `\n${market}${ad.market_median != null ? ` · медиана ${ad.market_median}` : ''}` : ''; await this.telegramSender.send(telegramId, { ...formatted, text: `📢 Новое объявление!${marketLine}\n\n${formatted.text}` }); } catch (error: any) { if (error.response?.statusCode === 403) logger.warn('User blocked bot', { telegramId }); else logger.error('Failed to send notification', { telegramId, adId: ad.id, error: error.message }); } }

  async sendPriceDropNotification(telegramId: number, priceDrop: any): Promise<void> { try { const ad = await this.db.getAdByExternalId(priceDrop.externalId); if (!ad) return; const formatted = await this.adPresenter.format(ad); await this.telegramSender.send(telegramId, { ...formatted, text: `💰 СНИЖЕНИЕ ЦЕНЫ!\n\n${formatted.text}\n\n💸 Было: ${priceDrop.oldPrice}\n🆕 Стало: ${priceDrop.newPrice}\n📉 Изменение: ${priceDrop.changePercent}%` }); } catch (error: any) { logger.error('Failed to send price drop notification', { telegramId, adId: priceDrop.adId, error: error.message }); } }

  async handleAddChannel(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); await this.bot.sendMessage(chatId, '📺 Для привязки канала:\n\n1. Добавьте бота в канал как администратора\n2. Укажите ID канала в WellBOT\n3. WellBOT проверит права и включит публикацию.\n\nID обычно выглядит так: -1001234567890', { reply_markup: this.getMainKeyboard() }); this.userStates.set(userId, 'awaiting_channel'); } catch (error: any) { logger.error('Failed to handle add channel', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); } }

  async handleRemoveChannel(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user) { await this.bot.sendMessage(chatId, '❌ Ошибка.', { reply_markup: this.getMainKeyboard() }); return; } await this.db.deactivateAllChannelSubscriptions(user.id); await this.bot.sendMessage(chatId, '✅ Канал отключён.\n\nТеперь уведомления будут приходить только в личку.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to handle remove channel', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); } }

  async handleChannelStatus(chatId: number, userId: number): Promise<void> { try { let user = await this.db.getUser(userId); if (!user) { await this.db.createUser(userId, null); user = await this.db.getUser(userId); } if (!user) { await this.bot.sendMessage(chatId, '❌ Ошибка.', { reply_markup: this.getMainKeyboard() }); return; } const subscription = await this.db.getActiveChannelSubscription(user.id); if (!subscription) { await this.bot.sendMessage(chatId, '📺 Канал не привязан.\n\nОткрой WellBOT → Канал для подключения.', { reply_markup: this.getMainKeyboard() }); return; } const channelInfo = subscription.channel_username ? `@${subscription.channel_username}` : `ID: ${subscription.channel_id}`; await this.bot.sendMessage(chatId, `📺 Привязанный канал:\n${channelInfo}\n\n${subscription.channel_title || ''}`, { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to handle channel status', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); } }

  async handleAddChannelCommand(chatId: number, userId: number, text: string): Promise<void> { try { const match = text.match(/^\/addchannel\s+(-?\d+)/); if (!match) { await this.bot.sendMessage(chatId, '❌ Неверный формат.\n\nИспользуйте WellBOT → Канал.', { reply_markup: this.getMainKeyboard() }); return; } const channelId = parseInt(match[1], 10); await this.db.createUser(userId, null); const dbUser = await this.db.getUser(userId); if (!dbUser) { await this.bot.sendMessage(chatId, '❌ Ошибка создания пользователя.', { reply_markup: this.getMainKeyboard() }); return; } await this.db.createChannelSubscription(dbUser.id, channelId, null, null); this.userStates.delete(userId); await this.bot.sendMessage(chatId, `✅ Канал ${channelId} привязан!\n\nТеперь уведомления будут приходить в канал и в личку.`, { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to add channel', { userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`, { reply_markup: this.getMainKeyboard() }); } }

  async handleClearAds(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } await this.bot.sendMessage(chatId, '🗑 Это удалит все сохранённые объявления из базы данных.\n\nМониторы останутся на месте, и бот начнёт заново отслеживать все объявления как новые.\n\nПродолжить?', { reply_markup: { inline_keyboard: [[{ text: '✅ Да, очистить объявления', callback_data: 'confirm_clear_ads' }, { text: '❌ Отмена', callback_data: 'cancel_clear_ads' }]] } }); } catch (error: any) { logger.error('Failed to handle /clear', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); } }

  async handleStats(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const links = await this.db.getUserLinks(user.id); const stats = await this.db.getUserAdsCount(user.id); const totalAds = stats.reduce((sum, stat) => sum + stat.count, 0); const statsByLink = stats.map(stat => `  ${stat.linkPlatform.toUpperCase()}: ${stat.count} объявлений`); await this.bot.sendMessage(chatId, `📊 Статистика:\n\n🎯 Мониторов: ${links.length}\n📄 Всего объявлений в базе: ${totalAds}\n\n${statsByLink.length ? statsByLink.join('\n') : 'Нет данных'}`, { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to handle /stats', { userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`); } }

  stop(): void { this.bot.stopPolling(); }
}
