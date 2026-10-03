import { BotHandler } from '../bot/BotHandler';

describe('BotHandler notification delivery', () => {
  function makeHandler(sender: { send: jest.Mock }): BotHandler {
    const handler = Object.create(BotHandler.prototype) as BotHandler & {
      adPresenter: { format: jest.Mock };
      telegramSender: { send: jest.Mock };
      db: { getAdByIdForUser: jest.Mock; getAdByExternalId: jest.Mock };
    };
    handler.adPresenter = { format: jest.fn().mockResolvedValue({ text: 'Ad', options: {} }) };
    handler.telegramSender = sender;
    handler.db = {
      getAdByIdForUser: jest.fn().mockResolvedValue({ id: 7, title: 'Ad', ad_url: 'https://example.com/7' }),
      getAdByExternalId: jest.fn().mockResolvedValue({ id: 7, title: 'Ad', ad_url: 'https://example.com/7' }),
    };
    return handler;
  }

  test('rethrows transient new-ad delivery failures for outbox retry', async () => {
    const error = new Error('telegram unavailable');
    const sender = { send: jest.fn().mockRejectedValue(error) };
    const handler = makeHandler(sender);

    await expect(handler.sendNotification(123, {
      id: 7,
      external_id: 'ad-7',
      title: 'Ad',
      ad_url: 'https://example.com/7',
    })).rejects.toBe(error);
  });

  test('treats blocked users as terminal delivery and does not retry', async () => {
    const error = Object.assign(new Error('Forbidden'), { response: { statusCode: 403 } });
    const sender = { send: jest.fn().mockRejectedValue(error) };
    const handler = makeHandler(sender);

    await expect(handler.sendNotification(123, {
      id: 7,
      external_id: 'ad-7',
      title: 'Ad',
      ad_url: 'https://example.com/7',
    })).resolves.toBeUndefined();
  });

  test('rethrows transient price-drop delivery failures', async () => {
    const error = new Error('telegram unavailable');
    const sender = { send: jest.fn().mockRejectedValue(error) };
    const handler = makeHandler(sender);

    await expect(handler.sendPriceDropNotification(123, {
      adId: 7,
      externalId: 'ad-7',
      oldPrice: '100 BYN',
      newPrice: '90 BYN',
      changePercent: 10,
    }, 55)).rejects.toBe(error);
  });
});
