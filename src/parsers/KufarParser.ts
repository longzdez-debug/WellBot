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
          if (BRAND_SLUG_TO_API[brandSlug]) {
            subcat = BRAND_SLUG_TO_API[brandSlug];
          }
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

      // --- 2. Сборка параметров и выполнение запросов к API (с пагинацией) ---
      const apiParams: any = { size: 100, sort: 'lst.d' };
      if (cat) apiParams.cat = cat;
      if (rgn) apiParams.rgn = rgn;
      if (typ) apiParams.typ = typ;

      // Search text may be encoded in either the path (q~...) or query string.
      // An explicit ?query= takes precedence when both are present.
      if (pathQuery) apiParams.query = pathQuery;
      
      // Пробрасиваем "безопасные" параметры из исходного URL
      urlObj.searchParams.forEach((value, key) => {
        if (['prc', 'rms', 'gtsy', 'query'].includes(key)) {
          apiParams[key] = value;
        }
      });
      
      logger.info('Making Kufar API requests (with pagination)', { params: apiParams, originalUrl: url });

      const paginatedResponse = await this.axiosInstance.get(
        'https://api.kufar.by/search-api/v2/search/rendered-paginated',
        {
          params: apiParams,
          headers: {
            'Host': 'api.kufar.by',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        }
      );

      // --- 2.1. Пагинация: собираем ВСЕ объявления по страницам (параллельно) ---
      const allPaginatedAds: any[] = paginatedResponse.data?.ads || [];
      const meta = paginatedResponse.data?.meta || {};
      const totalAvailable = meta?.total || allPaginatedAds.length;
      const fetchedOnFirstPage = allPaginatedAds.length;
      const totalPages = meta?.totalPages || Math.ceil(totalAvailable / 100);

      logger.info('Kufar pagination info', { 
        totalAvailable, 
        fetchedOnFirstPage, 
        totalPages,
        hasNextPage: meta?.next ? true : false 
      });

      // Параллельная загрузка всех страниц (батчами по 5 для ограничения нагрузки)
      if (meta?.next) {
        const pageNumbers: number[] = [];
        for (let p = 2; p <= totalPages && p <= 51; p++) {
          pageNumbers.push(p);
        }

        // Разбиваем на батчи по 5 параллельных запросов
        const BATCH_SIZE = 5;
        for (let i = 0; i < pageNumbers.length; i += BATCH_SIZE) {
          const batch = pageNumbers.slice(i, i + BATCH_SIZE);
          const responses = await Promise.allSettled(
            batch.map(async (page) => {
              const resp = await this.axiosInstance.get(
                'https://api.kufar.by/search-api/v2/search/rendered-paginated',
                {
                  params: { ...apiParams, page, size: 100 },
                  headers: {
                    'Host': 'api.kufar.by',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  },
                }
              );
              return resp.data?.ads || [];
            })
          );

          for (const res of responses) {
            if (res.status === 'fulfilled') {
              const ads = res.value;
              if (ads.length > 0) allPaginatedAds.push(...ads);
            }
          }

          // Небольшая задержка между батчами
          if (i + BATCH_SIZE < pageNumbers.length) {
            await this.sleep(200 + Math.random() * 300);
          }
        }
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
            headers: {
              'Host': 'api.kufar.by',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
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
        const location = locationParam?.vl;

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
          _rawLocation: (location || '').toLowerCase(),
          _rawAddress: (address || '').toLowerCase(),
          _rawAdLocation: (adLocation || '').toLowerCase(),
          // Бренд из параметров (для фильтрации)
          _brand: (ad.ad_parameters?.find((p: any) => p.p === 'phones_brand')?.vl || '').toLowerCase(),
        };
      });

      // Применяем фильтрацию по городу (если город указан в path URL)
      if (citySlugForFilter) {
        const targetCityVariants = CITY_VARIANTS[citySlugForFilter] || [citySlugForFilter];
        
        // Слова, которые означают что это НЕ город, а район/область/примечание
        // Но только если они НЕ идут после названия города
        const excludePatterns = [
          /могилевский\s+район/gi,
          /брестский\s+район/gi,
          /витебский\s+район/gi,
          /гродненский\s+район/gi,
          /гомельский\s+район/gi,
          /минский\s+район/gi,
          /минская\s+область/gi,
          /могилевская\s+область/gi,
          /брестская\s+область/gi,
          /витебская\s+область/gi,
          /гомельская\s+область/gi,
          /гродненская\s+область/gi,
          /обл\s*г\s*/gi,
          /обл\.?\s*р-н/gi,
        ];
        
        processedAds = processedAds.filter(ad => {
          // Собираем все текстовые поля для поиска + заголовок (часто город в названии)
          const searchText = `${ad.title} ${ad.description || ''} ${ad._rawLocation} ${ad._rawAddress} ${ad._rawAdLocation}`;
          
          if (!searchText) return false;
          
          // Сначала проверяем, что город указан в тексте
          const hasCity = targetCityVariants.some(variant => searchText.includes(variant));
          if (!hasCity) return false;
          
          // Проверяем, что это НЕ прилагательное или район — но только если город НЕ упоминается рядом
          const hasExclude = excludePatterns.some(pattern => pattern.test(searchText));
          if (hasExclude) {
            // Дополнительная проверка: если город упоминается рядом с "район", это допустимо
            // (например "Могилёв, Первомайский район" — это нормально)
            const cityNearExclude = targetCityVariants.some(variant => {
              const idx = searchText.indexOf(variant);
              if (idx === -1) return false;
              // Проверяем 100 символов после города — если там нет слова "район" или "область", то ок
              const segment = searchText.substring(idx, Math.min(idx + 150, searchText.length));
              return !segment.includes('район') && !segment.includes('область') && !segment.includes('обл');
            });
            if (cityNearExclude) return true;
            return false;
          }
          
          return true;
        });
        logger.info(`Filtered ads by city: ${citySlugForFilter}`, { before: uniqueAds.length, after: processedAds.length });
        
        // Лог отфильтрованных объявлений для отладки
        const filteredCount = uniqueAds.length - processedAds.length;
        if (filteredCount > 0) {
          const filteredAds = uniqueAds.filter((ad: any) => {
            const adId = ad.ad_id;
            return !processedAds.some(p => String(p.external_id) === String(adId));
          });
          logger.info(`Filtered out ${filteredCount} ads by city: ${citySlugForFilter}`, {
            filtered: filteredAds.map(a => ({ id: a.ad_id, title: a.subject, location: a.ad_location }))
          });
        }
      }

      // Применяем фильтрацию по бренду (например, mt~apple)
      if (subcat) {
        const brandName = subcat.toLowerCase();
        processedAds = processedAds.filter(ad => {
          // Ищем бренд в title, description и в извлечённом бренде из параметров
          const searchText = `${ad.title} ${ad.description || ''}`.toLowerCase();
          return ad._brand === brandName || searchText.includes(brandName);
        });
        logger.info(`Filtered ads by brand: ${subcat}`, { afterFilter: processedAds.length });
        
        // Лог отфильтрованных по бренду
        const brandFilteredCount = uniqueAds.length - processedAds.length;
        if (brandFilteredCount > 0) {
          logger.info(`Filtered out ${brandFilteredCount} ads by brand: ${subcat}`);
        }
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
      const finalAds = processedAds.map(({ _rawLocation, _rawAddress, _rawAdLocation, _brand, ...ad }) => ad);
      
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