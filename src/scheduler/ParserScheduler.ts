import { DatabaseService } from '../database/DatabaseService';
import { ParserFactory } from '../parsers/ParserFactory';
import { BotHandler } from '../bot/BotHandler';
import { Ad, Platform } from '../types';
import { logger } from '../utils/logger';

interface ParseLink {
  id: number;
  user_id: number;
  url: string;
  platform: Platform;
  last_parsed_at?: Date | null;
  error_count?: number;
}

interface PriceDrop {
  adId: number;
  oldPrice: string;
  newPrice: string;
  changePercent: string;
  externalId: string;
  linkId: number;
}

interface ParseResult {
  newAds: Ad[];
  priceDrops: PriceDrop[];
}

interface NewAdNotification {
  ad: Ad;
  telegramId: number;
  userId: number;
}

export class ParserScheduler {
  private readonly db: DatabaseService;
  private readonly bot: BotHandler;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private isRunning = false;
  private pendingTrigger = false;

  constructor(db: DatabaseService, bot: BotHandler) {
    this.db = db;
    this.bot = bot;
    const seconds = Number.parseInt(process.env.PARSE_INTERVAL_SECONDS || '5', 10);
    const concurrency = Number.parseInt(process.env.PARSE_CONCURRENCY || '5', 10);
    this.intervalMs = Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 5000);
    this.concurrency = Math.max(1, Math.min(20, Number.isFinite(concurrency) ? concurrency : 5));
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
    const startedAt = Date.now();
    try {
      const links = await this.db.getActiveLinks() as ParseLink[];
      const seen = new Set<string>();
      const unique = links.filter(link => {
        const key = `${link.user_id}|${link.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      logger.info('🔄 Parsing cycle started', { linksCount: unique.length, concurrency: this.concurrency });

      const results = await this.mapWithConcurrency(unique, this.concurrency, link => this.parseLink(link));
      const allNew: NewAdNotification[] = [];
      const allDrops: Array<{ drop: PriceDrop; telegramId: number; userId: number }> = [];
      const userIds = [...new Set(unique.map(link => link.user_id))];
      const entries = await Promise.all(userIds.map(async id => [id, await this.db.getUserById(id)] as const));
      const users = new Map<number, { telegram_id: number; id: number }>();
      for (const [id, user] of entries) if (user) users.set(id, user);

      for (let i = 0; i < unique.length; i += 1) {
        const result = results[i];
        const user = users.get(unique[i].user_id);
        if (!result || !user) continue;
        for (const ad of result.newAds) allNew.push({ ad, telegramId: user.telegram_id, userId: user.id });
        for (const drop of result.priceDrops) allDrops.push({ drop, telegramId: user.telegram_id, userId: user.id });
      }

      await Promise.all([this.notifyNewAds(allNew), this.notifyPriceDrops(allDrops)]);
      logger.info('Parsing cycle completed', {
        duration: `${Date.now() - startedAt}ms`, linksCount: unique.length,
        totalNewAds: allNew.length, totalPriceDrops: allDrops.length,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Parsing cycle failed', { error: message, stack });
    } finally {
      this.isRunning = false;
      if (this.pendingTrigger) {
        this.pendingTrigger = false;
        setImmediate(() => void this.runParsing());
      }
    }
  }

  private async mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const run = async (): Promise<void> => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        try { results[index] = await worker(items[index]); }
        catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('Scheduler worker failed', { index, error: message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
    return results;
  }

  private async notifyNewAds(items: NewAdNotification[]): Promise<void> {
    const groups = new Map<number, { userId: number; ads: Ad[] }>();
    for (const { ad, telegramId, userId } of items) {
      const group = groups.get(telegramId) ?? { userId, ads: [] };
      if (!group.ads.some(item => item.external_id === ad.external_id)) group.ads.push(ad);
      groups.set(telegramId, group);
    }

    await Promise.all([...groups].map(async ([telegramId, { userId, ads }]) => {
      const subscription = await this.db.getActiveChannelSubscription(userId);
      for (const ad of ads) {
        try {
          await this.bot.sendNotification(telegramId, ad);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('Failed to send new-ad notification', { telegramId, externalId: ad.external_id, error: message });
        }

        if (subscription) {
          try {
            await this.bot.sendNotification(subscription.channel_id, ad);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('Failed to send new ad to channel', {
              channelId: subscription.channel_id,
              externalId: ad.external_id,
              error: message,
            });
          }
        }
      }
    }));
  }

  private async notifyPriceDrops(items: Array<{ drop: PriceDrop; telegramId: number; userId: number }>): Promise<void> {
    const groups = new Map<number, Array<{ drop: PriceDrop; userId: number }>>();
    for (const item of items) {
      const group = groups.get(item.telegramId) ?? [];
      if (!group.some(x => x.drop.externalId === item.drop.externalId)) group.push({ drop: item.drop, userId: item.userId });
      groups.set(item.telegramId, group);
    }
    await Promise.all([...groups].map(async ([telegramId, drops]) => {
      const userId = drops[0]?.userId;
      if (!userId) return;
      const subscription = await this.db.getActiveChannelSubscription(userId);
      for (const { drop } of drops) {
        try { await this.bot.sendPriceDropNotification(telegramId, drop); }
        catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('Failed to send price-drop notification', { telegramId, externalId: drop.externalId, error: message });
        }
        if (subscription) {
          try { await this.bot.sendPriceDropNotification(subscription.channel_id, drop); }
          catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('Failed to send price drop to channel', { channelId: subscription.channel_id, externalId: drop.externalId, error: message });
          }
        }
      }
    }));
  }

  private async parseLink(link: ParseLink): Promise<ParseResult> {
    const newAds: Ad[] = [];
    const priceDrops: PriceDrop[] = [];
    try {
      const parser = ParserFactory.getParser(link.platform);
      if (!parser) return { newAds, priceDrops };

      let ads: Ad[];
      try {
        ads = await this.withTimeout(parser.parseUrl(link.url), 9000, 'Parse timeout after 9 seconds');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await this.recordLinkFailure(link, message);
        return { newAds, priceDrops };
      }
      if (!Array.isArray(ads)) {
        await this.recordLinkFailure(link, 'Parser returned a non-array result');
        return { newAds, priceDrops };
      }

      const baseline = !link.last_parsed_at;
      const externalIds = [...new Set(ads.filter(ad => ad?.external_id).map(ad => String(ad.external_id)))];

      if (baseline) {
        const created = await this.db.bulkCreateAds(link.id, ads);
        await this.db.updateLastParsed(link.id);
        if ((link.error_count ?? 0) > 0) await this.db.resetErrorCount(link.id);
        logger.info('Baseline snapshot stored; no notifications sent', { linkId: link.id, adsFound: externalIds.length, adsInserted: created });
        return { newAds, priceDrops };
      }

      const existing = await this.db.getExistingAdExternalIdsForLink(link.id, externalIds);
      const prices = await this.db.getLastPricesForAds(link.id, externalIds);
      const processed = new Set<string>();
      for (const adData of ads) {
        const id = adData?.external_id;
        if (!id || processed.has(id)) continue;
        processed.add(id);
        if (existing.has(id)) {
          const last = prices.get(id);
          if (last && adData.price) await this.processPriceDrop(last, id, adData.price, priceDrops, link.id, link.user_id);
          continue;
        }
        const ad = await this.db.createAd(link.id, adData);
        if (ad) {
          newAds.push(ad);
          existing.add(id);
          logger.info('📢 NEW AD DETECTED!', { linkId: link.id, external_id: id, title: adData.title, price: adData.price, timestamp: new Date().toISOString() });
        }
      }
      await this.db.updateLastParsed(link.id);
      if ((link.error_count ?? 0) > 0) await this.db.resetErrorCount(link.id);
      return { newAds, priceDrops };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Failed to parse link', { linkId: link.id, url: link.url, error: message, stack });
      try {
        await this.recordLinkFailure(link, message);
      } catch (failureError: unknown) {
        const failureMessage = failureError instanceof Error ? failureError.message : String(failureError);
        logger.error('Failed to record link parse failure', { linkId: link.id, error: failureMessage });
      }
      return { newAds, priceDrops };
    }
  }

  private async recordLinkFailure(link: ParseLink, reason: string): Promise<void> {
    await this.db.incrementErrorCount(link.id);
    const current = await this.db.getLink(link.id);
    const errorCount = current?.error_count ?? ((link.error_count ?? 0) + 1);
    logger.warn('Link parse failure', { linkId: link.id, errorCount, reason });
    if (errorCount >= 5) {
      await this.db.markLinkInactive(link.id);
      logger.warn('Link marked inactive', { linkId: link.id, errorCount });
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async processPriceDrop(last: { price: string; adId: number }, externalId: string, newPrice: string, priceDrops: PriceDrop[], linkId: number, userId: number): Promise<void> {
    try {
      const oldNumber = this.db.parsePriceToNumber(last.price);
      const newNumber = this.db.parsePriceToNumber(newPrice);
      if (oldNumber === null || newNumber === null || oldNumber <= 0) return;
      if (newNumber < oldNumber) {
        const percent = ((oldNumber - newNumber) / oldNumber * 100).toFixed(1);
        const recorded = await this.db.createPriceDropRecord(userId, last.adId, externalId, last.price, newPrice, Number(percent));
        if (recorded) priceDrops.push({ adId: last.adId, oldPrice: last.price, newPrice, changePercent: percent, externalId, linkId });
      }
      if (oldNumber !== newNumber) await this.db.updateAdPrice(last.adId, newPrice);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to check price drop', { linkId, externalId, error: message });
    }
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    this.pendingTrigger = false;
    logger.info('Parser scheduler stopped');
  }

  triggerParse(): void {
    if (this.isRunning) { this.pendingTrigger = true; return; }
    void this.runParsing();
  }
}
