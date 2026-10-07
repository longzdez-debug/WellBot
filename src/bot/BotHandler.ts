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
import { analyzeDeal } from '../services/DealScoreEngine';

export class BotHandler {
  private bot: TelegramBot;
  private db: DatabaseService;
  private rateLimiter: RateLimiter;
  private adPresenter: AdPresenter;
  private telegramSender: TelegramSender;
  constructor(token: string, db: DatabaseService) {
    this.bot = new TelegramBot(token, { polling: true });
    this.db = db;
    this.rateLimiter = new RateLimiter(10, 60000);
    this.adPresenter = new AdPresenter();
    this.telegramSender = new TelegramSender(this.bot);
    this.setupHandlers();
  }

  private getMainKeyboard() {
    const webAppUrl = process.env.WELLBOT_WEBAPP_URL || process.env.WEBAPP_URL || process.env.PUBLIC_URL || '';
    const keyboard: any[][] = [];
    if (/^https:\/\//i.test(webAppUrl)) {
      keyboard.push([{ text: '🚀 Открыть WellBOT', web_app: { url: webAppUrl } }]);
    }
    keyboard.push(
      [{ text: '📋 Мои поиски', callback_data: 'my_links' }, { text: '➕ Добавить поиск', callback_data: 'add_link' }],
      [{ text: '🔥 Выгодные находки', callback_data: 'open_deals' }],
      [{ text: '👑 WellBOT PRO', callback_data: 'open_pro' }, { text: '📊 Статистика', callback_data: 'open_stats' }],
    );
    return { inline_keyboard: keyboard } as TelegramBot.SendMessageOptions['reply_markup'];
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
      else if (msg.text === '➕ Добавить поиск') await this.handleAddLinkButton(chatId, userId);
      else if (msg.text === '📋 Мои поиски') await this.handleMyLinks(chatId, userId);
      else if (msg.text === '🔥 Выгодные находки') await this.handleDeals(chatId, userId);
      else if (msg.text === '🗑 Удалить все поиски') await this.handleDeleteAllLinks(chatId, userId);
      else if (msg.text === '/pro' || msg.text === '👑 WellBOT PRO') await this.sendProInvoice(chatId, userId);
      else if (msg.text === '/terms') await this.bot.sendMessage(chatId, 'Условия WellBOT PRO: подписка оплачивается в Telegram Stars, срок — 30 дней с автоматическим продлением. Для вопросов по оплате используйте /paysupport.');
      else if (msg.text === '/paysupport') await this.bot.sendMessage(chatId, 'Поддержка оплаты WellBOT PRO: укажите время платежа и Telegram ID. Мы проверим платёж и статус подписки.');
      
    });

    this.bot.on('callback_query', async (query: CallbackQuery) => {
      if (!query.message || !query.from) return;
      const chatId = query.message.chat.id;
      const userId = query.from.id;
      const data = query.data;
      if (!this.rateLimiter.isAllowed(userId)) { await this.bot.answerCallbackQuery(query.id, { text: 'Слишком много запросов' }); return; }
      let callbackText: string | undefined;
      try {
        if (data === 'add_link') { callbackText = 'Открываю добавление поиска'; await this.handleAddLinkButton(chatId, userId); }
        else if (data === 'my_links') { callbackText = 'Загружаю поиски'; await this.handleMyLinks(chatId, userId); }
        else if (data === 'open_pro') { callbackText = 'Проверяю PRO'; await this.sendProInvoice(chatId, userId); }
        else if (data === 'open_stats') { callbackText = 'Загружаю статистику'; await this.handleStats(chatId, userId); }
        else if (data === 'open_deals') { callbackText = 'Ищу выгодные объявления'; await this.handleDeals(chatId, userId); }
        else if (data?.startsWith('dismiss_ad_')) { const adId = parseInt(data.replace('dismiss_ad_', ''), 10); if (Number.isSafeInteger(adId) && adId > 0) { callbackText = 'Объявление скрыто'; await this.handleDismissAd(chatId, userId, adId, query.message.message_id); } }
        else if (data?.startsWith('delete_')) { const linkId = parseInt(data.replace('delete_', ''), 10); if (Number.isSafeInteger(linkId) && linkId > 0) { callbackText = 'Поиск удалён'; await this.handleDeleteLink(chatId, userId, linkId); } }
        else if (data === 'delete_all') { callbackText = 'Проверяю поиски'; await this.handleDeleteAllLinks(chatId, userId); }
        else if (data === 'confirm_delete_all') { callbackText = 'Удаляю поиски'; await this.handleConfirmDeleteAll(chatId, userId); }
        else if (data === 'cancel_delete_all') { callbackText = 'Удаление отменено'; await this.handleCancelDeleteAll(chatId); }
        else if (data === 'confirm_clear_ads') { callbackText = 'Очищаю объявления'; await this.handleConfirmClearAds(chatId, userId); }
        else if (data === 'cancel_clear_ads') { callbackText = 'Отмена'; await this.handleCancelClearAds(chatId); }
        else if (data?.startsWith('check_')) { const linkId = parseInt(data.replace('check_', ''), 10); if (Number.isSafeInteger(linkId) && linkId > 0) { callbackText = 'Проверяю поиск'; await this.handleCheckLink(chatId, userId, linkId); } }
      } finally {
        try { await this.bot.answerCallbackQuery(query.id, callbackText ? { text: callbackText } : undefined); } catch {}
      }
    });

    this.bot.on('pre_checkout_query', async (query: any) => {
      try {
        const expectedPrice=Math.min(10000,Math.max(1,Math.floor(Number(process.env.WELLBOT_PRO_PRICE_STARS||'199'))));
        const payload=String(query.invoice_payload||'');
        const parts=payload.split(':');
        const payloadUserId=Number(parts[1]);
        const issuedAt=Number(parts[2]);
        const payloadFresh=Number.isSafeInteger(issuedAt)&&issuedAt>0&&Math.abs(Date.now()-issuedAt)<24*60*60*1000;
        const payloadOwned=Number.isSafeInteger(payloadUserId)&&payloadUserId>0&&(!query.from?.id||Number(query.from.id)===payloadUserId);
        if(parts.length!==3||parts[0]!=='wellbot_pro_monthly_v1'||!payloadOwned||!payloadFresh||query.currency!=='XTR'||Number(query.total_amount)!==expectedPrice){await (this.bot as any).answerPreCheckoutQuery(query.id,false,{error_message:'Счёт WellBOT PRO недействителен или устарел.'});return;}
        await (this.bot as any).answerPreCheckoutQuery(query.id,true);
      }catch(error){logger.error('PRO pre-checkout failed',{error:error instanceof Error?error.message:String(error)});try{await (this.bot as any).answerPreCheckoutQuery(query.id,false,{error_message:'Не удалось проверить оплату. Попробуйте ещё раз.'});}catch{}}
    });
    this.bot.on('message', async (msg: Message) => {
      const payment=(msg as Message & {successful_payment?:any}).successful_payment;if(!payment)return;
      const payload=String(payment.invoice_payload||'');
      const payloadParts=payload.split(':');
      const payloadUserId=Number(payloadParts[1]);
      if(payloadParts.length!==3||payloadParts[0]!=='wellbot_pro_monthly_v1'||!Number.isSafeInteger(payloadUserId)||payloadUserId<=0||payment.currency!=='XTR')return;
      if (msg.from?.id && payloadUserId !== msg.from.id) {
        logger.warn('Ignoring PRO payment with mismatched user payload',{telegramId:msg.from.id,chatId:msg.chat.id,payload});
        return;
      }
      try{
        const telegramChargeId=String(payment.telegram_payment_charge_id||'');
        if(!telegramChargeId){ logger.warn('PRO payment missing Telegram charge id',{telegramId:msg.from?.id||msg.chat.id}); return; }
        const paymentUserId=msg.from?.id||msg.chat.id;
        const starsAmount=Number(payment.total_amount||0);
        const expiry=payment.subscription_expiration_date?new Date(Number(payment.subscription_expiration_date)*1000):new Date(Date.now()+30*24*60*60*1000);
        const expiresAt=Number.isFinite(expiry.getTime())?expiry:new Date(Date.now()+30*24*60*60*1000);
        const claimed=await this.db.activateProFromTelegramPayment(paymentUserId,expiresAt,Number.isSafeInteger(starsAmount)?starsAmount:0,telegramChargeId,payment.provider_payment_charge_id?String(payment.provider_payment_charge_id):null,payload);
\n        if(!claimed){ logger.info('Ignoring duplicate PRO payment confirmation',{telegramId:paymentUserId,chargeId:telegramChargeId}); return; }
        await this.bot.sendMessage(msg.chat.id,'👑 WellBOT PRO активирован до '+expiresAt.toLocaleDateString('ru-RU')+'.');
        logger.info('WellBOT PRO payment confirmed',{telegramId:msg.from?.id||msg.chat.id,chargeId:payment.telegram_payment_charge_id,expiresAt:expiresAt.toISOString(),recurring:Boolean(payment.is_recurring)});
      }catch(error){logger.error('Failed to activate PRO after payment',{telegramId:msg.from?.id||msg.chat.id,error:error instanceof Error?error.message:String(error)});}
    });
    this.bot.on('polling_error', (error: Error) => logger.error('Telegram polling error', { error: error.message }));
    logger.info('Bot handlers initialized');
  }

  async sendProInvoice(chatId:number,userId:number):Promise<void>{
    try{
      const priceStars=Math.min(10000,Math.max(1,Math.floor(Number(process.env.WELLBOT_PRO_PRICE_STARS||'199'))));
      const current=await this.db.getProSubscription(userId);
      if(current?.status==='active'){await this.bot.sendMessage(chatId,'👑 WellBOT PRO уже активен до '+current.expiresAt.toLocaleDateString('ru-RU')+'.');return;}
      const payload='wellbot_pro_monthly_v1:'+userId+':'+Date.now();
      await (this.bot as any).sendInvoice(chatId,'WellBOT PRO','Умный Deal Score, расширенная аналитика рынка, быстрые находки и PRO-возможности.',payload,'','XTR',[{label:'WellBOT PRO — 30 дней',amount:priceStars}],{subscription_period:2592000,terms_url:process.env.WELLBOT_TERMS_URL||undefined});
      logger.info('WellBOT PRO invoice sent',{telegramId:userId,priceStars});
    }catch(error){logger.error('Failed to send PRO invoice',{telegramId:userId,error:error instanceof Error?error.message:String(error)});await this.bot.sendMessage(chatId,'❌ Не удалось создать счёт PRO. Попробуйте ещё раз позже.');}
  }

  async handleStart(chatId: number, userId: number, username?: string): Promise<void> {
    try {
      await this.db.createUser(userId, username || null);
      await this.bot.sendMessage(chatId, '👋 Добро пожаловать в WellBOT!\n\nWellBOT автоматически отслеживает новые объявления на Kufar, Onliner и AV.BY и присылает интересные находки прямо сюда.\n\n🎯 Что умеет:\n• искать по полным категориям и подкатегориям\n• фильтровать по цене, городу и условиям\n• находить предложения ниже рынка\n• отслеживать новые объявления без ручной проверки\n\n⚡ Открой WellBOT кнопкой ниже и создай свой первый монитор. Всё остальное сделает бот.', { reply_markup: this.getMainKeyboard() });
      logger.info('User started bot', { userId, username });
    } catch (error: any) { logger.error('Failed to handle /start', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.'); }
  }

  async handleAddLinkButton(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } if (await this.db.getUserLinksCount(user.id) >= 50) { await this.bot.sendMessage(chatId, '⚠️ Достигнут лимит в 50 поисков.'); return; }  await this.bot.sendMessage(chatId, '📂 Откройте WellBOT и выберите категорию, город и фильтры.\n\nWellBOT сам создаст и запустит поиск — ссылки больше не нужны.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to handle add link button', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); } }

  async handleMyLinks(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const links = await this.db.getUserLinks(user.id); if (!links.length) { await this.bot.sendMessage(chatId, '📋 У вас пока нет поисков.', { reply_markup: { inline_keyboard: [[{ text: '➕ Добавить поиск', callback_data: 'add_link' }]] } }); return; } const platformEmoji: Record<Platform, string> = { kufar: '🟢', onliner: '🔵', av: '🚗' }; for (const link of links) { if (!platformEmoji[link.platform as Platform]) continue; const status = link.is_active ? '✅ Активна' : '❌ Неактивна'; const config = (link as Link & { config?: any }).config || {}; const category = typeof config.subcategoryId === 'string' ? config.subcategoryId : typeof config.categoryId === 'string' ? config.categoryId : 'Каталог'; const scope = [config.city, config.region].filter(Boolean).join(' · ') || 'Вся Беларусь'; const filters = [config.query, config.minPrice != null ? `от ${config.minPrice}` : '', config.maxPrice != null ? `до ${config.maxPrice}` : '', config.condition === 'new' ? 'Новое' : config.condition === 'used' ? 'Б/у' : '', config.seller === 'company' ? 'Компания' : config.seller === 'private' ? 'Частное лицо' : ''].filter(Boolean).join(' · '); await this.bot.sendMessage(chatId, `${platformEmoji[link.platform as Platform]} ${link.platform.toUpperCase()}\n\n📂 ${category}\n📍 ${scope}${filters ? `\n🔎 ${filters}` : ''}\n\nСтатус: ${status}`, { reply_markup: { inline_keyboard: [[{ text: '🔍 Проверить', callback_data: `check_${link.id}` }, { text: '🗑 Удалить', callback_data: `delete_${link.id}` }]] } }); } } catch (error: any) { logger.error('Failed to show searches', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось загрузить поиски.'); } }

  async handleDeals(chatId:number,userId:number):Promise<void>{
    try{
      const user=await this.db.getUser(userId);
      if(!user?.id){await this.bot.sendMessage(chatId,'❌ Пользователь не найден.');return;}
      const ads=await this.db.getUserRecentAds(user.id,120);
      const scored=ads
        .map(ad=>({ad,deal:analyzeDeal(ad)}))
        .filter(item=>item.deal.score!==null&&item.deal.score>=65)
        .sort((a,b)=>(b.deal.score||0)-(a.deal.score||0))
        .slice(0,10);
      if(!scored.length){
        await this.bot.sendMessage(chatId,'🔥 Пока нет выгодных находок с надёжной оценкой рынка.\n\nСоздайте монитор и дайте WellBOT немного данных для сравнения.',{reply_markup:this.getMainKeyboard()});
        return;
      }
      await this.bot.sendMessage(chatId,`🔥 <b>ВЫГОДНЫЕ НАХОДКИ</b>\n\nНайдено: ${scored.length}. Сортировка по Deal Score.`,{parse_mode:'HTML'});
      for(const item of scored){
        const formatted=await this.adPresenter.format(item.ad);
        await this.telegramSender.send(chatId,formatted);
      }
      logger.info('Deal discovery opened',{userId,count:scored.length});
    }catch(error:any){
      logger.error('Failed to show deals',{userId,error:error?.message||String(error)});
      await this.bot.sendMessage(chatId,'❌ Не удалось загрузить выгодные находки.');
    }
  }

  async handleDismissAd(chatId: number, userId: number, adId: number, messageId?: number): Promise<void> {
    try {
      const dismissed = await this.db.dismissAdForUser(adId, userId);
      if (!dismissed) {
        await this.bot.sendMessage(chatId, '❌ Объявление не найдено или уже скрыто.');
        return;
      }
      if (messageId) {
        try {
          await (this.bot as any).editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: messageId },
          );
        } catch {}
      }
      await this.bot.sendMessage(chatId, '⏭ Объявление пропущено. Оно больше не будет показываться в WellBOT.');
      logger.info('Ad dismissed from Telegram', { adId, userId });
    } catch (error: any) {
      logger.error('Failed to dismiss ad', { adId, userId, error: error.message });
      await this.bot.sendMessage(chatId, '❌ Не удалось пропустить объявление. Попробуйте ещё раз.');
    }
  }

  async handleDeleteLink(chatId: number, userId: number, linkId: number): Promise<void> { try { const link = await this.db.getLinkForUser(linkId, userId); if (!link) { await this.bot.sendMessage(chatId, '❌ Поиск не найден или уже удалён.'); return; } await this.db.deleteLink(linkId, userId); await this.bot.sendMessage(chatId, '✅ Поиск удалён.'); logger.info('Link deleted', { linkId, userId }); } catch (error: any) { logger.error('Failed to delete link', { linkId, userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось удалить поиск.'); } }

  async handleDeleteAllLinks(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const links = await this.db.getUserLinks(user.id); if (!links.length) { await this.bot.sendMessage(chatId, '📋 У вас нет поисков для удаления.'); return; } await this.bot.sendMessage(chatId, `⚠️ Вы уверены, что хотите удалить все ${links.length} поисков?\n\nЭто действие нельзя отменить!`, { reply_markup: { inline_keyboard: [[{ text: '✅ Да, удалить все', callback_data: 'confirm_delete_all' }, { text: '❌ Отмена', callback_data: 'cancel_delete_all' }]] } }); } catch (error: any) { logger.error('Failed to handle delete all links', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); } }

  async handleConfirmDeleteAll(chatId: number, userId: number): Promise<void> { try { const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const links = await this.db.getUserLinks(user.id); for (const link of links) await this.db.deleteLink(link.id, userId); await this.bot.sendMessage(chatId, `✅ Удалено ${links.length} поисков.`, { reply_markup: this.getMainKeyboard() }); logger.info('All links deleted', { userId, count: links.length }); } catch (error: any) { logger.error('Failed to delete all searches', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось удалить ссылки.'); } }

  async handleCancelDeleteAll(chatId: number): Promise<void> { try { await this.bot.sendMessage(chatId, '❌ Удаление отменено.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to cancel delete all', { error: 'cancelled' }); } }

  async handleConfirmClearAds(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const deletedCount = await this.db.clearAdsByUserId(user.id); await this.bot.sendMessage(chatId, `✅ Очищено ${deletedCount} объявлений.\n\nБот начнёт заново отслеживать все объявления как новые.`, { reply_markup: this.getMainKeyboard() }); logger.info('Ads cleared', { userId, deletedCount }); } catch (error: any) { logger.error('Failed to confirm clear ads', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Не удалось очистить объявления.'); } }

  async handleCancelClearAds(chatId: number): Promise<void> { try { await this.bot.sendMessage(chatId, '❌ Очистка отменена.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to cancel clear ads', { error: 'cancelled' }); } }

  async handleCheckLink(chatId: number, userId: number, linkId: number): Promise<void> { try { const link = await this.db.getLinkForUser(linkId, userId); if (!link) { await this.bot.sendMessage(chatId, '❌ Поиск не найден или вам недоступна.'); return; } await this.bot.sendMessage(chatId, '⏳ Проверяю поиск...'); const parser = ParserFactory.getParser(link.platform as Platform); if (!parser) { await this.bot.sendMessage(chatId, `❌ Парсер для платформы "${link.platform}" не найден.`); return; } const ads = await parser.parseUrl(link.url); const previewAds = NewAdSelector.pick(ads, 5).reverse(); await this.bot.sendMessage(chatId, `📋 Найдено ${ads.length} объявлений. Показываю 5 самых свежих:`); const formattedAds = await Promise.all(previewAds.map(ad => this.adPresenter.format(ad))); for (const formatted of formattedAds) await this.telegramSender.send(chatId, formatted); logger.info('Link checked', { linkId, userId, adsFound: ads.length }); } catch (error: any) { logger.error('Failed to check link', { linkId, userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, mapError(error)); } }

  async sendNotification(telegramId: number, ad: Ad): Promise<void> {
    try {
      const formatted = await this.adPresenter.format(ad);
      const timezone = process.env.DISPLAY_TIMEZONE || 'Europe/Minsk';
      const formatClock = (value: Date | string | null | undefined): string => {
        const date = value instanceof Date ? value : value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '—';
        return new Intl.DateTimeFormat('ru-RU', {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).format(date);
      };
      const published = ad.published_at ? new Date(ad.published_at) : null;
      const detected = ad.detected_at ? new Date(ad.detected_at) : new Date();
      const deliveryDelayMs = published && !Number.isNaN(published.getTime())
        ? Math.max(0, Date.now() - published.getTime())
        : null;
      const realtimeMeta = [
        '🕐 Опубликовано: ' + formatClock(published),
        '⚡ Обнаружено: ' + formatClock(detected),
        '📨 Отправлено: ' + formatClock(new Date()),
        deliveryDelayMs !== null ? '⏱ Задержка: ' + (deliveryDelayMs / 1000).toFixed(1) + ' с' : null,
      ].filter(Boolean).join('\n');
      await this.telegramSender.send(telegramId, {
        ...formatted,
        text: '📢 Новое объявление!\n\n' + realtimeMeta + '\n\n' + formatted.text,
      });
    } catch (error: any) {
      if (error?.response?.statusCode === 403) { logger.warn('User blocked bot', { telegramId }); return; }
      logger.error('Failed to send notification', { telegramId, adId: ad.id, error: error?.message || String(error) });
      throw error;
    }
  }

  async sendPriceDropNotification(telegramId: number, priceDrop: any, userId: number): Promise<void> {
    try {
      const ad = await this.db.getAdByIdForUser(priceDrop.adId, userId ?? 0);
      if (!ad) return;
      const formatted = await this.adPresenter.format(ad);
      await this.telegramSender.send(telegramId, { ...formatted, text: `💰 СНИЖЕНИЕ ЦЕНЫ!\n\n${formatted.text}\n\n💸 Было: ${priceDrop.oldPrice}\n🆕 Стало: ${priceDrop.newPrice}\n📉 Изменение: ${priceDrop.changePercent}%` });
    } catch (error: any) {
      logger.error('Failed to send price drop notification', { telegramId, adId: priceDrop.adId, error: error?.message || String(error) });
      throw error;
    }
  }

  async handleClearAds(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } await this.bot.sendMessage(chatId, '🗑 Это удалит все сохранённые объявления из базы данных.\n\nПоиски останутся на месте, и бот начнёт заново отслеживать все объявления как новые.\n\nПродолжить?', { reply_markup: { inline_keyboard: [[{ text: '✅ Да, очистить объявления', callback_data: 'confirm_clear_ads' }, { text: '❌ Отмена', callback_data: 'cancel_clear_ads' }]] } }); } catch (error: any) { logger.error('Failed to handle /clear', { userId, error: error.message }); await this.bot.sendMessage(chatId, '❌ Произошла ошибка.'); } }

  async handleStats(chatId: number, userId: number): Promise<void> { try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, '❌ Ошибка: пользователь не найден.'); return; } const links = await this.db.getUserLinks(user.id); const stats = await this.db.getUserAdsCount(user.id); const totalAds = stats.reduce((sum, stat) => sum + stat.count, 0); const statsByLink = stats.map(stat => `  ${stat.linkPlatform.toUpperCase()}: ${stat.count} объявлений`); await this.bot.sendMessage(chatId, `📊 Статистика:\n\n🎯 Поисков: ${links.length}\n📄 Всего объявлений в базе: ${totalAds}\n\n${statsByLink.length ? statsByLink.join('\n') : 'Нет данных'}`, { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to handle /stats', { userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`); } }

  stop(): void { this.bot.stopPolling(); }
}
