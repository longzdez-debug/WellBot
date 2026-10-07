import { ParserScheduler } from '../scheduler/ParserScheduler';

describe('ParserScheduler notification reliability', () => {
  const bot = {
    sendNotification: jest.fn().mockResolvedValue(undefined),
    sendPriceDropNotification: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NOTIFICATION_CONCURRENCY = '2';
    process.env.NOTIFICATION_MAX_ATTEMPTS = '3';
  });

  test('mapWithConcurrency never exceeds configured concurrency', async () => {
    const scheduler = new ParserScheduler({} as never, bot as never) as any;
    let inFlight = 0;
    let maxInFlight = 0;

    await scheduler.mapWithConcurrency(Array.from({ length: 7 }, (_, i) => i), 2, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    expect(maxInFlight).toBe(2);
    expect(inFlight).toBe(0);
  });

  test('failed notification is rescheduled instead of being marked sent', async () => {
    const db = {
      rescheduleNotification: jest.fn().mockResolvedValue(undefined),
      markNotificationSent: jest.fn().mockResolvedValue(undefined),
      discardNotification: jest.fn().mockResolvedValue(undefined),
      isAdDismissedForChat: jest.fn().mockResolvedValue(false),
    };
    const failingBot = {
      sendNotification: jest.fn().mockRejectedValue(new Error('telegram unavailable')),
      sendPriceDropNotification: jest.fn(),
    };
    const scheduler = new ParserScheduler(db as never, failingBot as never) as any;

    await scheduler.deliverNotification({
      id: 41,
      kind: 'new_ad',
      chat_id: 123,
      dedupe_key: 'new_ad:user:123:ad-41',
      payload: { ad: { external_id: 'ad-41', title: 'Test', ad_url: 'https://example.com/ad-41' } },
      attempts: 0,
      available_at: new Date(),
      locked_until: new Date(),
      sent_at: null,
      last_error: null,
      created_at: new Date(),
    });

    expect(db.rescheduleNotification).toHaveBeenCalledWith(41, 'telegram unavailable', 2);
    expect(db.markNotificationSent).not.toHaveBeenCalled();
    expect(db.discardNotification).not.toHaveBeenCalled();
  });

  test('retry limit discards a permanently failing notification', async () => {
    const db = {
      rescheduleNotification: jest.fn().mockResolvedValue(undefined),
      markNotificationSent: jest.fn().mockResolvedValue(undefined),
      discardNotification: jest.fn().mockResolvedValue(undefined),
      isAdDismissedForChat: jest.fn().mockResolvedValue(false),
    };
    const failingBot = {
      sendNotification: jest.fn().mockRejectedValue(new Error('permanent failure')),
      sendPriceDropNotification: jest.fn(),
    };
    const scheduler = new ParserScheduler(db as never, failingBot as never) as any;

    await scheduler.deliverNotification({
      id: 42,
      kind: 'new_ad',
      chat_id: 123,
      dedupe_key: 'new_ad:user:123:ad-42',
      payload: { ad: { external_id: 'ad-42', title: 'Test', ad_url: 'https://example.com/ad-42' } },
      attempts: 2,
      available_at: new Date(),
      locked_until: new Date(),
      sent_at: null,
      last_error: null,
      created_at: new Date(),
    });

    expect(db.discardNotification).toHaveBeenCalledWith(42, expect.stringContaining('retry limit reached (3)'));
    expect(db.rescheduleNotification).not.toHaveBeenCalled();
    expect(db.markNotificationSent).not.toHaveBeenCalled();
  });
  test('suppresses dismissed price-drop notifications', async () => {
    const db = {
      rescheduleNotification: jest.fn().mockResolvedValue(undefined),
      markNotificationSent: jest.fn().mockResolvedValue(undefined),
      discardNotification: jest.fn().mockResolvedValue(undefined),
      isAdDismissedForChat: jest.fn().mockResolvedValue(true),
    };
    const bot = {
      sendNotification: jest.fn(),
      sendPriceDropNotification: jest.fn(),
    };
    const scheduler = new ParserScheduler(db as never, bot as never) as any;

    await scheduler.deliverNotification({
      id: 43,
      kind: 'price_drop',
      chat_id: 123,
      dedupe_key: 'price_drop:user:123:ad-43:100 BYN:80 BYN',
      payload: { drop: { externalId: 'ad-43', oldPrice: '100 BYN', newPrice: '80 BYN' }, userId: 7 },
      attempts: 0,
      available_at: new Date(),
      locked_until: new Date(),
      sent_at: null,
      last_error: null,
      created_at: new Date(),
    });

    expect(db.isAdDismissedForChat).toHaveBeenCalledWith('ad-43', 123);
    expect(db.markNotificationSent).toHaveBeenCalledWith(43);
    expect(bot.sendPriceDropNotification).not.toHaveBeenCalled();
  });

  test('prioritizes higher Deal Score when enqueueing new-ad notifications', async () => {
    const db = {
      enqueueNotifications: jest.fn().mockResolvedValue(2),
    };
    const scheduler = new ParserScheduler(db as never, bot as never) as any;

    const weak = {
      external_id: 'weak',
      title: 'Weak',
      ad_url: 'https://example.com/weak',
      price: '190 BYN',
      market_median: 200,
      market_percent: -5,
      market_confidence: 'high',
      market_quality: 100,
      market_sample_size: 20,
      sell_normal: 195,
    };
    const strong = {
      external_id: 'strong',
      title: 'Strong',
      ad_url: 'https://example.com/strong',
      price: '100 BYN',
      market_median: 200,
      market_percent: -50,
      market_confidence: 'high',
      market_quality: 100,
      market_sample_size: 20,
      sell_normal: 190,
      published_at: new Date(),
      is_company: false,
      condition: 'new',
    };

    await scheduler.notifyNewAds([
      { ad: weak, telegramId: 123, userId: 1 },
      { ad: strong, telegramId: 123, userId: 1 },
    ]);

    const jobs = db.enqueueNotifications.mock.calls[0][0];
    expect(jobs).toHaveLength(2);
    expect(jobs[1].priority).toBeGreaterThan(jobs[0].priority);
    expect(jobs[1].priority).toBeGreaterThan(100);
  });

  test('does not mark a listing as a deal when resale margin is negative', async () => {
    const { analyzeDeal } = await import('../services/DealScoreEngine');
    const result = analyzeDeal({
      external_id: 'loss',
      title: 'Loss',
      ad_url: 'https://example.com/loss',
      price: '100 BYN',
      market_median: 200,
      market_percent: -50,
      market_confidence: 'high',
      market_quality: 100,
      market_sample_size: 20,
      sell_normal: 90,
    } as any);

    expect(result.score).toBeNull();
    expect(result.profit).toBe(-10);
    expect(result.reasons).toContain('Нет положительной маржи для перепродажи');
  });


  test('Deal Score rejects weak market evidence and non-positive margin', async () => {
    const { analyzeDeal } = await import('../services/DealScoreEngine');
    const base:any = {
      external_id: 'deal-safety',
      title: 'Deal safety',
      ad_url: 'https://example.com/deal-safety',
      price: '100 BYN',
      market_median: 200,
      market_percent: -50,
      market_confidence: 'high',
      market_quality: 100,
      market_sample_size: 20,
      sell_normal: 190,
    };
    expect(analyzeDeal({...base, market_confidence:'low'}).score).toBeNull();
    expect(analyzeDeal({...base, market_quality:44}).score).toBeNull();
    const loss = analyzeDeal({...base, sell_normal:99});
    expect(loss.score).toBeNull();
    expect(loss.profit).toBe(-1);
    expect(loss.roi).toBe(-1);
  });

});
