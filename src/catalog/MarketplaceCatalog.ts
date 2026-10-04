export type MarketplaceSource='kufar'|'onliner'|'av';
export interface MarketplaceNode{ id:string; title:string; slug:string; children?:MarketplaceNode[]; searchable?:boolean; }
const c=(id:string,title:string,slug=id,children:MarketplaceNode[]=[]):MarketplaceNode=>({id,title,slug,...(children.length?{children}: {})});
const leaf=(id:string,title:string,slug=id)=>({id,title,slug});
export const MARKETPLACE_CATALOGS:Record<MarketplaceSource,MarketplaceNode[]>={
  kufar: [],
  onliner:[
    c('electronics','Электроника','electronics',[leaf('phones','Смартфоны и телефоны'),leaf('computers','Компьютеры и ноутбуки'),leaf('components','Комплектующие'),leaf('tablets','Планшеты'),leaf('audio','Аудио'),leaf('photo','Фото и видео'),leaf('tv','Телевизоры'),leaf('gaming','Игры и консоли'),leaf('wearables','Умные часы и браслеты')]),
    c('home','Дом и быт','home',[leaf('appliances','Бытовая техника'),leaf('furniture','Мебель'),leaf('kitchen','Кухня'),leaf('tools','Инструменты'),leaf('garden','Сад и дача')]),
    c('auto','Авто','auto',[leaf('cars','Легковые автомобили'),leaf('moto','Мотоциклы'),leaf('parts','Запчасти'),leaf('wheels','Шины и диски'),leaf('accessories','Аксессуары')]),
    c('fashion','Одежда и обувь','fashion',[leaf('women','Женское'),leaf('men','Мужское'),leaf('kids','Детское'),leaf('shoes','Обувь'),leaf('accessories','Аксессуары')]),
    c('sports','Спорт и отдых','sports',[leaf('fitness','Фитнес'),leaf('cycling','Велосипеды'),leaf('outdoor','Туризм'),leaf('fishing','Рыбалка'),leaf('collecting','Коллекционирование')]),
    c('kids','Детское','kids',[leaf('toys','Игрушки'),leaf('strollers','Коляски'),leaf('furniture','Детская мебель'),leaf('clothes','Детская одежда'),leaf('transport','Детский транспорт')]),
    c('services','Услуги','services',[leaf('repair','Ремонт'),leaf('delivery','Перевозки и доставка'),leaf('education','Обучение'),leaf('beauty','Красота'),leaf('other','Другие услуги')]),
    c('realestate','Недвижимость','realestate',[leaf('apartments','Квартиры'),leaf('houses','Дома'),leaf('rent','Аренда'),leaf('commercial','Коммерческая')])
  ],
  av:[
    c('cars','Легковые автомобили','cars',[leaf('all','Все автомобили'),leaf('used','С пробегом'),leaf('new','Новые'),leaf('electric','Электромобили')]),
    c('trucks','Грузовые автомобили','trucks',[leaf('trucks','Грузовики'),leaf('trailers','Прицепы'),leaf('buses','Автобусы')]),
    c('moto','Мото','moto',[leaf('motorcycles','Мотоциклы'),leaf('scooters','Скутеры'),leaf('atv','Квадроциклы')]),
    c('parts','Запчасти','parts',[leaf('engine','Двигатель'),leaf('body','Кузов'),leaf('suspension','Подвеска'),leaf('electronics','Электрика'),leaf('tires','Шины и диски')]),
    c('commercial','Коммерческий транспорт','commercial',[leaf('special','Спецтехника'),leaf('construction','Строительная техника'),leaf('agro','Сельхозтехника')])
  ]
};
export const MARKETPLACES:{id:MarketplaceSource;title:string;short:string}[]=[
  {id:'kufar',title:'Kufar',short:'Объявления'},
  {id:'onliner',title:'Onliner',short:'Барахолка'},
  {id:'av',title:'AV.BY',short:'Авто'}
];
export function getMarketplaceCatalog(source:MarketplaceSource):MarketplaceNode[]{
  return source==='kufar' ? [] : MARKETPLACE_CATALOGS[source]||[];
}
export function findMarketplaceNode(source:MarketplaceSource,id:string):MarketplaceNode|null{
  for(const n of getMarketplaceCatalog(source)){if(n.id===id)return n;const x=n.children?.find(v=>v.id===id);if(x)return x;}
  return null;
}
export function findMarketplaceCategory(source:MarketplaceSource,id:string):MarketplaceNode|null{
  const list=getMarketplaceCatalog(source),direct=list.find(n=>n.id===id); if(direct)return direct;
  return list.find(n=>n.children?.some(x=>x.id===id))||null;
}
export function buildMarketplaceSearchUrl(source:MarketplaceSource,config:any):string{
  if(source==='kufar') throw new Error('kufar_url_builder');
  const q=String(config.query||'').trim();
  const category=findMarketplaceNode(source,config.subcategoryId||config.categoryId);
  const parts=[category?.title||'',q].filter(Boolean).join(' ').trim();
  if(source==='onliner'){
    const u=new URL('https://baraholka.onliner.by/search.php');
    if(parts)u.searchParams.set('query',parts);
    if(config.city)u.searchParams.set('city',String(config.city));
    return u.toString();
  }
  const u=new URL('https://av.by/');
  if(parts)u.searchParams.set('search',parts);
  if(config.city)u.searchParams.set('location',String(config.city));
  if(config.minPrice!=null)u.searchParams.set('price_min',String(config.minPrice));
  if(config.maxPrice!=null)u.searchParams.set('price_max',String(config.maxPrice));
  return u.toString();
}