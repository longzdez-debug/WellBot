import { analyzeDeal } from '../services/DealScoreEngine';
import { Ad } from '../types';

const makeAd = (overrides: Partial<Ad> = {}): Ad => ({
  external_id: 'test-1',
  title: 'Test listing',
  ad_url: 'https://example.com/test-1',
  price: '100 BYN',
  market_median: 150,
  market_percent: -33.3,
  market_sample_size: 20,
  market_confidence: 'high',
  market_quality: 90,
  sell_normal: 145,
  published_at: new Date(),
  ...overrides,
});

describe('DealScoreEngine', () => {
  test('rejects weak market evidence', () => {
    expect(analyzeDeal(makeAd({ market_confidence: 'low' })).score).toBeNull();
    expect(analyzeDeal(makeAd({ market_quality: 20 })).score).toBeNull();
    expect(analyzeDeal(makeAd({ market_sample_size: 3 })).score).toBeNull();
  });

  test('rejects non-positive resale margin', () => {
    const result = analyzeDeal(makeAd({ price: '100 BYN', sell_normal: 100 }));
    expect(result.score).toBeNull();
    expect(result.profit).toBe(0);
    expect(result.reasons).toContain('Нет положительной маржи для перепродажи');
  });

  test('scores a fresh profitable below-market listing', () => {
    const result = analyzeDeal(makeAd({ price: '100 BYN', market_median: 150, market_percent: -33.3, sell_normal: 145 }));
    expect(result.score).not.toBeNull();
    expect(result.score!).toBeGreaterThanOrEqual(65);
    expect(result.profit).toBe(45);
    expect(result.roi).toBe(45);
  });

  test('falls back to market minus three percent when sell_normal is absent', () => {
    const result = analyzeDeal(makeAd({ sell_normal: null, market_median: 200, price: '100 BYN' }));
    expect(result.sellPrice).toBe(194);
    expect(result.profit).toBe(94);
    expect(result.score).not.toBeNull();
  });

  test('does not score above-market listings as attractive deals', () => {
    const result = analyzeDeal(makeAd({
      price: '160 BYN',
      market_median: 150,
      market_percent: 6.7,
      sell_normal: 145,
    }));
    expect(result.score).toBeNull();
    expect(result.profit).toBe(-15);
  });
});
