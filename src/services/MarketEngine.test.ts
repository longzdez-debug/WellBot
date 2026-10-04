import { parseMarketPrice } from './MarketEngine';

describe('MarketEngine price parsing', () => {
  test('parses supported currencies and decimal separators', () => {
    expect(parseMarketPrice('1 299,90 BYN')).toEqual({ amount: 1299.9, currency: 'BYN' });
    expect(parseMarketPrice('799 USD')).toEqual({ amount: 799, currency: 'USD' });
    expect(parseMarketPrice('free')).toBeNull();
  });

  test('rejects invalid or non-positive prices', () => {
    expect(parseMarketPrice('0 BYN')).toBeNull();
    expect(parseMarketPrice('-10 BYN')).toBeNull();
    expect(parseMarketPrice('100 GBP')).toBeNull();
  });
});
