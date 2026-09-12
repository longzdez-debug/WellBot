import { TelegramSender } from '../services/TelegramSender';
import { FormattedAd } from '../services/AdPresenter';

class FakeBot {
  sendMessage = jest.fn(async () => ({}));
  sendPhoto = jest.fn(async () => ({}));
  sendMediaGroup = jest.fn(async () => []);
  sendVenue = jest.fn(async () => ({}));
}

function makeAd(media: string[] = []): FormattedAd {
  return { text: 'test ad', media };
}

describe('TelegramSender', () => {
  test('sends media group with HTML caption for a single image', async () => {
    const bot = new FakeBot();
    const sender = new TelegramSender(bot as any);

    await sender.send(123, makeAd(['http://img/1']));

    expect(bot.sendMediaGroup).toHaveBeenCalledWith(123, [
      { type: 'photo', media: 'http://img/1', caption: 'test ad', parse_mode: 'HTML' },
    ]);
    expect(bot.sendPhoto).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  test('sends media group when there are several photos', async () => {
    const bot = new FakeBot();
    const sender = new TelegramSender(bot as any);

    await sender.send(123, makeAd(['http://img/1', 'http://img/2']));

    expect(bot.sendMediaGroup).toHaveBeenCalledWith(123, [
      { type: 'photo', media: 'http://img/1', caption: 'test ad', parse_mode: 'HTML' },
      { type: 'photo', media: 'http://img/2', caption: undefined, parse_mode: undefined },
    ]);
    expect(bot.sendPhoto).not.toHaveBeenCalled();
  });

  test('sends just text when no media', async () => {
    const bot = new FakeBot();
    const sender = new TelegramSender(bot as any);

    await sender.send(123, makeAd([]));

    expect(bot.sendMessage).toHaveBeenCalledWith(123, 'test ad', { parse_mode: 'HTML' });
    expect(bot.sendPhoto).not.toHaveBeenCalled();
    expect(bot.sendMediaGroup).not.toHaveBeenCalled();
  });

  test('falls back to a text notification when sendMediaGroup fails with 400', async () => {
    const bot = new FakeBot();
    bot.sendMediaGroup.mockRejectedValueOnce({
      response: { statusCode: 400, body: { description: 'bad request' } },
    });
    const sender = new TelegramSender(bot as any);

    await sender.send(123, makeAd(['http://img/1', 'http://img/2']));

    expect(bot.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledWith(123, 'test ad', { parse_mode: 'HTML' });
    expect(bot.sendPhoto).not.toHaveBeenCalled();
  });

  test('sendBatch sends all messages sequentially', async () => {
    const bot = new FakeBot();
    const sender = new TelegramSender(bot as any);

    await sender.sendBatch(123, [makeAd(['http://img/1']), makeAd(['http://img/2'])]);

    expect(bot.sendMediaGroup).toHaveBeenCalledTimes(2);
    expect(bot.sendPhoto).not.toHaveBeenCalled();
  });
});
