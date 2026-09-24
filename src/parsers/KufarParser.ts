import { BaseParser } from './BaseParser';
import { Ad } from '../types';
import { logger } from '../utils/logger';

// --- Справочники для работы с Kufar API ---

// --- Вспомогательные функции ---

/**
 * Карта для преобразования текстовых названий категорий из URL в числовые ID,
 * которые понимает API Kufar.
 */
const CATEGORY_MAP: Record<string, string> = {
  // Недвижимость
  'kvartiru': '1010',
  'komnatu': '1030',
  'dom': '1020',
  'dachu': '1020',
  'uchastok': '1050',
  'kommercheskaya': '1060',
  'garazh': '1040',
  
  // Транспорт
  'avtomobili': '2010',
  'mototsikly': '2020',
  'avtobusy-i-mikroavtobusy': '2030',
  'shiny-i-diski': '2100',
  
  // Техника
  'telefony-i-planshety': '17010',
  'mobilnye-telefony': '17010',
  'telefony': '17010',
  'noutbuki': '19020',
  'kompyutery': '19010',
  'televizory': '12030',
  'igrovye-pristavki-i-igry': '12040',
  'stiralnye-mashiny': '14050',

  // Прочее
  'mebel': '15040',
  'velosipedy': '8030',
};

/**
 * Карта подкатегорий для категории телефонов (mt).
 * Используется строковый бренд, который передаётся в API.
 */
const BRAND_SLUG_TO_API: Record<string, string> = {
  'apple': 'Apple',
  'samsung': 'Samsung',
  'xiaomi': 'Xiaomi',
  'huawei': 'Huawei',
  'honor': 'Honor',
  'nokia': 'Nokia',
  'realme': 'Realme',
  'oppo': 'OPPO',
  'vivo': 'Vivo',
  'oneplus': 'OnePlus',
  'google': 'Google',
  'tecno': 'Tecno',
  'infinix': 'Infinix',
};

/**
 * Карта для определения ID региона (rgn) по городу/области из URL.
 * Kufar API имеет перепутанную нумерацию регионов.
 * rgn=7: Минск, rgn=5: Минская обл, rgn=1: Брестская, rgn=6: Витебская,
 * rgn=2: Гомельская, rgn=3: Гродненская, rgn=4: Могилевская.
 */
const CITY_TO_REGION_ID: Record<string, string> = {
  'minsk': '7',
  'brest': '1',
  'vitebsk': '6',
  'gomel': '2',
  'grodno': '3',
  'mogilev': '4',
  'minskaya-oblast': '5',
  'brestskaya-oblast': '1',
  'vitebskaya-oblast': '6',
  'gomelskaya-oblast': '2',
  'grodnenskaya-oblast': '3',
  'mogilevskaya-oblast': '4',
  'baranovichi': '1', 'pinsk': '1', 'kobrin': '1', 'bereza': '1',
  'orsha': '6', 'polotsk': '6', 'novopolotsk': '6',
  'zhlobin': '2', 'mozyr': '2', 'rechitsa': '2', 'svetlogorsk': '2',
  'lida': '3', 'volkovysk': '3', 'slonim': '3',
  'borisov': '5', 'soligorsk': '5', 'molodechno': '5', 'zhodino': '5', 'slutsk': '5',
  'bobruisk': '4',
};

/**
 * Карта для вторичной фильтрации. Сопоставляет города из URL
 * с вариантами их названий на кириллице в данных объявлений.
 */
