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

  private getMainKeyboard() {
    const keyboard: TelegramBot.KeyboardButton[][] = [];


    keyboard.push(
      [{ text: 'вћ• Р”РѕР±Р°РІРёС‚СЊ СЃСЃС‹Р»РєСѓ' }],
      [{ text: 'рџ“‹ РњРѕРё СЃСЃС‹Р»РєРё' }, { text: 'рџ—‘ РЈРґР°Р»РёС‚СЊ РІСЃРµ СЃСЃС‹Р»РєРё' }],
      [{ text: 'рџ“Љ РЎС‚Р°С‚РёСЃС‚РёРєР°' }, { text: 'рџ—‘ РћС‡РёСЃС‚РёС‚СЊ РѕР±СЉСЏРІР»РµРЅРёСЏ' }],
      [{ text: 'рџ“є РџСЂРёРІСЏР·Р°С‚СЊ РєР°РЅР°Р»' }, { text: 'рџ“є РЎС‚Р°С‚СѓСЃ РєР°РЅР°Р»Р°' }],
      [{ text: 'рџ“є РћС‚РєР»СЋС‡РёС‚СЊ РєР°РЅР°Р»' }],
    );

    return { keyboard, resize_keyboard: true, persistent: true };
  }

  private setupHandlers(): void {
    this.bot.on('message', async (msg: Message) => {
      if (!msg.from || !msg.text) return;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      if (!this.rateLimiter.isAllowed(userId)) {
        await this.bot.sendMessage(chatId, 'вљ пёЏ РЎР»РёС€РєРѕРј РјРЅРѕРіРѕ Р·Р°РїСЂРѕСЃРѕРІ. РџРѕРґРѕР¶РґРёС‚Рµ РјРёРЅСѓС‚Сѓ.'); return;
      }
      if (msg.text === '/start') await this.handleStart(chatId, userId, msg.from.username);
      else if (msg.text === '/clear' || msg.text === 'рџ—‘ РћС‡РёСЃС‚РёС‚СЊ РѕР±СЉСЏРІР»РµРЅРёСЏ') await this.handleClearAds(chatId, userId);
      else if (msg.text === '/stats' || msg.text === 'рџ“Љ РЎС‚Р°С‚РёСЃС‚РёРєР°') await this.handleStats(chatId, userId);
      else if (msg.text === 'вћ• Р”РѕР±Р°РІРёС‚СЊ СЃСЃС‹Р»РєСѓ') await this.handleAddLinkButton(chatId, userId);
      else if (msg.text === 'рџ“‹ РњРѕРё СЃСЃС‹Р»РєРё') await this.handleMyLinks(chatId, userId);
      else if (msg.text === 'рџ—‘ РЈРґР°Р»РёС‚СЊ РІСЃРµ СЃСЃС‹Р»РєРё') await this.handleDeleteAllLinks(chatId, userId);
      else if (msg.text === 'рџ“є РџСЂРёРІСЏР·Р°С‚СЊ РєР°РЅР°Р»') await this.handleAddChannel(chatId, userId);
      else if (msg.text === 'рџ“є РћС‚РєР»СЋС‡РёС‚СЊ РєР°РЅР°Р»') await this.handleRemoveChannel(chatId, userId);
      else if (msg.text === 'рџ“є РЎС‚Р°С‚СѓСЃ РєР°РЅР°Р»Р°') await this.handleChannelStatus(chatId, userId);
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
      if (!this.rateLimiter.isAllowed(userId)) { await this.bot.answerCallbackQuery(query.id, { text: 'РЎР»РёС€РєРѕРј РјРЅРѕРіРѕ Р·Р°РїСЂРѕСЃРѕРІ' }); return; }
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
      await this.bot.sendMessage(chatId, 'рџ‘‹ РџСЂРёРІРµС‚! РЇ РїРѕРјРѕРіСѓ РѕС‚СЃР»РµР¶РёРІР°С‚СЊ РЅРѕРІС‹Рµ РѕР±СЉСЏРІР»РµРЅРёСЏ РЅР° Kufar, Onliner Рё av.by.\n\nРСЃРїРѕР»СЊР·СѓР№С‚Рµ РєРЅРѕРїРєРё СЃРЅРёР·Сѓ РґР»СЏ СѓРїСЂР°РІР»РµРЅРёСЏ СЃСЃС‹Р»РєР°РјРё.', { reply_markup: this.getMainKeyboard() });
      logger.info('User started bot', { userId, username });
    } catch (error: any) {
      logger.error('Failed to handle /start', { userId, error: error.message });
      await this.bot.sendMessage(chatId, 'вќЊ РџСЂРѕРёР·РѕС€Р»Р° РѕС€РёР±РєР°. РџРѕРїСЂРѕР±СѓР№С‚Рµ РїРѕР·Р¶Рµ.');
    }
  }

  async handleAddLinkButton(chatId: number, userId: number): Promise<void> {
    try {
      await this.db.createUser(userId, null);
      const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°: РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.'); return; }
      if (await this.db.getUserLinksCount(user.id) >= 10) { await this.bot.sendMessage(chatId, 'вљ пёЏ Р”РѕСЃС‚РёРіРЅСѓС‚ Р»РёРјРёС‚ РІ 10 СЃСЃС‹Р»РѕРє. РЈРґР°Р»РёС‚Рµ СЃС‚Р°СЂС‹Рµ СЃСЃС‹Р»РєРё.'); return; }
      this.userStates.set(userId, 'awaiting_url');
      await this.bot.sendMessage(chatId, 'рџ“Ћ РћС‚РїСЂР°РІСЊС‚Рµ СЃСЃС‹Р»РєСѓ РЅР° СЃС‚СЂР°РЅРёС†Сѓ РїРѕРёСЃРєР° СЃ С„РёР»СЊС‚СЂР°РјРё:\n\nвЂў Kufar.by - СЃС‚СЂР°РЅРёС†Р° РєР°С‚РµРіРѕСЂРёРё СЃ С„РёР»СЊС‚СЂР°РјРё\nвЂў Onliner.by - Р‘Р°СЂР°С…РѕР»РєР°, РђРІС‚Рѕ, РќРµРґРІРёР¶РёРјРѕСЃС‚СЊ\nвЂў av.by - СЃС‚СЂР°РЅРёС†Р° РїРѕРёСЃРєР° СЃ С„РёР»СЊС‚СЂР°РјРё\n\nвљ пёЏ РќРµ РѕС‚РїСЂР°РІР»СЏР№С‚Рµ СЃСЃС‹Р»РєРё РЅР° РєРѕРЅРєСЂРµС‚РЅС‹Рµ РѕР±СЉСЏРІР»РµРЅРёСЏ!', { reply_markup: this.getMainKeyboard() });
    } catch (error: any) {
      logger.error('Failed to handle add link button', { userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РџСЂРѕРёР·РѕС€Р»Р° РѕС€РёР±РєР°.');
    }
  }

  async handleAddLink(chatId: number, userId: number, url: string): Promise<void> {
    try {
      this.userStates.delete(userId);
      if (url === 'вќЊ РћС‚РјРµРЅР°') { await this.bot.sendMessage(chatId, 'вќЊ РћС‚РјРµРЅРµРЅРѕ.', { reply_markup: this.getMainKeyboard() }); return; }
      url = this.normalizeUrl(url);
      const assessment = LinkAcceptance.assess(url);
      if (!assessment.ok || !assessment.platform) { await this.bot.sendMessage(chatId, `вќЊ ${assessment.reason || 'РќРµРєРѕСЂСЂРµРєС‚РЅР°СЏ СЃСЃС‹Р»РєР°'}\n\nРџРѕРґРґРµСЂР¶РёРІР°СЋС‚СЃСЏ СЃС‚СЂР°РЅРёС†С‹ РїРѕРёСЃРєР° Kufar, Onliner Рё av.by.`); return; }
      await this.db.createUser(userId, null);
      const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°: РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.'); return; }
      const existingLinks = await this.db.getUserLinks(user.id);
      if (existingLinks.some(link => link.url === url)) { await this.bot.sendMessage(chatId, 'вљ пёЏ Р­С‚Р° СЃСЃС‹Р»РєР° СѓР¶Рµ РґРѕР±Р°РІР»РµРЅР°!'); return; }
      await this.bot.sendMessage(chatId, 'вЏі РџСЂРѕРІРµСЂСЏСЋ СЃСЃС‹Р»РєСѓ...');
      const parser = ParserFactory.getParser(assessment.platform);
      if (!parser) { await this.bot.sendMessage(chatId, 'вќЊ РџР°СЂСЃРµСЂ РЅРµ РЅР°Р№РґРµРЅ.'); return; }
      let testAds: Ad[] = [];
      try {
        testAds = await parser.parseUrl(url);
        if (!testAds.length) { await this.bot.sendMessage(chatId, 'вќЊ РџРѕ СЌС‚РѕР№ СЃСЃС‹Р»РєРµ РЅРµ РЅР°Р№РґРµРЅРѕ РѕР±СЉСЏРІР»РµРЅРёР№.\n\nРџРѕРїСЂРѕР±СѓР№С‚Рµ РґСЂСѓРіСѓСЋ СЃСЃС‹Р»РєСѓ.'); return; }
      } catch (error: any) { logger.error('Failed to test parse link', { userId, url, error: error.message }); await this.bot.sendMessage(chatId, mapError(error)); return; }
      await this.db.createLink(user.id, url, assessment.platform);
      const platformEmoji: Record<Platform, string> = { kufar: 'рџџў', onliner: 'рџ”µ', av: 'рџљ—' };
      await this.bot.sendMessage(chatId, `вњ… РЎСЃС‹Р»РєР° РґРѕР±Р°РІР»РµРЅР° Рё СЂР°Р±РѕС‚Р°РµС‚!\n\n${platformEmoji[assessment.platform]} ${assessment.platform.toUpperCase()}\n${url}\n\nРќР°Р№РґРµРЅРѕ РѕР±СЉСЏРІР»РµРЅРёР№: ${testAds.length}\n\nР’С‹ РїРѕР»СѓС‡РёС‚Рµ СѓРІРµРґРѕРјР»РµРЅРёРµ Рѕ РЅРѕРІС‹С… РѕР±СЉСЏРІР»РµРЅРёСЏС….`, { reply_markup: this.getMainKeyboard() });
      if (this.scheduler) { logger.info('Triggering immediate parse after link add', { userId, url }); this.scheduler.triggerParse(); }
      const previewAds = NewAdSelector.pick(testAds, 5).reverse();
      await this.bot.sendMessage(chatId, `рџ“‹ РџРѕСЃР»РµРґРЅРёРµ ${previewAds.length} РѕР±СЉСЏРІР»РµРЅРёР№:`);
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
      if (!assessment.ok || !assessment.platform) { await this.bot.sendMessage(chatId, `вќЊ ${assessment.reason || 'Р­С‚Р° СЃСЃС‹Р»РєР° РЅРµ РїРѕРґРґРµСЂР¶РёРІР°РµС‚СЃСЏ.'}`); return; }
      const parser = ParserFactory.getParser(assessment.platform);
      if (!parser) { await this.bot.sendMessage(chatId, 'вќЊ РџР°СЂСЃРµСЂ РЅРµ РЅР°Р№РґРµРЅ.'); return; }
      await this.db.createUser(userId, null);
      const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°: РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.'); return; }
      if (await this.db.getUserLinksCount(user.id) >= 10) { await this.bot.sendMessage(chatId, 'вљ пёЏ Р”РѕСЃС‚РёРіРЅСѓС‚ Р»РёРјРёС‚ РІ 10 СЃСЃС‹Р»РѕРє. РЈРґР°Р»РёС‚Рµ СЃС‚Р°СЂС‹Рµ СЃСЃС‹Р»РєРё.'); return; }
      const existingLinks = await this.db.getUserLinks(user.id);
      if (existingLinks.some(link => link.url === url)) { await this.bot.sendMessage(chatId, 'вљ пёЏ Р­С‚Р° СЃСЃС‹Р»РєР° СѓР¶Рµ РґРѕР±Р°РІР»РµРЅР° РІ РІР°С€ СЃРїРёСЃРѕРє!'); return; }
      await this.bot.sendMessage(chatId, 'вЏі РџСЂРѕРІРµСЂСЏСЋ СЃСЃС‹Р»РєСѓ...');
      const testAds = await parser.parseUrl(url);
      if (!testAds.length) { await this.bot.sendMessage(chatId, 'вќЊ РџРѕ СЌС‚РѕР№ СЃСЃС‹Р»РєРµ РЅРµ РЅР°Р№РґРµРЅРѕ РѕР±СЉСЏРІР»РµРЅРёР№.'); return; }
      this.pendingLinks.set(userId, url);
      const platformEmoji: Record<Platform, string> = { kufar: 'рџџў', onliner: 'рџ”µ', av: 'рџљ—' };
      await this.bot.sendMessage(chatId, `${platformEmoji[assessment.platform]} ${assessment.platform.toUpperCase()}\n${url}\n\nРќР°Р№РґРµРЅРѕ РѕР±СЉСЏРІР»РµРЅРёР№: ${testAds.length}`);
      const previewAds = NewAdSelector.pick(testAds, 5).reverse();
      await this.bot.sendMessage(chatId, 'рџ“‹ 5 СЃР°РјС‹С… СЃРІРµР¶РёС… РѕР±СЉСЏРІР»РµРЅРёР№:');
      const formattedAds = await Promise.all(previewAds.map(ad => this.adPresenter.format(ad)));
      for (const formatted of formattedAds) await this.telegramSender.send(chatId, formatted);
      await this.bot.sendMessage(chatId, 'вќ“ РҐРѕС‚РёС‚Рµ РґРѕР±Р°РІРёС‚СЊ СЌС‚Сѓ СЃСЃС‹Р»РєСѓ РґР»СЏ РѕС‚СЃР»РµР¶РёРІР°РЅРёСЏ РЅРѕРІС‹С… РѕР±СЉСЏРІР»РµРЅРёР№?', { reply_markup: { inline_keyboard: [[{ text: 'вњ… Р”РѕР±Р°РІРёС‚СЊ СЌС‚Сѓ СЃСЃС‹Р»РєСѓ', callback_data: 'confirm_add_link' }, { text: 'вќЊ РћС‚РјРµРЅР°', callback_data: 'cancel_add_link' }]] } });
      logger.info('Direct link preview shown', { userId, platform: assessment.platform, url, adsFound: testAds.length });
    } catch (error: any) {
      logger.error('Failed to handle direct link', { userId, url, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, mapError(error));
    }
  }

  async handleConfirmAddLink(chatId: number, userId: number): Promise<void> {
    try {
      let url = this.pendingLinks.get(userId);
      if (!url) { await this.bot.sendMessage(chatId, 'вќЊ РЎСЃС‹Р»РєР° РЅРµ РЅР°Р№РґРµРЅР°. РџРѕРїСЂРѕР±СѓР№С‚Рµ РѕС‚РїСЂР°РІРёС‚СЊ РµС‘ СЃРЅРѕРІР°.'); return; }
      url = this.normalizeUrl(url);
      const assessment = LinkAcceptance.assess(url);
      if (!assessment.ok || !assessment.platform) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР° РІР°Р»РёРґР°С†РёРё СЃСЃС‹Р»РєРё.'); this.pendingLinks.delete(userId); return; }
      await this.db.createUser(userId, null);
      const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°: РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.'); this.pendingLinks.delete(userId); return; }
      if (await this.db.getUserLinksCount(user.id) >= 10) { await this.bot.sendMessage(chatId, 'вљ пёЏ Р”РѕСЃС‚РёРіРЅСѓС‚ Р»РёРјРёС‚ РІ 10 СЃСЃС‹Р»РѕРє.'); this.pendingLinks.delete(userId); return; }
      const existingLinks = await this.db.getUserLinks(user.id);
      if (existingLinks.some(link => link.url === url)) { await this.bot.sendMessage(chatId, 'вљ пёЏ Р­С‚Р° СЃСЃС‹Р»РєР° СѓР¶Рµ РґРѕР±Р°РІР»РµРЅР°.'); this.pendingLinks.delete(userId); return; }
      await this.db.createLink(user.id, url, assessment.platform);
      this.pendingLinks.delete(userId);
      await this.bot.sendMessage(chatId, 'вњ… РЎСЃС‹Р»РєР° РґРѕР±Р°РІР»РµРЅР°! Р’С‹ Р±СѓРґРµС‚Рµ РїРѕР»СѓС‡Р°С‚СЊ СѓРІРµРґРѕРјР»РµРЅРёСЏ Рѕ РЅРѕРІС‹С… РѕР±СЉСЏРІР»РµРЅРёСЏС….', { reply_markup: this.getMainKeyboard() });
      if (this.scheduler) { logger.info('Triggering immediate parse after direct link confirmation', { userId, url }); this.scheduler.triggerParse(); }
      logger.info('Link confirmed and added', { userId, platform: assessment.platform, url });
    } catch (error: any) {
      logger.error('Failed to confirm add link', { userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РќРµ СѓРґР°Р»РѕСЃСЊ РґРѕР±Р°РІРёС‚СЊ СЃСЃС‹Р»РєСѓ.'); this.pendingLinks.delete(userId);
    }
  }

  async handleCancelAddLink(chatId: number, userId: number): Promise<void> { try { this.pendingLinks.delete(userId); await this.bot.sendMessage(chatId, 'вќЊ Р”РѕР±Р°РІР»РµРЅРёРµ СЃСЃС‹Р»РєРё РѕС‚РјРµРЅРµРЅРѕ.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to cancel add link', { userId, error: error.message }); } }

  async handleMyLinks(chatId: number, userId: number): Promise<void> {
    try {
      await this.db.createUser(userId, null); const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°: РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.'); return; }
      const links = await this.db.getUserLinks(user.id);
      if (!links.length) { await this.bot.sendMessage(chatId, 'рџ“‹ РЈ РІР°СЃ РїРѕРєР° РЅРµС‚ СЃСЃС‹Р»РѕРє.', { reply_markup: { inline_keyboard: [[{ text: 'вћ• Р”РѕР±Р°РІРёС‚СЊ СЃСЃС‹Р»РєСѓ', callback_data: 'add_link' }]] } }); return; }
      const platformEmoji: Record<Platform, string> = { kufar: 'рџџў', onliner: 'рџ”µ', av: 'рџљ—' };
      for (const link of links) {
        if (!platformEmoji[link.platform as Platform]) continue;
        const status = link.is_active ? 'вњ… РђРєС‚РёРІРЅР°' : 'вќЊ РќРµР°РєС‚РёРІРЅР°';
        await this.bot.sendMessage(chatId, `${platformEmoji[link.platform as Platform]} ${link.platform.toUpperCase()}\n\n${link.url}\n\nРЎС‚Р°С‚СѓСЃ: ${status}`, { reply_markup: { inline_keyboard: [[{ text: 'рџ”Ќ РџСЂРѕРІРµСЂРёС‚СЊ', callback_data: `check_${link.id}` }, { text: 'рџ—‘ РЈРґР°Р»РёС‚СЊ', callback_data: `delete_${link.id}` }]] } });
      }
    } catch (error: any) { logger.error('Failed to show links', { userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ СЃСЃС‹Р»РєРё.'); }
  }

  async handleDeleteLink(chatId: number, userId: number, linkId: number): Promise<void> {
    try {
      const link = await this.db.getLinkForUser(linkId, userId);
      if (!link) { await this.bot.sendMessage(chatId, 'вќЊ РЎСЃС‹Р»РєР° РЅРµ РЅР°Р№РґРµРЅР° РёР»Рё СѓР¶Рµ СѓРґР°Р»РµРЅР°.'); return; }
      await this.db.deleteLink(linkId, userId);
      await this.bot.sendMessage(chatId, 'вњ… РЎСЃС‹Р»РєР° СѓРґР°Р»РµРЅР°.');
      logger.info('Link deleted', { linkId, userId });
    } catch (error: any) { logger.error('Failed to delete link', { linkId, userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РќРµ СѓРґР°Р»РѕСЃСЊ СѓРґР°Р»РёС‚СЊ СЃСЃС‹Р»РєСѓ.'); }
  }

  async handleDeleteAllLinks(chatId: number, userId: number): Promise<void> {
    try {
      await this.db.createUser(userId, null); const user = await this.db.getUser(userId);
      if (!user?.id) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°: РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.'); return; }
      const links = await this.db.getUserLinks(user.id);
      if (!links.length) { await this.bot.sendMessage(chatId, 'рџ“‹ РЈ РІР°СЃ РЅРµС‚ СЃСЃС‹Р»РѕРє РґР»СЏ СѓРґР°Р»РµРЅРёСЏ.'); return; }
      await this.bot.sendMessage(chatId, `вљ пёЏ Р’С‹ СѓРІРµСЂРµРЅС‹, С‡С‚Рѕ С…РѕС‚РёС‚Рµ СѓРґР°Р»РёС‚СЊ РІСЃРµ ${links.length} СЃСЃС‹Р»РѕРє?\n\nР­С‚Рѕ РґРµР№СЃС‚РІРёРµ РЅРµР»СЊР·СЏ РѕС‚РјРµРЅРёС‚СЊ!`, { reply_markup: { inline_keyboard: [[{ text: 'вњ… Р”Р°, СѓРґР°Р»РёС‚СЊ РІСЃРµ', callback_data: 'confirm_delete_all' }, { text: 'вќЊ РћС‚РјРµРЅР°', callback_data: 'cancel_delete_all' }]] } });
    } catch (error: any) { logger.error('Failed to handle delete all links', { userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РџСЂРѕРёР·РѕС€Р»Р° РѕС€РёР±РєР°.'); }
  }

  async handleConfirmDeleteAll(chatId: number, userId: number): Promise<void> {
    try {
      const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°: РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.'); return; }
      const links = await this.db.getUserLinks(user.id); for (const link of links) await this.db.deleteLink(link.id, userId);
      await this.bot.sendMessage(chatId, `вњ… РЈРґР°Р»РµРЅРѕ ${links.length} СЃСЃС‹Р»РѕРє.`, { reply_markup: this.getMainKeyboard() });
      logger.info('All links deleted', { userId, count: links.length });
    } catch (error: any) { logger.error('Failed to delete all links', { userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РќРµ СѓРґР°Р»РѕСЃСЊ СѓРґР°Р»РёС‚СЊ СЃСЃС‹Р»РєРё.'); }
  }

  async handleCancelDeleteAll(chatId: number): Promise<void> { try { await this.bot.sendMessage(chatId, 'вќЊ РЈРґР°Р»РµРЅРёРµ РѕС‚РјРµРЅРµРЅРѕ.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to cancel delete all', { error: error.message }); } }

  async handleConfirmClearAds(chatId: number, userId: number): Promise<void> {
    try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°: РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.'); return; } const deletedCount = await this.db.clearAdsByUserId(user.id); await this.bot.sendMessage(chatId, `вњ… РћС‡РёС‰РµРЅРѕ ${deletedCount} РѕР±СЉСЏРІР»РµРЅРёР№.\n\nР‘РѕС‚ РЅР°С‡РЅС‘С‚ Р·Р°РЅРѕРІРѕ РѕС‚СЃР»РµР¶РёРІР°С‚СЊ РІСЃРµ РѕР±СЉСЏРІР»РµРЅРёСЏ РєР°Рє РЅРѕРІС‹Рµ.`, { reply_markup: this.getMainKeyboard() }); logger.info('Ads cleared', { userId, deletedCount }); }
    catch (error: any) { logger.error('Failed to confirm clear ads', { userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РќРµ СѓРґР°Р»РѕСЃСЊ РѕС‡РёСЃС‚РёС‚СЊ РѕР±СЉСЏРІР»РµРЅРёСЏ.'); }
  }

  async handleCancelClearAds(chatId: number): Promise<void> { try { await this.bot.sendMessage(chatId, 'вќЊ РћС‡РёСЃС‚РєР° РѕС‚РјРµРЅРµРЅР°.', { reply_markup: this.getMainKeyboard() }); } catch (error: any) { logger.error('Failed to cancel clear ads', { error: error.message }); } }

  async handleCheckLink(chatId: number, userId: number, linkId: number): Promise<void> {
    try {
      const link = await this.db.getLinkForUser(linkId, userId);
      if (!link) { await this.bot.sendMessage(chatId, 'вќЊ РЎСЃС‹Р»РєР° РЅРµ РЅР°Р№РґРµРЅР° РёР»Рё РІР°Рј РЅРµРґРѕСЃС‚СѓРїРЅР°.'); return; }
      await this.bot.sendMessage(chatId, 'вЏі РџСЂРѕРІРµСЂСЏСЋ СЃСЃС‹Р»РєСѓ...');
      const parser = ParserFactory.getParser(link.platform as Platform);
      if (!parser) { await this.bot.sendMessage(chatId, `вќЊ РџР°СЂСЃРµСЂ РґР»СЏ РїР»Р°С‚С„РѕСЂРјС‹ "${link.platform}" РЅРµ РЅР°Р№РґРµРЅ.`); return; }
      const ads = await parser.parseUrl(link.url);
      const previewAds = NewAdSelector.pick(ads, 5).reverse();
      await this.bot.sendMessage(chatId, `рџ“‹ РќР°Р№РґРµРЅРѕ ${ads.length} РѕР±СЉСЏРІР»РµРЅРёР№. РџРѕРєР°Р·С‹РІР°СЋ 5 СЃР°РјС‹С… СЃРІРµР¶РёС…:`);
      const formattedAds = await Promise.all(previewAds.map(ad => this.adPresenter.format(ad)));
      for (const formatted of formattedAds) await this.telegramSender.send(chatId, formatted);
      logger.info('Link checked', { linkId, userId, adsFound: ads.length });
    } catch (error: any) { logger.error('Failed to check link', { linkId, userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, mapError(error)); }
  }

  async sendNotification(telegramId: number, ad: Ad): Promise<void> {
    try { const formatted = await this.adPresenter.format(ad); await this.telegramSender.send(telegramId, { ...formatted, text: `рџ“ў РќРѕРІРѕРµ РѕР±СЉСЏРІР»РµРЅРёРµ!\n\n${formatted.text}` }); }
    catch (error: any) { if (error.response?.statusCode === 403) logger.warn('User blocked bot', { telegramId }); else logger.error('Failed to send notification', { telegramId, adId: ad.id, error: error.message }); }
  }

  async sendPriceDropNotification(telegramId: number, priceDrop: any): Promise<void> {
    try { const ad = await this.db.getAdByExternalId(priceDrop.externalId); if (!ad) return; const formatted = await this.adPresenter.format(ad); await this.telegramSender.send(telegramId, { ...formatted, text: `рџ’° РЎРќРР–Р•РќРР• Р¦Р•РќР«!\n\n${formatted.text}\n\nрџ’ё Р‘С‹Р»Рѕ: ${priceDrop.oldPrice}\nрџ†• РЎС‚Р°Р»Рѕ: ${priceDrop.newPrice}\nрџ“‰ РР·РјРµРЅРµРЅРёРµ: ${priceDrop.changePercent}%` }); }
    catch (error: any) { logger.error('Failed to send price drop notification', { telegramId, adId: priceDrop.adId, error: error.message }); }
  }

  async handleAddChannel(chatId: number, userId: number): Promise<void> {
    try { await this.db.createUser(userId, null); await this.bot.sendMessage(chatId, 'рџ“є Р”Р»СЏ РїСЂРёРІСЏР·РєРё РєР°РЅР°Р»Р°:\n\n1. Р”РѕР±Р°РІСЊС‚Рµ Р±РѕС‚Р° РІ РєР°РЅР°Р» РєР°Рє Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂР°\n2. РћС‚РїСЂР°РІСЊС‚Рµ Р±РѕС‚Сѓ СЃРѕРѕР±С‰РµРЅРёРµ РІ РєР°РЅР°Р»\n3. Р‘РѕС‚ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё РїСЂРёРІСЏР¶РµС‚ РєР°РЅР°Р»\n\nРР»Рё РѕС‚РїСЂР°РІСЊС‚Рµ ID РєР°РЅР°Р»Р° РІ С„РѕСЂРјР°С‚Рµ: /addchannel -1001234567890', { reply_markup: this.getMainKeyboard() }); this.userStates.set(userId, 'awaiting_channel'); }
    catch (error: any) { logger.error('Failed to handle add channel', { userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РџСЂРѕРёР·РѕС€Р»Р° РѕС€РёР±РєР°.'); }
  }

  async handleRemoveChannel(chatId: number, userId: number): Promise<void> {
    try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°.', { reply_markup: this.getMainKeyboard() }); return; } await this.db.deactivateAllChannelSubscriptions(user.id); await this.bot.sendMessage(chatId, 'вњ… РљР°РЅР°Р» РѕС‚РєР»СЋС‡С‘РЅ.\n\nРўРµРїРµСЂСЊ СѓРІРµРґРѕРјР»РµРЅРёСЏ Р±СѓРґСѓС‚ РїСЂРёС…РѕРґРёС‚СЊ С‚РѕР»СЊРєРѕ РІ Р»РёС‡РєСѓ.', { reply_markup: this.getMainKeyboard() }); }
    catch (error: any) { logger.error('Failed to handle remove channel', { userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РџСЂРѕРёР·РѕС€Р»Р° РѕС€РёР±РєР°.'); }
  }

  async handleChannelStatus(chatId: number, userId: number): Promise<void> {
    try { let user = await this.db.getUser(userId); if (!user) { await this.db.createUser(userId, null); user = await this.db.getUser(userId); } if (!user) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°.', { reply_markup: this.getMainKeyboard() }); return; } const subscription = await this.db.getActiveChannelSubscription(user.id); if (!subscription) { await this.bot.sendMessage(chatId, 'рџ“є РљР°РЅР°Р» РЅРµ РїСЂРёРІСЏР·Р°РЅ.\n\nРСЃРїРѕР»СЊР·СѓР№С‚Рµ РєРЅРѕРїРєСѓ "РџСЂРёРІСЏР·Р°С‚СЊ РєР°РЅР°Р»" РґР»СЏ РїРѕРґРєР»СЋС‡РµРЅРёСЏ.', { reply_markup: this.getMainKeyboard() }); return; } const channelInfo = subscription.channel_username ? `@${subscription.channel_username}` : `ID: ${subscription.channel_id}`; await this.bot.sendMessage(chatId, `рџ“є РџСЂРёРІСЏР·Р°РЅРЅС‹Р№ РєР°РЅР°Р»:\n${channelInfo}\n\n${subscription.channel_title || ''}`, { reply_markup: this.getMainKeyboard() }); }
    catch (error: any) { logger.error('Failed to handle channel status', { userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РџСЂРѕРёР·РѕС€Р»Р° РѕС€РёР±РєР°.'); }
  }

  async handleAddChannelCommand(chatId: number, userId: number, text: string): Promise<void> {
    try { const match = text.match(/^\/addchannel\s+(-?\d+)/); if (!match) { await this.bot.sendMessage(chatId, 'вќЊ РќРµРІРµСЂРЅС‹Р№ С„РѕСЂРјР°С‚.\n\nРСЃРїРѕР»СЊР·СѓР№С‚Рµ: /addchannel -1001234567890', { reply_markup: this.getMainKeyboard() }); return; } const channelId = parseInt(match[1], 10); await this.db.createUser(userId, null); const dbUser = await this.db.getUser(userId); if (!dbUser) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР° СЃРѕР·РґР°РЅРёСЏ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ.', { reply_markup: this.getMainKeyboard() }); return; } await this.db.createChannelSubscription(dbUser.id, channelId, null, null); this.userStates.delete(userId); await this.bot.sendMessage(chatId, `вњ… РљР°РЅР°Р» ${channelId} РїСЂРёРІСЏР·Р°РЅ!\n\nРўРµРїРµСЂСЊ СѓРІРµРґРѕРјР»РµРЅРёСЏ Р±СѓРґСѓС‚ РїСЂРёС…РѕРґРёС‚СЊ РІ РєР°РЅР°Р» Рё РІ Р»РёС‡РєСѓ.`, { reply_markup: this.getMainKeyboard() }); }
    catch (error: any) { logger.error('Failed to handle add channel command', { userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, `вќЊ РћС€РёР±РєР°: ${error.message}`, { reply_markup: this.getMainKeyboard() }); }
  }

  async handleClearAds(chatId: number, userId: number): Promise<void> {
    try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°: РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.'); return; } await this.bot.sendMessage(chatId, 'рџ—‘ Р­С‚Рѕ СѓРґР°Р»РёС‚ РІСЃРµ СЃРѕС…СЂР°РЅС‘РЅРЅС‹Рµ РѕР±СЉСЏРІР»РµРЅРёСЏ РёР· Р±Р°Р·С‹ РґР°РЅРЅС‹С….\n\nРЎСЃС‹Р»РєРё РѕСЃС‚Р°РЅСѓС‚СЃСЏ РЅР° РјРµСЃС‚Рµ, Рё Р±РѕС‚ РЅР°С‡РЅС‘С‚ Р·Р°РЅРѕРІРѕ РѕС‚СЃР»РµР¶РёРІР°С‚СЊ РІСЃРµ РѕР±СЉСЏРІР»РµРЅРёСЏ РєР°Рє РЅРѕРІС‹Рµ.\n\nРџСЂРѕРґРѕР»Р¶РёС‚СЊ?', { reply_markup: { inline_keyboard: [[{ text: 'вњ… Р”Р°, РѕС‡РёСЃС‚РёС‚СЊ РѕР±СЉСЏРІР»РµРЅРёСЏ', callback_data: 'confirm_clear_ads' }, { text: 'вќЊ РћС‚РјРµРЅР°', callback_data: 'cancel_clear_ads' }]] } }); }
    catch (error: any) { logger.error('Failed to handle /clear', { userId, error: error.message }); await this.bot.sendMessage(chatId, 'вќЊ РџСЂРѕРёР·РѕС€Р»Р° РѕС€РёР±РєР°.'); }
  }

  async handleStats(chatId: number, userId: number): Promise<void> {
    try { await this.db.createUser(userId, null); const user = await this.db.getUser(userId); if (!user?.id) { await this.bot.sendMessage(chatId, 'вќЊ РћС€РёР±РєР°: РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РЅРµ РЅР°Р№РґРµРЅ.'); return; } const links = await this.db.getUserLinks(user.id); const stats = await this.db.getUserAdsCount(user.id); const totalAds = stats.reduce((sum, stat) => sum + stat.count, 0); const statsByLink = stats.map(stat => `  ${stat.linkPlatform.toUpperCase()}: ${stat.count} РѕР±СЉСЏРІР»РµРЅРёР№`); await this.bot.sendMessage(chatId, `рџ“Љ РЎС‚Р°С‚РёСЃС‚РёРєР°:\n\nрџ”— РЎСЃС‹Р»РѕРє: ${links.length}\nрџ“„ Р’СЃРµРіРѕ РѕР±СЉСЏРІР»РµРЅРёР№ РІ Р±Р°Р·Рµ: ${totalAds}\n\n${statsByLink.length ? statsByLink.join('\n') : 'РќРµС‚ РґР°РЅРЅС‹С…'}`, { reply_markup: this.getMainKeyboard() }); }
    catch (error: any) { logger.error('Failed to handle /stats', { userId, error: error.message, stack: error.stack }); await this.bot.sendMessage(chatId, `вќЊ РћС€РёР±РєР°: ${error.message}`); }
  }

  stop(): void { this.bot.stopPolling(); }
}
