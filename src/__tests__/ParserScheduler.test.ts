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

  function makeDb(linkList: Link[], existingIds: Set<string> = new Set()) {
    const ads = new Map<string, Ad>();
    return {
      getActiveLinks: jest.fn().mockResolvedValue(linkList),
      getUserById: jest.fn().mockResolvedValue(user),
      bulkCreateAds: jest.fn().mockImplementation(async (_linkId: number, input: Ad[]) => {
        for (const ad of input) ads.set(ad.external_id, { ...ad, id: ads.size + 1 });
        return input.length;
      }),
      updateLastParsed: jest.fn().mockResolvedValue(undefined),
      resetErrorCount: jest.fn().mockResolvedValue(undefined),
      getExistingAdExternalIdsForLink: jest.fn().mockResolvedValue(new Set(existingIds)),
      getLastPricesForAds: jest.fn().mockResolvedValue(new Map()),
      createAd: jest.fn().mockImplementation(async (linkId: number, ad: Ad) => {
        const created = { ...ad, id: ads.size + 1, link_id: linkId, created_at: new Date() };
        ads.set(ad.external_id, created);
        return created;
      }),
      getLink: jest.fn().mockResolvedValue(null),
      incrementErrorCount: jest.fn().mockResolvedValue(undefined),
      markLinkInactive: jest.fn().mockResolvedValue(undefined),
      getActiveChannelSubscription: jest.fn().mockResolvedValue(null),
      parsePriceToNumber: jest.fn(),
      createPriceDropRecord: jest.fn(),
      updateAdPrice: jest.fn(),
    };
  }

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
    expect(bot.sendNotification).not.toHaveBeenCalled();
  });

  test('notifies only genuinely new ads after baseline', async () => {
    const link = makeLink(1, new Date());
    const ad: Ad = { external_id: 'new-1', title: 'New', ad_url: 'https://kufar.by/new-1' };
    parser.parseUrl.mockResolvedValue([ad]);
    const db = makeDb([link]);
    const scheduler = new ParserScheduler(db as never, bot as never);

    await scheduler.runParsing();

    expect(db.createAd).toHaveBeenCalledWith(1, ad);
    expect(bot.sendNotification).toHaveBeenCalledTimes(1);
    expect(bot.sendNotification).toHaveBeenCalledWith(user.telegram_id, expect.objectContaining({ external_id: 'new-1' }));
  });

  test('deduplicates the same new ad across multiple saved searches for one user', async () => {
    const links = [makeLink(1, new Date()), makeLink(2, new Date())];
    const ad: Ad = { external_id: 'shared-1', title: 'Shared', ad_url: 'https://kufar.by/shared-1' };
    parser.parseUrl.mockResolvedValue([ad]);
    const db = makeDb(links);
    const scheduler = new ParserScheduler(db as never, bot as never);

    await scheduler.runParsing();

    expect(db.createAd).toHaveBeenCalledTimes(2);
    expect(bot.sendNotification).toHaveBeenCalledTimes(1);
    expect(bot.sendNotification).toHaveBeenCalledWith(user.telegram_id, expect.objectContaining({ external_id: 'shared-1' }));
  });
});
