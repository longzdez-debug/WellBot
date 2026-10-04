import { KUFAR_CATALOG, findCatalogCategory, findCatalogNode } from './KufarCatalog';

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
});
