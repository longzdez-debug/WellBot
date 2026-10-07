import { hasProAccess } from '../services/ProAccess';

describe('hasProAccess', () => {
  const now=Date.parse('2026-10-07T12:00:00.000Z');

  test('allows active access while the paid period is still valid', () => {
    expect(hasProAccess({status:'active',expiresAt:new Date(now+60_000)},now)).toBe(true);
  });

  test('keeps access during a user-cancelled paid period', () => {
    expect(hasProAccess({status:'canceled',expiresAt:new Date(now+60_000)},now)).toBe(true);
  });

  test('keeps access during a temporarily failed renewal until expiry', () => {
    expect(hasProAccess({status:'failed',expiresAt:new Date(now+60_000)},now)).toBe(true);
  });

  test('removes access at expiry', () => {
    expect(hasProAccess({status:'active',expiresAt:new Date(now)},now)).toBe(false);
  });

  test('treats refunded and revoked subscriptions as terminal', () => {
    expect(hasProAccess({status:'refunded',expiresAt:new Date(now+60_000)},now)).toBe(false);
    expect(hasProAccess({status:'revoked',expiresAt:new Date(now+60_000)},now)).toBe(false);
  });

  test('treats expired subscriptions as terminal even with a future timestamp', () => {
    expect(hasProAccess({status:'expired',expiresAt:new Date(now+60_000)},now)).toBe(false);
  });
});
