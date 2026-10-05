import { ParserScheduler } from '../scheduler/ParserScheduler';
import { ParserFactory } from '../parsers/ParserFactory';
import { Ad, Link, User } from '../types';

jest.mock('../parsers/ParserFactory', () => ({
  ParserFactory: { getParser: jest.fn() },
}));

describe('ParserScheduler', () => {
  const parser = { parseUrl: jest.fn() };
  const bot = {
    sendNotification: jest.fn().mockResolvedValue(undefined),
    sendPriceDropNotification: jest.fn().mockResolvedValue(undefined),
  };
  const user: User = { id: 1, telegram_id: 12345, username: 'tester', created_at: new Date() };

  beforeEach(() => {
    jest.clearAllMocks();
    (ParserFactory.getParser as jest.Mock).mockReturnValue(parser);
    process.env.PARSE_INTERVAL_SECONDS = '5';
    process.env.PARSE_CONCURRENCY = '2';
  });

  function makeLink(id: number, lastParsedAt: Date | null = null): Link {
    return {
      id,
      user_id: 1,
      url: `https://kufar.by/l/search-${id}`,
      platform: 'kufar',
      is_active: true,
      error_count: 0,
      last_parsed_at: lastParsedAt,
      created_at: new Date(),
    };
  }

  function makeDb(linkList: Link[], notificationInsertCount?: number) {
    const ads = new Map<string, Ad>();
    const userSeen = new Set<string>();
    return {
      getActiveLinks: jest.fn().mockResolvedValue(linkList),
      getUsersByIds: jest.fn().mockResolvedValue([user]),
      bulkCreateAdsReturning: jest.fn().mockImplementation(async (linkId: number, input: Ad[]) => {
        const inserted = input.map(ad => ({ ...ad, id: ads.size + 1, link_id: linkId, created_at: new Date() }));
        for (const ad of inserted) ads.set(ad.external_id, ad);
        return inserted;
      }),
      updateLastParsed: jest.fn().mockResolvedValue(undefined),
      resetErrorCount: jest.fn().mockResolvedValue(undefined),
      getExistingAdStatesForLink: jest.fn().mockResolvedValue({ existingIds: new Set<string>(), prices: new Map(), market: new Map() }),
      getRecentMarketAds: jest.fn().mockResolvedValue([]),
      updateAdMarketSignals: jest.fn().mockResolvedValue(undefined),
      claimNewAdsForUser: jest.fn().mockImplementation(async (_userId: number, _linkId: number, input: Ad[]) => {
        const claimed = input.filter(ad => !userSeen.has(ad.external_id)).map(ad => ad.external_id);
        claimed.forEach(id => userSeen.add(id));
        return new Set(claimed);
      }),
      getLink: jest.fn().mockImplementation(async (id: number) => linkList.find(link => link.id === id) ?? null),
      incrementErrorCount: jest.fn().mockResolvedValue(undefined),
      createPriceDropRecord: jest.fn().mockResolvedValue(true),
      updateAdPrice: jest.fn().mockResolvedValue(undefined),
      enqueueNotifications: jest.fn().mockImplementation(async (jobs: unknown[]) => notificationInsertCount ?? jobs.length),
      claimNotificationJobs: jest.fn().mockResolvedValue([]),
      purgeNotificationOutbox: jest.fn().mockResolvedValue(0),
      getPendingNotificationStats: jest.fn().mockResolvedValue({ count: 0, oldestAgeMs: 0 }),
      getActiveLinkFreshnessStats: jest.fn().mockResolvedValue({ activeLinks: linkList.length, oldestAgeMs: 0, avgAgeMs: 0 }),
      scheduleNextChecks: jest.fn().mockResolvedValue(undefined),
    };
  }

  test('batches next-check scheduling for every parsed link', async () => {
    const links = [makeLink(1, new Date()), makeLink(2, new Date())];
    parser.parseUrl.mockResolvedValue([]);
    const db = makeDb(links);
    await new ParserScheduler(db as never, bot as never).runParsing();

    expect(db.scheduleNextChecks).toHaveBeenCalledTimes(1);
    expect(db.scheduleNextChecks.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ linkId: 1 }),
      expect.objectContaining({ linkId: 2 }),
    ]));
  });

  test('applies exponential backoff to failed links', async () => {
    const link = makeLink(1, new Date());
    parser.parseUrl.mockRejectedValue(new Error('upstream timeout'));
    const db = makeDb([link]);
    await new ParserScheduler(db as never, bot as never).runParsing();

    const scheduled = db.scheduleNextChecks.mock.calls[0][0] as Array<{ linkId: number; delayMs: number }>;
    expect(scheduled[0].linkId).toBe(1);
    expect(scheduled[0].delayMs).toBeGreaterThanOrEqual(10000);
    expect(scheduled[0].delayMs).toBeLessThanOrEqual(10750);
  });

  test('stores baseline ads without notifying', async () => {
    const link = makeLink(1);
    const ads: Ad[] = [
      { external_id: 'ad-1', title: 'First', ad_url: 'https://kufar.by/ad-1' },
      { external_id: 'ad-2', title: 'Second', ad_url: 'https://kufar.by/ad-2' },
    ];
    parser.parseUrl.mockResolvedValue(ads);
    const db = makeDb([link]);

    await new ParserScheduler(db as never, bot as never).runParsing();

    expect(db.bulkCreateAdsReturning).toHaveBeenCalledWith(1, expect.arrayContaining(ads.map(ad => expect.objectContaining(ad))));
    expect(db.enqueueNotifications).not.toHaveBeenCalled();
    expect(db.updateLastParsed).toHaveBeenCalledWith(1);
  });

  test('keeps market history independent from deal notification filters', async () => {
    const link = makeLink(1, new Date());
    link.config = { source: 'kufar', categoryId: 'phones', subcategoryId: '17010', minMarketDiscount: 20 };
    const marketHistory: Ad[] = Array.from({ length: 8 }, (_, i) => ({
      external_id: `market-${i}`,
      title: 'iPhone 15 128GB',
      price: '1000 BYN',
      ad_url: `https://kufar.by/ad/market-${i}`,
      location: 'Минск',
      condition: 'used',
    }));
    const deal: Ad = {
      external_id: 'deal-1',
      title: 'iPhone 15 128GB',
      price: '700 BYN',
      ad_url: 'https://kufar.by/ad/deal-1',
      location: 'Минск',
      condition: 'used',
    };
    const ordinary: Ad = {
      external_id: 'ordinary-1',
      title: 'iPhone 15 128GB',
      price: '950 BYN',
      ad_url: 'https://kufar.by/ad/ordinary-1',
      location: 'Минск',
      condition: 'used',
    };
    parser.parseUrl.mockResolvedValue([deal, ordinary]);
    const db = makeDb([link]);
    db.getRecentMarketAds.mockResolvedValue(marketHistory);

    await new ParserScheduler(db as never, bot as never).runParsing();

    const stored = db.bulkCreateAdsReturning.mock.calls[0][1] as Ad[];
    expect(stored).toHaveLength(2);
    expect(stored.map(ad => ad.external_id)).toEqual(expect.arrayContaining(['deal-1', 'ordinary-1']));
  });

  test('queues only genuinely new ads after baseline', async () => {
    const link = makeLink(1, new Date());
    const ad: Ad = { external_id: 'new-1', title: 'New', ad_url: 'https://kufar.by/new-1' };
    parser.parseUrl.mockResolvedValue([ad]);
    const db = makeDb([link]);

    await new ParserScheduler(db as never, bot as never).runParsing();

    expect(db.bulkCreateAdsReturning).toHaveBeenCalledWith(1, [expect.objectContaining(ad)]);
    expect(db.enqueueNotifications).toHaveBeenCalledTimes(1);
    expect(db.enqueueNotifications.mock.calls[0][0]).toEqual([expect.objectContaining({
      kind: 'new_ad',
      chatId: user.telegram_id,
      dedupeKey: `new_ad:user:${user.telegram_id}:new-1`,
      payload: { ad: expect.objectContaining({ external_id: 'new-1' }) },
    })]);
    expect(bot.sendNotification).not.toHaveBeenCalled();
  });

  test('suppresses duplicate notification jobs reported by the database', async () => {
    const link = makeLink(1, new Date());
    const ad: Ad = { external_id: 'dedupe-1', title: 'Dedupe', ad_url: 'https://kufar.by/dedupe-1' };
    parser.parseUrl.mockResolvedValue([ad]);
    const db = makeDb([link], 0);

    const scheduler = new ParserScheduler(db as never, bot as never);
    await scheduler.runParsing();
    const metrics = await scheduler.getMetrics();

    expect(db.enqueueNotifications).toHaveBeenCalledTimes(1);
    expect(metrics.duplicateNotifications).toBe(1);
  });

  test('exposes bounded performance and notification metrics', async () => {
    const link = makeLink(1, new Date());
    parser.parseUrl.mockResolvedValue([]);
    const db = makeDb([link]);
    db.getPendingNotificationStats.mockResolvedValue({ count: 3, oldestAgeMs: 4200 });

    const scheduler = new ParserScheduler(db as never, bot as never);
    await scheduler.runParsing();
    const metrics = await scheduler.getMetrics();

    expect(metrics.scheduler.cycles).toBe(1);
    expect(metrics.scheduler.linksParsed).toBe(1);
    expect(metrics.scheduler.cycleDurationMs.last).toBeGreaterThanOrEqual(0);
    expect(metrics.notifications.pending).toBe(3);
    expect(metrics.notifications.oldestAgeMs).toBe(4200);
    expect(metrics.scheduler.activeLinks).toBe(1);
    expect(metrics.scheduler.cycleDurationMs.p99).toBeGreaterThanOrEqual(0);
    expect(metrics.scheduler.freshnessLagMs.oldest).toBe(0);
    expect(metrics.scheduler.adsPerMinute).toBeGreaterThanOrEqual(0);
  });

  test('shutdown waits for an active parse and blocks new triggers', async () => {
    const link = makeLink(1, new Date());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    parser.parseUrl.mockImplementation(async () => { await gate; return []; });
    const db = makeDb([link]);
    const scheduler = new ParserScheduler(db as never, bot as never);

    const parsing = scheduler.runParsing();
    await new Promise<void>(resolve => setImmediate(resolve));

    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);

    scheduler.triggerParse();
    release();

    await parsing;
    await stopping;
    expect(stopped).toBe(true);
    expect(db.getActiveLinks).toHaveBeenCalledTimes(1);
  });

  test('deduplicates the same new ad across multiple searches for one user', async () => {
    const links = [makeLink(1, new Date()), makeLink(2, new Date())];
    const ad: Ad = { external_id: 'shared-1', title: 'Shared', ad_url: 'https://kufar.by/shared-1' };
    parser.parseUrl.mockResolvedValue([ad]);
    const db = makeDb(links);

    await new ParserScheduler(db as never, bot as never).runParsing();

    expect(db.bulkCreateAdsReturning).toHaveBeenCalledTimes(2);
    expect(db.enqueueNotifications).toHaveBeenCalledTimes(1);
    expect(db.enqueueNotifications.mock.calls[0][0][0]).toEqual(expect.objectContaining({
      dedupeKey: `new_ad:user:${user.telegram_id}:shared-1`,
    }));
  });
});
