import { ParserScheduler } from '../scheduler/ParserScheduler';
import { ParserFactory } from '../parsers/ParserFactory';
import { Ad, Link, User } from '../types';

jest.mock('../parsers/ParserFactory', () => ({
  ParserFactory: {
    getParser: jest.fn(),
  },
}));

describe('ParserScheduler', () => {
  const parser = { parseUrl: jest.fn() };
  const bot = {
    sendNotification: jest.fn().mockResolvedValue(undefined),
    sendPriceDropNotification: jest.fn().mockResolvedValue(undefined),
  };
  const user: User = {
    id: 1,
    telegram_id: 12345,
    username: 'tester',
    created_at: new Date(),
  };

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

  function makeDb(linkList: Link[], existingIds: Set<string> = new Set(), notificationInsertCount?: number) {
    const ads = new Map<string, Ad>();
    const userSeen = new Set<string>();
    return {
      getActiveLinks: jest.fn().mockResolvedValue(linkList),
      getUserById: jest.fn().mockResolvedValue(user),
      getUsersByIds: jest.fn().mockResolvedValue([user]),
      bulkCreateAds: jest.fn().mockImplementation(async (_linkId: number, input: Ad[]) => {
        for (const ad of input) ads.set(ad.external_id, { ...ad, id: ads.size + 1 });
        return input.length;
      }),
      bulkCreateAdsReturning: jest.fn().mockImplementation(async (linkId: number, input: Ad[]) => {
        const inserted = input.map((ad) => ({ ...ad, id: ads.size + 1, link_id: linkId, created_at: new Date() }));
        for (const ad of inserted) ads.set(ad.external_id, ad);
        return inserted;
      }),
      updateLastParsed: jest.fn().mockResolvedValue(undefined),
      resetErrorCount: jest.fn().mockResolvedValue(undefined),
      getExistingAdExternalIdsForLink: jest.fn().mockResolvedValue(new Set(existingIds)),
      getLastPricesForAds: jest.fn().mockResolvedValue(new Map()),
      getExistingAdStatesForLink: jest.fn().mockResolvedValue({ existingIds: new Set(existingIds), prices: new Map() }),
      getRecentMarketPrices: jest.fn().mockResolvedValue([]),
      updateAdMarketSignals: jest.fn().mockResolvedValue(undefined),
      claimNewAdsForUser: jest.fn().mockImplementation(async (_userId: number, _linkId: number, input: Ad[]) => {
        const claimed = input.filter(ad => !userSeen.has(ad.external_id)).map(ad => ad.external_id);
        claimed.forEach(id => userSeen.add(id));
        return new Set(claimed);
      }),
      createAd: jest.fn(),
      getLink: jest.fn().mockResolvedValue(null),
      incrementErrorCount: jest.fn().mockResolvedValue(undefined),
      markLinkInactive: jest.fn().mockResolvedValue(undefined),
      getActiveChannelSubscription: jest.fn().mockResolvedValue(null),
      parsePriceToNumber: jest.fn(),
      createPriceDropRecord: jest.fn(),
      updateAdPrice: jest.fn(),
      enqueueNotification: jest.fn().mockResolvedValue(undefined),
      enqueueNotifications: jest.fn().mockImplementation(async (jobs: Array<{ dedupeKey: string }>) => notificationInsertCount ?? jobs.length),
      claimNotificationJobs: jest.fn().mockResolvedValue([]),
      purgeNotificationOutbox: jest.fn().mockResolvedValue(0),
      getPendingNotificationStats: jest.fn().mockResolvedValue({ count: 0, oldestAgeMs: 0 }),
      getActiveLinkFreshnessStats: jest.fn().mockResolvedValue({ activeLinks: linkList.length, oldestAgeMs: 0, avgAgeMs: 0 }),
      scheduleNextChecks: jest.fn().mockResolvedValue(undefined),
    };
  }

  test('batches next-check scheduling for every parsed link', async () => { const links=[makeLink(1,new Date()),makeLink(2,new Date())]; parser.parseUrl.mockResolvedValue([]); const db=makeDb(links); const scheduler=new ParserScheduler(db as never,bot as never); await scheduler.runParsing(); expect(db.scheduleNextChecks).toHaveBeenCalledTimes(1); expect(db.scheduleNextChecks.mock.calls[0][0]).toHaveLength(2); expect(db.scheduleNextChecks.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({linkId:1}),expect.objectContaining({linkId:2})])); });


  test('applies exponential backoff to failed links in the batch schedule', async () => {
    const link = makeLink(1, new Date());
    parser.parseUrl.mockRejectedValue(new Error('upstream timeout'));
    const db = makeDb([link]);
    const scheduler = new ParserScheduler(db as never, bot as never);

    await scheduler.runParsing();

    const scheduled = db.scheduleNextChecks.mock.calls[0][0] as Array<{linkId:number;delayMs:number}>;
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].linkId).toBe(1);
    expect(scheduled[0].delayMs).toBeGreaterThanOrEqual(10000);
    expect(scheduled[0].delayMs).toBeLessThanOrEqual(10750);
  });

  test('stores baseline ads without notifying the user', async () => {
    const link = makeLink(1);
    const ads: Ad[] = [
      { external_id: 'ad-1', title: 'First', ad_url: 'https://kufar.by/ad-1' },
      { external_id: 'ad-2', title: 'Second', ad_url: 'https://kufar.by/ad-2' },
    ];
    parser.parseUrl.mockResolvedValue(ads);
    const db = makeDb([link]);
    const scheduler = new ParserScheduler(db as never, bot as never);

    await scheduler.runParsing();

    expect(db.bulkCreateAds).toHaveBeenCalledWith(1, ads);
    expect(db.enqueueNotifications).toHaveBeenCalledTimes(2);
    const queuedBatches = db.enqueueNotifications.mock.calls.map(([jobs]) => jobs);
    expect(queuedBatches).toEqual([[], []]);
  });

  test('queues only genuinely new ads after baseline', async () => {
    const link = makeLink(1, new Date());
    const ad: Ad = { external_id: 'new-1', title: 'New', ad_url: 'https://kufar.by/new-1' };
    parser.parseUrl.mockResolvedValue([ad]);
    const db = makeDb([link]);
    const scheduler = new ParserScheduler(db as never, bot as never);

    await scheduler.runParsing();

    expect(db.bulkCreateAdsReturning).toHaveBeenCalledWith(1, [expect.objectContaining(ad)]);
    expect(db.enqueueNotifications).toHaveBeenCalledTimes(2);
    const queuedBatches = db.enqueueNotifications.mock.calls.map(([jobs]) => jobs);
    expect(queuedBatches).toEqual(expect.arrayContaining([
      [],
      [
        {
          kind: 'new_ad',
          chatId: user.telegram_id,
          dedupeKey: `new_ad:user:${user.telegram_id}:new-1`,
          payload: { ad: expect.objectContaining({ external_id: 'new-1' }) },
        },
      ],
    ]));
    expect(bot.sendNotification).not.toHaveBeenCalled();
  });

  test('exposes bounded performance and notification queue metrics', async () => {
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
    expect(metrics.scheduler.skippedTicks).toBe(0);
  });

  test('counts notification jobs suppressed by database dedupe', async () => {
    const link = makeLink(1, new Date());
    const ad: Ad = { external_id: 'dedupe-1', title: 'Dedupe', ad_url: 'https://kufar.by/dedupe-1' };
    parser.parseUrl.mockResolvedValue([ad]);
    const db = makeDb([link], new Set(), 0);
    const scheduler = new ParserScheduler(db as never, bot as never);

    await scheduler.runParsing();
    const metrics = await scheduler.getMetrics();

    expect(metrics.duplicateNotifications).toBe(1);
  });

  test('counts price drop notification jobs suppressed by database dedupe', async () => {
    const link = makeLink(1, new Date());
    const db = makeDb([link], new Set(), 0);
    const scheduler = new ParserScheduler(db as never, bot as never);
    const drop = {
      externalId: 'drop-1',
      oldPrice: 100,
      newPrice: 90,
      ad: { external_id: 'drop-1', title: 'Drop', ad_url: 'https://kufar.by/drop-1' },
    };

    await (scheduler as any).notifyPriceDrops([{ drop, telegramId: user.telegram_id, userId: user.id }]);
    const metrics = await scheduler.getMetrics();

    expect(metrics.duplicateNotifications).toBe(1);
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

  test('deduplicates the same new ad across multiple saved searches for one user', async () => {
    const links = [makeLink(1, new Date()), makeLink(2, new Date())];
    const ad: Ad = { external_id: 'shared-1', title: 'Shared', ad_url: 'https://kufar.by/shared-1' };
    parser.parseUrl.mockResolvedValue([ad]);
    const db = makeDb(links);
    const scheduler = new ParserScheduler(db as never, bot as never);

    await scheduler.runParsing();

    expect(db.bulkCreateAdsReturning).toHaveBeenCalledTimes(2);
    expect(db.enqueueNotifications).toHaveBeenCalledTimes(2);
    const queuedBatches = db.enqueueNotifications.mock.calls.map(([jobs]) => jobs);
    expect(queuedBatches).toEqual(expect.arrayContaining([
      [],
      [
        {
          kind: 'new_ad',
          chatId: user.telegram_id,
          dedupeKey: `new_ad:user:${user.telegram_id}:shared-1`,
          payload: { ad: expect.objectContaining({ external_id: 'shared-1' }) },
        },
      ],
    ]));
  });
});
