import { DatabaseService } from '../database/DatabaseService';
import { ParserFactory } from '../parsers/ParserFactory';
import { BotHandler } from '../bot/BotHandler';
import { logger } from '../utils/logger';

interface ParseLink { id: number; user_id: number; url: string; platform: string; last_parsed_at?: Date | null; error_count?: number; }
interface ParseResult { newAds: any[]; priceDrops: any[]; }

export class ParserScheduler {
  private db: DatabaseService;
  private bot: BotHandler;
  private intervalId: NodeJS.Timeout | null = null;
  private intervalMs: number;
  private concurrency: number;
  private isRunning = false;
  private pendingTrigger = false;

  constructor(db: DatabaseService, bot: BotHandler) {
    const intervalSeconds = parseInt(process.env.PARSE_INTERVAL_SECONDS || '5', 10);
    const configuredConcurrency = parseInt(process.env.PARSE_CONCURRENCY || '20', 10);
    this.intervalMs = Math.max(1000, Number.isFinite(intervalSeconds) ? intervalSeconds * 1000 : 5000);
    this.concurrency = Math.max(1, Math.min(50, Number.isFinite(configuredConcurrency) ? configuredConcurrency : 20));
    logger.info('Parser scheduler configured', { intervalSeconds: this.intervalMs / 1000, concurrency: this.concurrency, overlapProtection: true });
  }

  start(): void {
    if (this.intervalId) return;
    void this.runParsing();
    this.intervalId = setInterval(() => {
      if (!this.isRunning) void this.runParsing();
      else logger.debug('Skipping scheduler tick because previous cycle is still running');
    }, this.intervalMs);
    logger.info('Parser scheduler started', { intervalMs: this.intervalMs });
  }

