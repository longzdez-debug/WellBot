import { getMarketSignal, median, parseMarketPrice } from './MarketEngine';

describe('MarketEngine', () => {
  test('parses supported currencies and decimal separators', () => {
    expect(parseMarketPrice('1 299,90 BYN')).toEqual({ amount: 1299.9, currency: 'BYN' });
    expect(parseMarketPrice('799 USD')).toEqual({ amount: 799, currency: 'USD' });
    expect(parseMarketPrice('free')).toBeNull();
  });

  test('calculates median', () => {
    expect(median([100, 300, 200])).toBe(200);
    expect(median([100, 200, 300, 400])).toBe(250);
  });

  test('uses same-currency samples only', () => {
    const history = ['900 BYN', '1000 BYN', '1100 BYN', '1000 USD', '1050 BYN', '950 BYN', '1020 BYN', '980 BYN'];
    const signal = getMarketSignal('800 BYN', history);
    expect(signal.market_status).toBe('below_market');
    expect(signal.market_median).toBe(1000);
    expect(signal.market_sample_size).toBe(7);
  });

  test('requires enough samples before showing a market badge', () => {
    const signal = getMarketSignal('700 BYN', ['800 BYN', '820 BYN', '810 BYN']);
    expect(signal.market_status).toBeNull();
    expect(signal.market_confidence).toBeNull();
  });

  test('trims extreme outliers on large samples', () => {
    const history = Array.from({ length: 40 }, () => '1000 BYN');
    history.push('10 BYN', '99999 BYN');
    const signal = getMarketSignal('800 BYN', history);
    expect(signal.market_median).toBe(1000);
    expect(signal.market_status).toBe('below_market');
    expect(signal.market_confidence).toBe('high');
  });

  test('classifies at market inside the ±15% band', () => {
    const history = Array.from({ length: 20 }, () => '1000 BYN');
    expect(getMarketSignal('850 BYN', history).market_status).toBe('market');
    expect(getMarketSignal('1150 BYN', history).market_status).toBe('market');
  });
});
