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
    {id:'real_estate_apartments',title:'Квартиры',slug:'kvartiru'},{id:'real_estate_houses',title:'Дома и коттеджи',slug:'dom'},{id:'real_estate_rooms',title:'Комнаты',slug:'komnatu'},
    {id:'real_estate_land',title:'Земельные участки',slug:'uchastok'},{id:'real_estate_commercial',title:'Коммерческая недвижимость',slug:'kommercheskaya'},{id:'real_estate_garages',title:'Гаражи',slug:'garazh'}
  ]),
  category('travel','Путешествия','puteshestviya'),
  category('auto','Авто и запчасти','avto-i-zapchasti',[
    {id:'auto_cars',title:'Легковые автомобили',slug:'avtomobili'},{id:'auto_parts',title:'Запчасти',slug:'avtozapchasti'},{id:'auto_tires',title:'Шины и диски',slug:'shiny-i-diski'},{id:'auto_accessories',title:'Автоаксессуары',slug:'autoaccessories'}
  ]),
  category('services','Услуги','uslugi'),
  category('home_appliances','Бытовая техника','bytovaya-tehnika'),
  category('computers','Компьютерная техника','kompyuternaya-tehnika',[
    {id:'computers_laptops',title:'Ноутбуки',slug:'noutbuki'},{id:'computers_desktops',title:'Компьютеры',slug:'kompyutery'},{id:'computers_monitors',title:'Мониторы',slug:'monitory'},{id:'computers_components',title:'Комплектующие',slug:'komplektuyushchie'}
  ]),
  category('phones','Телефоны и планшеты','telefony-i-planshety',[
    {id:'phones_mobile',title:'Мобильные телефоны и смартфоны',slug:'mobilnye-telefony'},{id:'phones_tablets',title:'Планшеты',slug:'planshety'},{id:'phones_accessories',title:'Аксессуары',slug:'aksessuary'}
  ]),
  category('electronics','Электроника','elektronika',[
    {id:'electronics_audio',title:'Аудиотехника',slug:'audiotehnika'},{id:'electronics_headphones',title:'Наушники',slug:'naushniki'},{id:'electronics_tv',title:'ТВ и видеотехника',slug:'tv-i-videotekhnika'},
    {id:'electronics_photo',title:'Фототехника и оптика',slug:'fototekhnika-i-optika'},{id:'electronics_games',title:'Игры и приставки',slug:'igrovye-pristavki-i-igry'},{id:'electronics_smart_home',title:'Безопасность и умный дом',slug:'bezopasnost-i-umnyj-dom'}
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