const CITY_VARIANTS: Record<string, string[]> = {
  'minsk': ['минск', 'первомайский', 'московский', 'ленинский', 'заводской', 'октябрьский', 'фрунзенский', 'партизанский', 'советский', 'центральный'],
  'brest': ['брест'], 'baranovichi': ['барановичи'], 'pinsk': ['пинск'], 'kobrin': ['кобрин'], 'bereza': ['береза'],
  'vitebsk': ['витебск'], 'orsha': ['орша'], 'polotsk': ['полоцк'], 'novopolotsk': ['новополоцк'],
  'gomel': ['гомель'], 'zhlobin': ['жлобин'], 'mozyr': ['мозырь'], 'rechitsa': ['речица'], 'svetlogorsk': ['светлогорск'],
  'grodno': ['гродно'], 'lida': ['лида'], 'volkovysk': ['волковыск'], 'slonim': ['слоним'],
  'mogilev': ['могилёв', 'могилев'], 'bobruisk': ['бобруйск'],
  'borisov': ['борисов'], 'soligorsk': ['солигорск'], 'molodechno': ['молодечно'], 'zhodino': ['жодино'], 'slutsk': ['слуцк'],
};

/** Read a single Kufar ad parameter without relying on a particular field name. */
function getAdParam(ad: any, ...names: string[]): any {
  const params = Array.isArray(ad?.ad_parameters) ? ad.ad_parameters : [];
  const found = params.find((p: any) => names.includes(p?.p));
  return found?.vl ?? found?.v;
}

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function getNextCursor(data: any): string | null {
  const pages = data?.pagination?.pages;
  if (!Array.isArray(pages)) return null;
  const next = pages.find((page: any) => page?.label === 'next' || page?.type === 'next');
  const token = next?.token;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}


export class KufarParser extends BaseParser {
  platform = 'kufar' as const;

  constructor(axiosInstance?: any) {
    super(axiosInstance);
  }

  async parseUrl(url: string): Promise<Ad[]> {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);

      // --- 1. Определение параметров для API из URL ---
      let cat = '';
      let rgn = '';
      let typ = '';
      let subcat = '';
      let citySlugForFilter = '';
      let pathQuery = '';

      // Kufar can encode the search text directly in the path as q~<query>.
      // Example: /l/r~mogilevskaya-obl/q~apple
      // Without this conversion the API searches the whole region and returns unrelated listings.
      for (const part of pathParts) {
        const queryMatch = part.match(/^q~(.+)$/);
        if (queryMatch) {
          try {
            pathQuery = decodeURIComponent(queryMatch[1].replace(/\+/g, ' '));
          } catch {
            pathQuery = queryMatch[1].replace(/\+/g, ' ');
          }
          break;
        }
      }

      // Определяем категорию
      for (const part of pathParts) {
        if (CATEGORY_MAP[part]) {
          cat = CATEGORY_MAP[part];
          break;
        }
      }

      // Определяем подкатегорию (например, mt~apple)
      for (const part of pathParts) {
        const subcatMatch = part.match(/^mt~(.+)$/);
        if (subcatMatch) {
          const brandSlug = subcatMatch[1];
          subcat = BRAND_SLUG_TO_API[brandSlug] || decodeURIComponent(brandSlug);
          break;
        }
      }

      // Определяем регион
      const gtsy = urlObj.searchParams.get('gtsy');
      if (gtsy) {
        if (gtsy.includes('province-minsk_gorod')) rgn = '7';
        else if (gtsy.includes('province-minskaja_oblast')) rgn = '5';
        else if (gtsy.includes('province-brestskaja_oblast')) rgn = '1';
        else if (gtsy.includes('province-vitebskaja_oblast')) rgn = '6';
        else if (gtsy.includes('province-gomelskaja_oblast')) rgn = '2';
        else if (gtsy.includes('province-grodnenskaja_oblast')) rgn = '3';
        else if (gtsy.includes('province-mogilevskaja_oblast')) rgn = '4';
        else {
          // Gtsy параметр есть, но не распознан — пробуем определить через path
          logger.info('Unrecognized gtsy parameter, falling back to path-based region detection', { gtsy });
        }
      }

