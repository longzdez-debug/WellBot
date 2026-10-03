export interface CatalogNode { id:string; title:string; slug:string; children?:CatalogNode[]; }
export interface MonitorConfig {
  source:'kufar'; categoryId:string; subcategoryId?:string; region?:string; city?:string; query?:string;
  minPrice?:number; maxPrice?:number; condition?:'new'|'used'; seller?:'private'|'company';
}
const node=(id:string,title:string,slug:string,children:CatalogNode[]=[]):CatalogNode=>({id,title,slug,...(children.length?{children}:{})});
const child=(id:string,title:string,slug:string):CatalogNode=>({id,title,slug});

/* WellBOT-owned UX taxonomy. Labels follow Kufar's current top-level categories. */
export const KUFAR_CATALOG:CatalogNode[]=[
 node('real_estate','Недвижимость','nedvizhimost',[child('real_estate_apartments','Квартиры','kvartiru'),child('real_estate_houses','Дома и коттеджи','dom'),child('real_estate_rooms','Комнаты','komnatu'),child('real_estate_land','Земельные участки','uchastok'),child('real_estate_commercial','Коммерческая недвижимость','kommercheskaya'),child('real_estate_garages','Гаражи','garazh')]),
 node('travel','Путешествия','puteshestviya'),
 node('auto','Авто и запчасти','avto-i-zapchasti',[child('auto_cars','Легковые автомобили','avtomobili'),child('auto_motorcycles','Мотоциклы','mototsikly'),child('auto_buses','Автобусы и микроавтобусы','avtobusy-i-mikroavtobusy'),child('auto_tires','Шины и диски','shiny-i-diski'),child('auto_parts','Автозапчасти','avtozapchasti')]),
 node('services','Услуги','uslugi'),
 node('home_appliances','Бытовая техника','bytovaya-tehnika',[child('home_appliances_washing','Стиральные машины','stiralnye-mashiny')]),
 node('computers','Компьютерная техника','kompyuternaya-tehnika',[child('computers_laptops','Ноутбуки','noutbuki'),child('computers_desktops','Компьютеры / системные блоки','kompyutery'),child('computers_monitors','Мониторы','monitory'),child('computers_components','Комплектующие','komplektuyushchie'),child('computers_office','Оргтехника','orgtekhnika'),child('computers_peripherals','Периферия и аксессуары','kompjuternaja-periferiya-i-aksessuary'),child('computers_network','Сетевое оборудование','setevoe-oborudovanie'),child('computers_other','Прочие компьютерные товары','prochie-kompyuternye-tovary')]),
 node('phones','Телефоны и планшеты','telefony-i-planshety',[child('phones_mobile','Мобильные телефоны','mobilnye-telefony'),child('phones_components','Комплектующие для телефонов','komplektuyushchie-dlya-telefonov'),child('phones_accessories','Аксессуары для телефонов','aksessuary-dlya-telefonov'),child('phones_telephony','Телефония и связь','telefoniya-i-svyaz'),child('phones_tablets','Планшеты','planshety'),child('phones_tablet_components','Комплектующие для планшетов','komplektuyushchie-dlya-planshetov'),child('phones_graphics','Графические планшеты','graficheskie-planshety'),child('phones_ebooks','Электронные книги','elektronnye-knigi'),child('phones_watches','Умные часы и фитнес-браслеты','umnye-chasy-i-fitnes-braslety'),child('phones_audio','Наушники','naushniki')]),
 node('electronics','Электроника','elektronika',[child('electronics_tv','ТВ и видеотехника','televizory'),child('electronics_games','Игры и приставки','igrovye-pristavki-i-igry')]),
 node('women_clothes','Женский гардероб','zhenskij-garderob'),node('men_clothes','Мужской гардероб','muzhskoj-garderob'),
 node('beauty','Красота и здоровье','krasota-i-zdorove'),node('kids','Всё для детей и мам','vsyo-dlya-detej-i-mam'),node('furniture','Мебель','mebel'),
 node('home','Все для дома','vse-dlya-doma'),node('repair','Ремонт и стройка','remont-i-strojka'),node('garden','Сад и огород','sad-i-ogorod'),
 node('hobby','Хобби, спорт и туризм','hobby-sport-i-turizm'),node('wedding','Свадьба и праздники','svadba-i-prazdniki'),node('animals','Животные','zhivotnye'),
 node('business','Готовый бизнес и оборудование','gotovyj-biznes-i-oborudovanie'),node('jobs','Работа','rabota'),node('other','Прочее','prochee')
];
const REGION_SLUGS:Record<string,string>={minsk:'minsk',brest:'brest',vitebsk:'vitebsk',gomel:'gomel',grodno:'grodno',mogilev:'mogilev',minskaya_oblast:'minskaya-oblast',brestskaya_oblast:'brestskaya-oblast',vitebskaya_oblast:'vitebskaya-oblast',gomelskaya_oblast:'gomelskaya-oblast',grodnenskaya_oblast:'grodnenskaya-oblast',mogilevskaya_oblast:'mogilevskaya-oblast'};
export function findCatalogNode(id:string):CatalogNode|null{for(const category of KUFAR_CATALOG){if(category.id===id)return category;const found=category.children?.find(item=>item.id===id);if(found)return found;}return null;}
export function findCatalogCategory(id:string):CatalogNode|null{const direct=KUFAR_CATALOG.find(category=>category.id===id);if(direct)return direct;return KUFAR_CATALOG.find(category=>category.children?.some(item=>item.id===id))||null;}
export function getCatalogLabel(id:string):string{return findCatalogNode(id)?.title||'Каталог';}
export function buildKufarSearchUrl(config:MonitorConfig):string{
 const selected=findCatalogNode(config.subcategoryId||config.categoryId); const category=findCatalogCategory(config.categoryId); const slug=selected?.slug||category?.slug||'';
 const city=config.city?encodeURIComponent(config.city):''; const region=config.region?REGION_SLUGS[config.region]||config.region:'';
 const prefix=city?'/l/r~'+city+'/':region?'/l/r~'+region+'/':'/l/'; const url=new URL(prefix+slug,'https://www.kufar.by');
 if(config.query?.trim())url.searchParams.set('query',config.query.trim());
 const min=config.minPrice!=null&&Number.isFinite(Number(config.minPrice))?Number(config.minPrice):undefined;
 const max=config.maxPrice!=null&&Number.isFinite(Number(config.maxPrice))?Number(config.maxPrice):undefined;
 if(min!=null||max!=null)url.searchParams.set('prc','r:'+(min??0)+','+(max??''));
 return url.toString();
}
