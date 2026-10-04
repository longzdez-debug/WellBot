import { MARKETPLACE_CATALOGS, MARKETPLACES, findMarketplaceNode, findMarketplaceCategory, buildMarketplaceSearchUrl } from '../catalog/MarketplaceCatalog';

describe('Marketplace catalog',()=>{
  test('exposes all supported marketplaces',()=>{
    expect(MARKETPLACES.map(x=>x.id)).toEqual(['kufar','onliner','av']);
    expect(MARKETPLACE_CATALOGS.onliner.length).toBeGreaterThan(0);
    expect(MARKETPLACE_CATALOGS.av.length).toBeGreaterThan(0);
  });
  test('resolves categories and children per marketplace',()=>{
    const onliner=MARKETPLACE_CATALOGS.onliner.find(x=>x.id==='computers')!;
    const child=onliner.children?.[0];
    expect(child).toBeDefined();
    expect(findMarketplaceNode('onliner',child!.id)?.title).toBe(child!.title);
    expect(findMarketplaceCategory('onliner',child!.id)?.id).toBe(onliner.id);
  });
  test('builds marketplace URLs without cross-marketplace leakage',()=>{
    const onliner=buildMarketplaceSearchUrl('onliner',{categoryId:'computers',subcategoryId:'computers_0',query:'iPhone',city:'minsk'});
    const av=buildMarketplaceSearchUrl('av',{categoryId:'cars',subcategoryId:'used',query:'BMW',minPrice:1000,maxPrice:5000});
    expect(onliner).toContain('baraholka.onliner.by');
    expect(av).toContain('av.by');
    expect(onliner).not.toContain('kufar.by');
    expect(av).not.toContain('kufar.by');
  });
});