      // Если регион не определён через gtsy — ищем в path
      if (!rgn) {
        for (const part of pathParts) {
          // Kufar использует формат r~cityname для региона
          const regionMatch = part.match(/^r~(.+)$/);
          if (regionMatch) {
            const citySlug = regionMatch[1];
            if (CITY_TO_REGION_ID[citySlug]) {
              rgn = CITY_TO_REGION_ID[citySlug];
              if (!citySlug.includes('-oblast')) {
                citySlugForFilter = citySlug;
              }
              break;
            }
          }
          // Также пробуем без префикса
          if (CITY_TO_REGION_ID[part]) {
            rgn = CITY_TO_REGION_ID[part];
            if (!part.includes('-oblast')) {
              citySlugForFilter = part;
            }
            break;
          }
        }
      }

      // Определяем тип сделки (для недвижимости)
      if (pathParts.includes('snyat')) typ = 'let';
      else if (pathParts.includes('kupit')) typ = 'sell';

      // --- 2. Сборка параметров и выполнение запросов к API (с cursor-пагинацией) ---
      const apiParams: Record<string, any> = { size: 100 };

      // Preserve every search filter from the original Kufar URL instead of
      // silently dropping filters such as ar/sort/cur.
      urlObj.searchParams.forEach((value, key) => {
        if (key !== 'page' && key !== 'cursor') apiParams[key] = value;
      });

      if (cat) apiParams.cat = cat;
      if (rgn) apiParams.rgn = rgn;
      if (typ) apiParams.typ = typ;
      if (pathQuery && !urlObj.searchParams.get('query')) apiParams.query = pathQuery;
      if (!apiParams.cat && urlObj.searchParams.get('cat')) apiParams.cat = urlObj.searchParams.get('cat');
      if (!apiParams.rgn && urlObj.searchParams.get('rgn')) apiParams.rgn = urlObj.searchParams.get('rgn');
      if (!apiParams.sort) apiParams.sort = 'lst.d';

      const headers = {
        'Host': 'api.kufar.by',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Referer': 'https://www.kufar.by/',
        'Origin': 'https://www.kufar.by',
      };

