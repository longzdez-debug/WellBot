import { createHmac } from 'node:crypto';
import { parseTelegramInitData } from '../services/WebAppServer';

type TestUser = { id: number; username?: string };

function makeInitData(botToken: string, authDate: number, user: TestUser = { id: 123456789, username: 'tester' }): string {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAEAAAE',
    user: JSON.stringify(user),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

describe('parseTelegramInitData', () => {
  const botToken = 'test-bot-token';
  const now = 1_700_000_000;

  it('accepts a valid Telegram initData signature', () => {
    const raw = makeInitData(botToken, now - 60);
    expect(parseTelegramInitData(raw, botToken, now)).toEqual({
      user: { id: 123456789, username: 'tester' },
      authDate: now - 60,
    });
  });

  it('rejects a modified payload', () => {
    const raw = makeInitData(botToken, now - 60).replace('tester', 'attacker');
    expect(parseTelegramInitData(raw, botToken, now)).toBeNull();
  });

  it('rejects an invalid hash format', () => {
    const raw = makeInitData(botToken, now - 60).replace(/hash=[^&]+/, 'hash=not-a-hash');
    expect(parseTelegramInitData(raw, botToken, now)).toBeNull();
  });

  it('rejects data older than 24 hours', () => {
    const raw = makeInitData(botToken, now - 24 * 60 * 60 - 1);
    expect(parseTelegramInitData(raw, botToken, now)).toBeNull();
  });

  it('rejects data more than five minutes in the future', () => {
    const raw = makeInitData(botToken, now + 301);
    expect(parseTelegramInitData(raw, botToken, now)).toBeNull();
  });

  it('rejects a malformed user id', () => {
    const raw = makeInitData(botToken, now - 60, { id: 0 });
    expect(parseTelegramInitData(raw, botToken, now)).toBeNull();
  });
});
