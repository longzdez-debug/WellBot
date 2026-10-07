import { KUFAR_CATALOG, findCatalogCategory, findCatalogNode, buildKufarSearchUrl } from './KufarCatalog';
import { KUFAR_PHONE_BRANDS, KUFAR_PHONE_FILTERS, isKufarPhoneCategory } from './KufarPhoneCatalog';

describe('KufarCatalog', () => {
  test('contains current top-level Kufar sections used by WellBOT', () => {
    const titles = KUFAR_CATALOG.map(node => node.title);
    expect(titles).toEqual(expect.arrayContaining([
      'Недвижимость','Путешествия — жильё на сутки','Авто и запчасти','Услуги',
      'Ремонт и стройка','Хобби, спорт и туризм','Всё для детей и мам','Мебель',
      'Женский гардероб','Животные','Все для дома','Телефоны и планшеты',
      'Сад и огород','Электроника','Компьютерная техника','Бытовая техника',
      'Мужской гардероб','Готовый бизнес и оборудование','Красота и здоровье',
      'Работа','Прочее','Свадьба и праздники',
    ]));
  });

  test('has no duplicate catalog ids at any depth', () => {
    const ids: string[] = [];
    const walk = (nodes: typeof KUFAR_CATALOG) => {
      for (const item of nodes) {
        ids.push(item.id);
        walk(item.children || []);
      }
    };
    walk(KUFAR_CATALOG);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every searchable leaf uses a numeric Kufar category id', () => {
    const walk = (nodes: typeof KUFAR_CATALOG) => {
      for (const item of nodes) {
        if (!item.children?.length && item.searchable !== false) expect(item.id).toMatch(/^\d+$/);
        walk(item.children || []);
      }
    };
    walk(KUFAR_CATALOG);
  });

  test('child lookup resolves to its owning category', () => {
    expect(findCatalogNode('17010')?.title).toBe('Мобильные телефоны');
    expect(findCatalogCategory('17010')?.title).toBe('Телефоны и планшеты');
    expect(findCatalogNode('2010')?.title).toBe('Легковые автомобили');
  });
  test('supports live phone facets for every current Kufar phone brand', () => {
    expect(KUFAR_PHONE_BRANDS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(KUFAR_PHONE_BRANDS.map(x=>x.id)).size).toBe(KUFAR_PHONE_BRANDS.length);
    expect(KUFAR_PHONE_FILTERS.map(x=>x.id)).toEqual(expect.arrayContaining(['os','screen','memory','ram','sim','dualSim','nfc','fingerprint','memoryCard','wirelessCharging']));
    expect(isKufarPhoneCategory('phones','17010')).toBe(true);
    expect(isKufarPhoneCategory('electronics','17010')).toBe(false);
  });

  test('preserves location for Kufar rental searches', () => {
    const url=buildKufarSearchUrl({source:'kufar',categoryId:'realty',subcategoryId:'1011',city:'minsk'});
    expect(url).toContain('https://re.kufar.by/l/minsk/snyat/kvartiru');
  });

  test('builds exact Kufar manufacturer/model paths', () => {
    const url=buildKufarSearchUrl({source:'kufar',categoryId:'phones',subcategoryId:'17010',brand:'apple',model:'iPhone 17',query:'256GB'});
    expect(url).toContain('/l/mobilnye-telefony/mt~apple-iphone-17');
    expect(url).toContain('query=256GB');
  });
});