      const requestPage = async (cursor?: string): Promise<any> => {
        const params = { ...apiParams };
        if (cursor) params.cursor = cursor;

        for (let attempt = 1; attempt <= 4; attempt++) {
          try {
            const response = await this.axiosInstance.get(
              'https://api.kufar.by/search-api/v2/search/rendered-paginated',
              { params, headers, timeout: 30000 }
            );
            return response.data;
          } catch (error: any) {
            const status = error?.response?.status;
            const retryable = status === 429 || (status >= 500 && status <= 599) || !status;
            if (!retryable || attempt === 4) throw error;

            const retryAfter = Number(error?.response?.headers?.['retry-after']);
            const delay = Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 10000)
              : attempt * 500;

            logger.warn('Kufar API request retry', { attempt, status, delay });
            await this.sleep(delay);
          }
        }
        throw new Error('Kufar API request failed');
      };

      logger.info('Making Kufar API requests (cursor pagination)', {
        params: apiParams,
        originalUrl: url,
      });

      const allPaginatedAds: any[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;

      // Cursors must be followed sequentially; page=2/page=3 is not a reliable
      // replacement for Kufar's cursor pagination.
      for (let page = 1; page <= 51; page++) {
        const data = await requestPage(cursor || undefined);
        const ads = Array.isArray(data?.ads) ? data.ads : [];
        allPaginatedAds.push(...ads);

        const nextCursor = getNextCursor(data);
        logger.info('Kufar page fetched', {
          page,
          ads: ads.length,
          totalCollected: allPaginatedAds.length,
          hasNext: Boolean(nextCursor),
        });

        if (!nextCursor || seenCursors.has(nextCursor) || ads.length === 0) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        await this.sleep(100 + Math.random() * 150);
      }

      logger.info('Kufar pagination complete', { totalCollected: allPaginatedAds.length });

      // poleposition — это рекламные объявления поверх поиска, тоже добавляем
      // Но НЕ дублируем — рекламные объявления часто те же, что и в paginated
      let polepositionAds: any[] = [];
      try {
        await this.sleep(100 + Math.random() * 100);
        const poleResponse = await this.axiosInstance.get(
          'https://api.kufar.by/search-api/v2/search/poleposition',
          {
            params: { ...apiParams, size: 10 },
            headers,
          }
        );
        polepositionAds = poleResponse.data?.ads || [];
      } catch {
        // poleposition может не вернуть данные — не критично
      }

      // --- 3. Объединение, дедупликация и обработка результатов ---
      // poleposition может содержать дубликаты — объединяем через Map
      const allAdsRaw = [...allPaginatedAds, ...polepositionAds];
      
      const uniqueAdsMap = new Map();
      allAdsRaw.forEach(ad => {
        if (ad.ad_id) uniqueAdsMap.set(ad.ad_id, ad);
      });
      const uniqueAds = Array.from(uniqueAdsMap.values());

      // Сортируем объявления по времени последнего изменения (от новых к старым)
      // list_time_up — время обновления, list_time — время публикации
      uniqueAds.sort((a: any, b: any) => {
        const timeA = a.list_time_up ? new Date(a.list_time_up).getTime() : (a.list_time ? new Date(a.list_time).getTime() : 0);
        const timeB = b.list_time_up ? new Date(b.list_time_up).getTime() : (b.list_time ? new Date(b.list_time).getTime() : 0);
        return timeB - timeA;
      });

      if (uniqueAds.length === 0) {
        logger.warn('No ads found in Kufar API', { url, params: apiParams });
        return [];
      }

      // Debug: log first ad fields to see what's available for location filtering
      logger.info('Kufar raw ad sample (first ad)', {
        ad_id: uniqueAds[0].ad_id,
        subject: uniqueAds[0].subject,
        ad_parameters: uniqueAds[0].ad_parameters,
        account_parameters: uniqueAds[0].account_parameters,
        ad_location: uniqueAds[0].ad_location,
        available_keys: Object.keys(uniqueAds[0]),
      });
      
      // --- 4. Преобразование данных и ВТОРИЧНАЯ ФИЛЬТРАЦИЯ ---
      let processedAds = uniqueAds.map((ad: any) => {
        // Цена: price_byn/price_usd могут быть строками или числами
        let priceStr = 'Договорная';
        if (ad.price_byn != null) {
          const bynVal = typeof ad.price_byn === 'string' ? parseInt(ad.price_byn, 10) : ad.price_byn;
          priceStr = `${(bynVal / 100).toFixed(2)} BYN`;
        } else if (ad.price_usd != null) {
          const usdVal = typeof ad.price_usd === 'string' ? parseInt(ad.price_usd, 10) : ad.price_usd;
          priceStr = `${(usdVal / 100).toFixed(2)} USD`;
        }

        let imageUrl: string | undefined;
        if (ad.images?.length > 0) {
          const firstImage = ad.images[0];
          imageUrl = firstImage?.path ? `https://rms4.kufar.by/v1/gallery/${firstImage.path}` : firstImage?.url;
        }
        
        // Извлекаем локацию из нескольких источников для надёжности
        const locationParam = ad.ad_parameters?.find((p: any) => p?.p === 'area');
        const regionParam = ad.ad_parameters?.find((p: any) => p?.p === 'region');
        const location = locationParam?.vl;
        const region = regionParam?.vl;

        // Поле ad_location (если есть) — содержит город/район
        const adLocation = ad.ad_location;

        // Адрес продавца
        const addressParam = ad.account_parameters?.find((p: any) => p?.p === 'address');
        const address = addressParam?.v;

        // Формируем описание: пока пустое, заполним позже из HTML
        let description: string | undefined;

        // Извлекаем дату публикации и обновления (проверка на undefined)
        const publishedAt = ad.list_time ? new Date(ad.list_time) : undefined;
        const updatedAt = ad.list_time_up ? new Date(ad.list_time_up) : undefined;

        // Формируем URL объявления
        const adLink = ad.ad_link || `https://www.kufar.by/ad/${ad.ad_id}`;

        return {
          external_id: String(ad.ad_id),
          title: ad.subject || 'Без названия',
          description,
          price: priceStr,
          image_url: imageUrl,
          ad_url: adLink,
          location: location || undefined,
          address: address || undefined,
          published_at: publishedAt,
          updated_at: updatedAt,
          // Все доступные текстовые поля для фильтрации
          _rawLocation: normalizeText(location),
          _rawRegion: normalizeText(region),
          _rawAddress: normalizeText(address),
          _rawAdLocation: normalizeText(adLocation),
          _brand: normalizeText(getAdParam(ad, 'phones_brand', 'phone_brand', 'brand')),
        };
      });

      // Дополнительная фильтрация по городу для city-level URLs.
      // Не используем title/description как основной источник: "доставка в Минск"
      // не означает, что объявление находится в Минске.
      if (citySlugForFilter) {
        const variants = (CITY_VARIANTS[citySlugForFilter] || [citySlugForFilter]).map(normalizeText);

        processedAds = processedAds.filter((ad: any) => {
          const structured = [ad._rawLocation, ad._rawAdLocation, ad._rawAddress]
            .filter(Boolean)
            .join(' ');

          if (structured) {
            if (citySlugForFilter === 'minsk' && structured.includes('минскии раион')) return false;
            return variants.some(variant => structured.includes(variant));
          }

          const fallback = normalizeText(ad.title + ' ' + (ad.description || ''));
          return variants.some(variant => fallback.includes(variant));
        });

        logger.info(`Filtered ads by city: ${citySlugForFilter}`, {
          before: uniqueAds.length,
          after: processedAds.length,
        });
      }

      // Структурированный бренд имеет приоритет; title используется только
      // если Kufar не прислал соответствующий параметр.
      if (subcat) {
        const brandName = normalizeText(subcat);
        processedAds = processedAds.filter((ad: any) => {
          if (ad._brand) return ad._brand === brandName;
          const title = normalizeText(ad.title);
          return title.split(/\s+/).some((word: string) => word.replace(/[^a-zа-я0-9]/gi, '') === brandName);
        });

        logger.info(`Filtered ads by brand: ${subcat}`, {
          afterFilter: processedAds.length,
        });
      }

      // --- 4.5. Fallback: описание из параметров API (HTML-парсинг отключён — Kufar банит) ---
      processedAds.forEach((ad) => {
        if (!ad.description) {
          const rawAd = uniqueAds.find((u: any) => String(u.ad_id) === ad.external_id);
          if (rawAd?.ad_parameters?.length) {
            const usefulParams = rawAd.ad_parameters.filter((p: any) => {
              return !['category', 'region', 'remuneration_type', 'delivery_enabled'].includes(p.p);
            });
            if (usefulParams.length > 0) {
              ad.description = usefulParams.map((p: any) => `${p.pl}: ${p.vl}`).join('\n');
            }
          }
        }
      });

      // --- 5. Финальная очистка и возврат результата ---
      const finalAds = processedAds.map(({ _rawLocation, _rawRegion, _rawAddress, _rawAdLocation, _brand, ...ad }) => ad);
      
      logger.info('Final ad summary', { 
        url, 
        totalAds: finalAds.length,
        ads: finalAds.map(a => ({ 
          id: a.external_id, 
          title: a.title, 
          price: a.price,
          location: a.location || a.address || 'N/A' 
        }))
      });
      
      return finalAds;

    } catch (error: any) {
      logger.error('Kufar API parsing failed', {
        url,
        error: error.message,
        status: error.response?.status,
        responseData: error.response?.data ? JSON.stringify(error.response.data).substring(0, 200) : undefined
      });
      throw error;
    }
  }
}