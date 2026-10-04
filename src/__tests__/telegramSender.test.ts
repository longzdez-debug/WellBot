import { TelegramSender } from '../services/TelegramSender';
import { FormattedAd } from '../services/AdPresenter';

class FakeBot {
  sendMessage = jest.fn(async () => ({}));
  sendPhoto = jest.fn(async () => ({}));
  sendMediaGroup = jest.fn(async () => []);
  sendVenue = jest.fn(async () => ({}));
}

const adUrl = ['https:', '', 'example.test', 'ad', '1'].join('/');
const imageOne = ['https:', '', 'img.test', '1'].join('/');
const imageTwo = ['https:', '', 'img.test', '2'].join('/');

function makeAd(media: string[] = [], url = adUrl): FormattedAd {
  return { text: '<b>test ad</b>\n<b>💰 100 BYN</b>', media, url };
}

describe('TelegramSender', () => {
  test('sends a single photo with an open-ad button', async () => {
    const bot = new FakeBot();
    const sender = new TelegramSender(bot as any);
    await sender.send(123, makeAd([imageOne]));
    expect(bot.sendPhoto).toHaveBeenCalledWith(123, imageOne, {
      caption: '<b>test ad</b>\n<b>💰 100 BYN</b>',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔥 ОТКРЫТЬ ОБЪЯВЛЕНИЕ', url: adUrl }]] },
    });
    expect(bot.sendMediaGroup).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
  });

  test('sends a media group and a link button for several photos', async () => {
    const bot = new FakeBot();
    const sender = new TelegramSender(bot as any);
    await sender.send(123, makeAd([imageOne, imageTwo]));
    expect(bot.sendMediaGroup).toHaveBeenCalledWith(123, [
      { type: 'photo', media: imageOne, caption: '<b>test ad</b>\n<b>💰 100 BYN</b>', parse_mode: 'HTML' },
      { type: 'photo', media: imageTwo, caption: undefined, parse_mode: undefined },
    ]);
    expect(bot.sendMessage).toHaveBeenCalledWith(123, '🔥 ОТКРЫТЬ ОБЪЯВЛЕНИЕ', {
      reply_markup: { inline_keyboard: [[{ text: '🔥 ОТКРЫТЬ ОБЪЯВЛЕНИЕ', url: adUrl }]] },
    });
  });

  test('sends text with an open-ad button when there is no media', async () => {
    const bot = new FakeBot();
    const sender = new TelegramSender(bot as any);
    await sender.send(123, makeAd([]));
    expect(bot.sendMessage).toHaveBeenCalledWith(123, '<b>test ad</b>\n<b>💰 100 BYN</b>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔥 ОТКРЫТЬ ОБЪЯВЛЕНИЕ', url: adUrl }]] },
    });
    expect(bot.sendPhoto).not.toHaveBeenCalled();
    expect(bot.sendMediaGroup).not.toHaveBeenCalled();
  });

  test('does not create a button for malformed URLs', async () => {
    const bot = new FakeBot();
    const sender = new TelegramSender(bot as any);
    await sender.send(123, makeAd([], 'not-a-url'));
    expect(bot.sendMessage).toHaveBeenCalledWith(123, '<b>test ad</b>\n<b>💰 100 BYN</b>', { parse_mode: 'HTML', reply_markup: undefined });
  });

  test('falls back to text when a media group is rejected', async () => {
    const bot = new FakeBot();
    bot.sendMediaGroup.mockRejectedValueOnce({ response: { statusCode: 400, body: { description: 'bad request' } } });
    const sender = new TelegramSender(bot as any);
    await sender.send(123, makeAd([imageOne, imageTwo]));
    expect(bot.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(bot.sendMessage).toHaveBeenCalledWith(123, '<b>test ad</b>\n<b>💰 100 BYN</b>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔥 ОТКРЫТЬ ОБЪЯВЛЕНИЕ', url: adUrl }]] },
    });
  });


});
