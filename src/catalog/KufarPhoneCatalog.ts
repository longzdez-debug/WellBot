export interface KufarPhoneBrand { id:string; title:string; }
export interface KufarPhoneModel { id:string; title:string; slug:string; }

export const KUFAR_PHONE_BRANDS:KufarPhoneBrand[]=[
{id:'acer',title:'Acer'},{id:'alcatel',title:'Alcatel'},{id:'apple',title:'Apple'},{id:'asus',title:'ASUS'},
{id:'blackberry',title:'BlackBerry'},{id:'blackview',title:'Blackview'},{id:'explay',title:'Explay'},{id:'fly',title:'Fly'},
{id:'google',title:'Google'},{id:'htc',title:'HTC'},{id:'honor',title:'Honor'},{id:'huawei',title:'Huawei'},
{id:'lenovo',title:'Lenovo'},{id:'lg',title:'LG'},{id:'meizu',title:'MEIZU'},{id:'motorola',title:'Motorola'},
{id:'microsoft',title:'Microsoft'},{id:'mtc',title:'MTC'},{id:'nokia',title:'Nokia'},{id:'oneplus',title:'OnePlus'},
{id:'oppo',title:'OPPO'},{id:'philips',title:'Philips'},{id:'poco',title:'POCO'},{id:'prestigio',title:'Prestigio'},
{id:'realme',title:'Realme'},{id:'samsung',title:'Samsung'},{id:'siemens',title:'Siemens'},{id:'sony',title:'Sony'},
{id:'texet',title:'TeXet'},{id:'vertu',title:'Vertu'},{id:'vivo',title:'Vivo'},{id:'xiaomi',title:'Xiaomi'},
{id:'zte',title:'ZTE'},{id:'bq',title:'BQ'}
];

export const KUFAR_PHONE_FILTERS=[
{id:'os',title:'Операционная система',values:['Android','IOS','Windows','Другая']},
{id:'screen',title:'Диагональ экрана',values:['до 2"','2.1" - 2.9"','3" - 4"','4.1" - 4.9"','5" - 5.4"','5.5" - 5.9"','6" и более']},
{id:'memory',title:'Память',values:['до 8 ГБ','16 ГБ','32 ГБ','64 ГБ','128 ГБ','256 ГБ','512 ГБ','1 ТБ']},
{id:'ram',title:'Оперативная память',values:['до 2 ГБ','3 ГБ','4 ГБ','5 ГБ','6 ГБ','8 ГБ','12 ГБ','16 ГБ','24 ГБ']},
{id:'sim',title:'Формат SIM-карты',values:['eSIM','Nano-SIM','Micro-SIM','SIM']},
{id:'dualSim',title:'Поддержка 2-х SIM',values:['Да']},
{id:'nfc',title:'Поддержка NFC',values:['Да']},
{id:'fingerprint',title:'Сканер отпечатка пальца',values:['Да']},
{id:'memoryCard',title:'Слот для карты памяти',values:['Да']},
{id:'wirelessCharging',title:'Беспроводная зарядка',values:['Да']}
] as const;

export function isKufarPhoneCategory(categoryId?:string,subcategoryId?:string):boolean{
return categoryId==='phones' && (!subcategoryId || subcategoryId==='17010');
}
export function normalizeKufarSlug(value:string):string{
return value.trim().toLocaleLowerCase('ru-RU').replace(/[^a-z0-9а-яё]+/gi,'-').replace(/^-+|-+$/g,'').replace(/[а-яё]/gi,ch=>({'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'j','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sh','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'}[ch]||ch));
}
