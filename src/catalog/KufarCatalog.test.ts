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

  test('has no duplicate catalog ids', () => {
    const ids: string[] = [];
    for (const category of KUFAR_CATALOG) {
      ids.push(category.id);
      for (const child of category.children || []) ids.push(child.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every searchable leaf uses a numeric Kufar category id', () => {
    for (const category of KUFAR_CATALOG) {
      if (!category.children?.length && category.searchable !== false) expect(category.id).toMatch(/^\d+$/);
      for (const child of category.children || []) expect(child.id).toMatch(/^\d+$/);
    }
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

  test('builds exact Kufar manufacturer/model paths', () => {
    const url=buildKufarSearchUrl({source:'kufar',categoryId:'phones',subcategoryId:'17010',brand:'apple',model:'iPhone 17',query:'256GB'});
    expect(url).toContain('/l/mobilnye-telefony/mt~apple-iphone-17');
    expect(url).toContain('query=256GB');
  });
});
