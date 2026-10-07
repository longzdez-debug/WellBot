import { buildMarketplaceSearchUrl } from '../catalog/MarketplaceCatalog';

describe('buildMarketplaceSearchUrl', () => {
  test('keeps distinct Onliner monitor filters as distinct identities', () => {
    const base = {
      source: 'onliner' as const,
      categoryId: 'phones',
      subcategoryId: 'phones_0',
      city: 'minsk',
      minPrice: 100,
      maxPrice: 900,
    };
    const first = new URL(buildMarketplaceSearchUrl('onliner', { ...base, condition: 'used', mode: 'normal' }));
    const second = new URL(buildMarketplaceSearchUrl('onliner', { ...base, condition: 'new', mode: 'sniper' }));

    expect(first.origin).toBe(second.origin);
    expect(first.pathname).toBe(second.pathname);
    expect(first.searchParams.get('wb')).not.toBe(second.searchParams.get('wb'));
    expect(first.searchParams.get('wb')).toContain('"condition":"used"');
    expect(second.searchParams.get('wb')).toContain('"condition":"new"');
    expect(second.searchParams.get('wb')).toContain('"mode":"sniper"');
  });

  test('keeps distinct AV skip and market-discount filters as distinct identities', () => {
    const base = {
      source: 'av' as const,
      categoryId: 'auto',
      subcategoryId: 'auto_0',
      city: 'minsk',
      minPrice: 5000,
      maxPrice: 50000,
    };
    const first = new URL(buildMarketplaceSearchUrl('av', { ...base, skipSlots: 0, minMarketDiscount: 10 }));
    const second = new URL(buildMarketplaceSearchUrl('av', { ...base, skipSlots: 10, minMarketDiscount: 20 }));

    expect(first.searchParams.get('wb')).not.toBe(second.searchParams.get('wb'));
    expect(first.searchParams.get('wb')).toContain('"skipSlots":0');
    expect(second.searchParams.get('wb')).toContain('"skipSlots":10');
    expect(second.searchParams.get('wb')).toContain('"minMarketDiscount":20');
  });
});