  async runParsing(): Promise<void> {
    if (this.isRunning) { this.pendingTrigger = true; return; }
    this.isRunning = true;
    this.pendingTrigger = false;
    const startTime = Date.now();
    try {
      const links = await this.db.getActiveLinks() as ParseLink[];
      const seen = new Set<string>();
      const uniqueLinks = links.filter(link => {
        const key = `${link.user_id}|${link.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      logger.info('🔄 Parsing cycle started', { linksCount: uniqueLinks.length, concurrency: this.concurrency });

      const results = await this.mapWithConcurrency(uniqueLinks, this.concurrency, link => this.parseLink(link));
      const allNewAds: Array<{ ad: any; telegramId: number }> = [];
      const allPriceDrops: Array<{ drop: any; telegramId: number; userId: number }> = [];

      // Fetch users in parallel. With many monitored links this avoids turning
      // notification preparation into N sequential database round trips.
      const userIds = [...new Set(uniqueLinks.map(link => link.user_id))];
      const userEntries = await Promise.all(userIds.map(async userId => [userId, await this.db.getUserById(userId)] as const));
      const users = new Map<number, { telegram_id: number; id: number }>();
      for (const [userId, user] of userEntries) if (user) users.set(userId, user);

      for (let i = 0; i < uniqueLinks.length; i++) {
        const result = results[i];
        if (!result) continue;
        const user = users.get(uniqueLinks[i].user_id);
        if (!user) continue;
        for (const ad of result.newAds) allNewAds.push({ ad, telegramId: user.telegram_id });
        for (const drop of result.priceDrops) allPriceDrops.push({ drop, telegramId: user.telegram_id, userId: user.id });
      }

      await Promise.all([this.notifyNewAds(allNewAds), this.notifyPriceDrops(allPriceDrops)]);
      const duration = Date.now() - startTime;
      logger.info('Parsing cycle completed', { duration: `${duration}ms`, linksCount: uniqueLinks.length, totalNewAds: allNewAds.length });
    } catch (error: any) {
      logger.error('Parsing cycle failed', { error: error.message, stack: error.stack });
    } finally {
      this.isRunning = false;
      if (this.pendingTrigger) { this.pendingTrigger = false; setImmediate(() => void this.runParsing()); }
    }
  }

  private async mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        try { results[index] = await worker(items[index]); }
        catch (error: any) { logger.error('Scheduler worker failed', { index, error: error?.message }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
    return results;
  }

  private async notifyNewAds(items: Array<{ ad: any; telegramId: number }>): Promise<void> {
    const groups = new Map<number, any[]>();
    const sent = new Set<string>();
    for (const { ad, telegramId } of items) {
      const key = `${telegramId}|${ad.external_id}`;
      if (sent.has(key)) continue;
      sent.add(key);
      groups.set(telegramId, [...(groups.get(telegramId) ?? []), ad]);
    }
    await Promise.all(Array.from(groups.entries()).map(async ([telegramId, ads]) => {
      for (const ad of ads) {
        try { await this.bot.sendNotification(telegramId, ad); }
        catch (error: any) { logger.error('Failed to send new-ad notification', { telegramId, externalId: ad?.external_id, error: error.message }); }
      }
    }));
  }

  private async notifyPriceDrops(items: Array<{ drop: any; telegramId: number; userId: number }>): Promise<void> {
    const groups = new Map<number, Array<{ drop: any; userId: number }>>();
    const dmSent = new Set<string>();
    const channelSent = new Set<string>();
    for (const item of items) {
      const key = `${item.telegramId}|${item.drop.externalId}`;
      if (dmSent.has(key)) continue;
      dmSent.add(key);
      groups.set(item.telegramId, [...(groups.get(item.telegramId) ?? []), { drop: item.drop, userId: item.userId }]);
    }
    await Promise.all(Array.from(groups.entries()).map(async ([telegramId, drops]) => {
      for (const { drop, userId } of drops) {
        try { await this.bot.sendPriceDropNotification(telegramId, drop); }
        catch (error: any) { logger.error('Failed to send price-drop notification', { telegramId, externalId: drop.externalId, error: error.message }); }
        const channelSub = await this.db.getActiveChannelSubscription(userId);
        if (channelSub) {
          const key = `${channelSub.channel_id}|${drop.externalId}`;
          if (!channelSent.has(key)) {
            channelSent.add(key);
            try { await this.bot.sendPriceDropNotification(channelSub.channel_id, drop); }
            catch (error: any) { logger.error('Failed to send price drop to channel', { channelId: channelSub.channel_id, externalId: drop.externalId, error: error.message }); }
          }
        }
      }
    }));
  }

  private async parseLink(link: ParseLink): Promise<ParseResult> {
    const newAds: any[] = [];
    const priceDrops: any[] = [];
    try {
      const parser = ParserFactory.getParser(link.platform as any);
      if (!parser) return { newAds, priceDrops };
      const parsePromise = parser.parseUrl(link.url);
      const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Parse timeout after 15 seconds')), 15000));
      let ads: any[];
      try { ads = await Promise.race([parsePromise, timeoutPromise]); }
      catch (error: any) { logger.warn('Parser request timed out or failed', { linkId: link.id, error: error.message }); await this.db.incrementErrorCount(link.id); return { newAds, priceDrops }; }
      if (!Array.isArray(ads)) { await this.db.incrementErrorCount(link.id); return { newAds, priceDrops }; }

      const isBaseline = !link.last_parsed_at;
      await this.db.updateLastParsed(link.id);
      if ((link.error_count ?? 0) > 0) await this.db.resetErrorCount(link.id);
      const processed = new Set<string>();
      for (const adData of ads) {
        if (!adData?.external_id || processed.has(adData.external_id)) continue;
        processed.add(adData.external_id);
        if (isBaseline) { await this.db.createAd(link.id, adData); continue; }
        const isNew = await this.db.isNewAdForUser(link.user_id, adData.external_id);
        if (!isNew) { await this.checkPriceDrop(link.id, adData.external_id, adData.price, priceDrops); continue; }
        const ad = await this.db.createAd(link.id, adData);
        if (ad) { newAds.push(ad); logger.info('📢 NEW AD DETECTED!', { linkId: link.id, external_id: adData.external_id, title: adData.title, price: adData.price, timestamp: new Date().toISOString() }); }
      }
      if (isBaseline) logger.info('Baseline snapshot stored; no notifications sent', { linkId: link.id, adsCount: processed.size });
      return { newAds, priceDrops };
    } catch (error: any) {
      logger.error('Failed to parse link', { linkId: link.id, url: link.url, error: error.message });
      await this.db.incrementErrorCount(link.id);
      const currentLink = await this.db.getLink(link.id);
      if (currentLink && currentLink.error_count >= 5) { await this.db.markLinkInactive(link.id); logger.warn('Link marked inactive', { linkId: link.id, errorCount: currentLink.error_count }); }
      return { newAds, priceDrops };
    }
  }

  private async checkPriceDrop(linkId: number, externalId: string, newPrice: string, priceDrops: any[]): Promise<void> {
    try {
      const lastPrice = await this.db.getLastPriceForAd(linkId, externalId);
      if (!lastPrice) return;
      const oldPriceNum = this.db.parsePriceToNumber(lastPrice.price);
      const newPriceNum = this.db.parsePriceToNumber(newPrice);
      if (oldPriceNum === null || newPriceNum === null) return;
      if (newPriceNum < oldPriceNum) {
        const changePercent = ((oldPriceNum - newPriceNum) / oldPriceNum * 100).toFixed(1);
        const recorded = await this.db.createPriceDropRecord(lastPrice.adId, externalId, lastPrice.price, newPrice, parseFloat(changePercent));
        if (recorded) priceDrops.push({ adId: lastPrice.adId, oldPrice: lastPrice.price, newPrice, changePercent, externalId, linkId });
      }
      if (oldPriceNum !== newPriceNum) await this.db.updateAdPrice(lastPrice.adId, newPrice);
    } catch (error: any) { logger.error('Failed to check price drop', { linkId, externalId, error: error.message }); }
  }

  stop(): void { if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; } this.pendingTrigger = false; logger.info('Parser scheduler stopped'); }
  triggerParse(): void { if (this.isRunning) { this.pendingTrigger = true; return; } void this.runParsing(); }
}
