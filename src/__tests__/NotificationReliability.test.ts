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
});
