export interface CatalogNode {
  id: string;
  title: string;
  slug?: string;
  children?: CatalogNode[];
}

export interface MonitorConfig {
  source: 'kufar';
  categoryId: string;
  subcategoryId?: string;
  region?: string;
  city?: string;
  query?: string;
  minPrice?: number;
  maxPrice?: number;
  condition?: 'new' | 'used';
  seller?: 'private' | 'company';
}

const category = (id:string,title:string,slug:string,children:CatalogNode[]=[]):CatalogNode => ({id,title,slug,children});

export const KUFAR_CATALOG: CatalogNode[] = [
  category('real_estate','Недвижимость','nedvizhimost',[
    {id:'apartments',title:'Квартиры'},{id:'houses',title:'Дома и коттеджи'},{id:'rooms',title:'Комнаты'},
    {id:'land',title:'Земельные участки'},{id:'commercial',title:'Коммерческая недвижимость'},{id:'garages',title:'Гаражи'}
  ]),
  category('travel','Путешествия','puteshestviya'),
  category('auto','Авто и запчасти','avto-i-zapchasti',[
    {id:'cars',title:'Легковые автомобили'},{id:'parts',title:'Запчасти'},{id:'tires',title:'Шины и диски'},{id:'accessories',title:'Автоаксессуары'}
  ]),
  category('services','Услуги','uslugi'),
  category('home_appliances','Бытовая техника','bytovaya-tehnika'),
  category('computers','Компьютерная техника','kompyuternaya-tehnika',[
    {id:'laptops',title:'Ноутбуки'},{id:'desktops',title:'Компьютеры'},{id:'monitors',title:'Мониторы'},{id:'components',title:'Комплектующие'}
  ]),
  category('phones','Телефоны и планшеты','telefony-i-planshety',[
    {id:'phones',title:'Мобильные телефоны и смартфоны'},{id:'tablets',title:'Планшеты'},{id:'accessories',title:'Аксессуары'}
  ]),
  category('electronics','Электроника','elektronika',[
    {id:'audio',title:'Аудиотехника'},{id:'headphones',title:'Наушники'},{id:'tv',title:'ТВ и видеотехника'},
    {id:'photo',title:'Фототехника и оптика'},{id:'games',title:'Игры и приставки'},{id:'smart_home',title:'Безопасность и умный дом'}
  ]),
  category('women_clothes','Женский гардероб','zhenskij-garderob'),
  category('men_clothes','Мужской гардероб','muzhskoj-garderob'),
  category('beauty','Красота и здоровье','krasota-i-zdorove'),
  category('kids','Всё для детей и мам','vsyo-dlya-detej-i-mam'),
  category('furniture','Мебель','mebel'),
  category('home','Все для дома','vse-dlya-doma'),
  category('repair','Ремонт и стройка','remont-i-strojka'),
  category('garden','Сад и огород','sad-i-ogorod'),
  category('hobby','Хобби, спорт и туризм','hobby-sport-i-turizm'),
  category('wedding','Свадьба и праздники','svadba-i-prazdniki'),
  category('animals','Животные','zhivotnye'),
  category('business','Готовый бизнес и оборудование','gotovyj-biznes-i-oborudovanie'),
  category('jobs','Работа','rabota'),
  category('other','Прочее','prochee'),
];

const REGION_SLUGS: Record<string,string> = {
  minsk:'minsk', brest:'brest', vitebsk:'vitebsk', gomel:'gomel', grodno:'grodno', mogilev:'mogilev',
  minskaya_oblast:'minskaya-oblast', brestskaya_oblast:'brestskaya-oblast', vitebskaya_oblast:'vitebskaya-oblast',
  gomelskaya_oblast:'gomelskaya-oblast', grodnenskaya_oblast:'grodnenskaya-oblast', mogilevskaya_oblast:'mogilevskaya-oblast'
};

export function findCatalogNode(id:string):CatalogNode|null {
  for (const node of KUFAR_CATALOG) {
    if (node.id===id) return node;
    const child=node.children?.find(x=>x.id===id);
    if (child) return child;
  }
  return null;
}

export function buildKufarSearchUrl(config:MonitorConfig):string {
  const node=findCatalogNode(config.subcategoryId || config.categoryId);
  const categorySlug=node?.slug || findCatalogNode(config.categoryId)?.slug || '';
  const city=config.city ? encodeURIComponent(config.city) : '';
  const region=config.region ? REGION_SLUGS[config.region] || config.region : '';
  const prefix=city ? `/l/r~${city}/` : region ? `/l/r~${region}/` : '/l/';
  const path=`${prefix}${categorySlug}`;
  const url=new URL(path,'https://www.kufar.by');
  if (config.query) url.searchParams.set('query',config.query);
  if (config.minPrice!=null) url.searchParams.set('prc',String(config.minPrice));
  if (config.maxPrice!=null) url.searchParams.set('prc',String(config.maxPrice));
  if (config.condition==='new') url.searchParams.set('cur', 'new');
  if (config.condition==='used') url.searchParams.set('cur', 'used');
  return url.toString();
}
