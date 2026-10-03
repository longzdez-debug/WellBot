import { BaseParser } from './BaseParser';
import { Ad } from '../types';
import { logger } from '../utils/logger';

const CATEGORY_MAP: Record<string, string> = {};

const BRAND_MAP: Record<string, string> = {
  apple: 'Apple', samsung: 'Samsung', xiaomi: 'Xiaomi', huawei: 'Huawei', honor: 'Honor',
  nokia: 'Nokia', realme: 'Realme', oppo: 'OPPO', vivo: 'Vivo', oneplus: 'OnePlus',
  google: 'Google', tecno: 'Tecno', infinix: 'Infinix',
};

const BRAND_TERMS: Record<string, string[]> = {
  apple: ['apple', 'iphone', 'айфон'],
  samsung: ['samsung', 'самсунг'],
  xiaomi: ['xiaomi', 'ксиаоми', 'сяоми'],
  huawei: ['huawei', 'хуавей'],
  honor: ['honor', 'хонор'],
  nokia: ['nokia', 'нокиа'],
  realme: ['realme', 'рілмі', 'рилми'],
  oppo: ['oppo'],
  vivo: ['vivo'],
  oneplus: ['oneplus', 'one plus'],
  google: ['google', 'pixel'],
  tecno: ['tecno', 'техно'],
  infinix: ['infinix'],
};

const REGION_MAP: Record<string, string> = {
  minsk: '7', brest: '1', vitebsk: '6', gomel: '2', grodno: '3', mogilev: '4',
  'minskaya-oblast': '5', 'brestskaya-oblast': '1', 'vitebskaya-oblast': '6',
  'gomelskaya-oblast': '2', 'grodnenskaya-oblast': '3', 'mogilevskaya-oblast': '4',
  baranovichi: '1', pinsk: '1', kobrin: '1', bereza: '1', orsha: '6', polotsk: '6', novopolotsk: '6',
  zhlobin: '2', mozyr: '2', rechitsa: '2', svetlogorsk: '2', lida: '3', volkovysk: '3', slonim: '3',
  borisov: '5', soligorsk: '5', molodechno: '5', zhodino: '5', slutsk: '5', bobruisk: '4',
};

const API_ENDPOINTS = [
  'https://api.kufar.by/search-api/v2/search/rendered-paginated',
  'https://cre-api.kufar.by/ads-search/v1/engine/v1/search/rendered-paginated',
];

const CITY_VARIANTS: Record<string, string[]> = {
  minsk: ['минск','первомайский','московский','ленинский','заводской','октябрьский','фрунзенский','партизанский','советский','центральный'],
  brest: ['брест'], baranovichi: ['барановичи'], pinsk: ['пинск'], kobrin: ['кобрин'], bereza: ['береза'],
  vitebsk: ['витебск'], orsha: ['орша'], polotsk: ['полоцк'], novopolotsk: ['новополоцк'],
  gomel: ['гомель'], zhlobin: ['жлобин'], mozyr: ['мозырь'], rechitsa: ['речица'], svetlogorsk: ['светлогорск'],
  grodno: ['гродно'], lida: ['лида'], volkovysk: ['волковыск'], slonim: ['слоним'],
  mogilev: ['могилев'], bobruisk: ['бобруйск'], borisov: ['борисов'], soligorsk: ['солигорск'],
  molodechno: ['молодечно'], zhodino: ['жодино'], slutsk: ['слуцк'],
};

function structuredCityMatches(value: unknown, expected: string): boolean {
  if (!value) return false;
  const parts = String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .split(/[,;|]/)
    .map(part => part.trim().replace(/^(?:г|город)\s+/, ''))
    .filter(Boolean);
  return parts.some(part => part === expected);
}

function adCityMatches(ad: any, citySlug: string): boolean {
  const variants = CITY_VARIANTS[citySlug] || [citySlug];
  const values = [
    ad?.ad_parameters?.find((p: any) => p?.p === 'area')?.vl,
    ad?.ad_location,
  ].filter(Boolean);
  return variants.some(variant => values.some(value => structuredCityMatches(value, variant)));
}

function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function adCondition(ad: any): string { const parameter = ad?.ad_parameters?.find((p: any) => p?.p === 'condition'); return String(parameter?.vl ?? parameter?.v ?? parameter?.value ?? '').trim(); }
function adSearchText(ad: any): string {
  const values: string[] = [ad?.subject, ad?.description];

  for (const collection of [ad?.ad_parameters, ad?.account_parameters]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!item || typeof item !== 'object') continue;
      values.push(item.p, item.v, item.vl, item.value, item.name, item.label);
    }
  }

  return normalizeSearchText(values.filter(Boolean).join(' '));
}

export class FastKufarParser extends BaseParser {
  platform = 'kufar' as const;

  async parseUrl(url: string): Promise<Ad[]> {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const params: Record<string, string | number> = { size: 100, sort: 'lst.d' };

    for (const [key, value] of parsed.searchParams.entries()) {
      if (key !== 'page' && key !== 'cursor' && key !== 'wb' && value) params[key] = value;
    }

    let requestedBrandSlug = '';
    let requestedCitySlug = '';
    for (const part of parts) {
      const normalizedPart = part.toLocaleLowerCase('ru-RU');
      const cityCandidate = normalizedPart.match(/^r~(.+)$/i)?.[1] || '';
      if (cityCandidate && CITY_VARIANTS[cityCandidate]) requestedCitySlug = cityCandidate;
      if (CITY_VARIANTS[normalizedPart]) requestedCitySlug = normalizedPart;
      if (CATEGORY_MAP[normalizedPart]) {
        params.cat = CATEGORY_MAP[normalizedPart];
        continue;
      }

      const brandSlug = part.match(/^mt~(.+)$/i)?.[1]?.toLocaleLowerCase('ru-RU');
      if (brandSlug && BRAND_MAP[brandSlug]) requestedBrandSlug = brandSlug;
    }

    const requestedQuery = String(parsed.searchParams.get('query') || '').trim();
    const monitorIdentity = String(parsed.searchParams.get('wb') || '').split('|');
    const requestedCondition = monitorIdentity[8] === 'new' || monitorIdentity[8] === 'used' ? monitorIdentity[8] : '';
    const requestedSeller = monitorIdentity[9] === 'private' || monitorIdentity[9] === 'company' ? monitorIdentity[9] : '';
    const requestedMinPrice = monitorIdentity[6] ? Number(monitorIdentity[6]) : undefined;
    const requestedMaxPrice = monitorIdentity[7] ? Number(monitorIdentity[7]) : undefined;
    const brandTerms = requestedBrandSlug ? (BRAND_TERMS[requestedBrandSlug] || [requestedBrandSlug]) : [];
    const normalizedBrandTerms = brandTerms.map(normalizeSearchText).filter(Boolean);
    const normalizedRequestedQuery = normalizeSearchText(requestedQuery);
    const requestedQueryTerms = normalizedRequestedQuery.split(' ').filter(term => term.length >= 2);
    const queryMatchesAd = (text: string): boolean => {
      if (!requestedQueryTerms.length) return true;
      if (text.includes(normalizedRequestedQuery)) return true;
      return requestedQueryTerms.every(term => text.includes(term));
    };

    // Do not send Kufar's brand subcategory value (e.g. subcat=Apple):
    // current API variants reject it with HTTP 422. Brand matching is enforced
    // locally, so the monitor remains strict without breaking the request.
    // A redundant query equal to the selected brand is also omitted; it is
    // covered by the authoritative local brand filter.
    const queryMatchesBrand = Boolean(
      normalizedRequestedQuery && normalizedBrandTerms.some(term => normalizedRequestedQuery === term),
    );
    if (queryMatchesBrand) delete params.query;

    // For a pure brand URL (mt~apple without query), use a valid text query to
    // keep the newest matching listings near the first page, while still
    // validating every returned ad locally.
    if (!requestedQuery && requestedBrandSlug) params.query = BRAND_MAP[requestedBrandSlug];

    const gtsy = parsed.searchParams.get('gtsy');
    if (gtsy) {
      if (gtsy.includes('province-minsk_gorod')) params.rgn = '7';
      else if (gtsy.includes('province-minskaja_oblast')) params.rgn = '5';
      else if (gtsy.includes('province-brestskaja_oblast')) params.rgn = '1';
      else if (gtsy.includes('province-vitebskaja_oblast')) params.rgn = '6';
      else if (gtsy.includes('province-gomelskaja_oblast')) params.rgn = '2';
      else if (gtsy.includes('province-grodnenskaja_oblast')) params.rgn = '3';
      else if (gtsy.includes('province-mogilevskaja_oblast')) params.rgn = '4';
    }

    if (!params.rgn) {
      for (const part of parts) {
        const region = part.match(/^r~(.+)$/i)?.[1]?.toLocaleLowerCase('ru-RU') || part.toLocaleLowerCase('ru-RU');
        if (REGION_MAP[region]) { params.rgn = REGION_MAP[region]; break; }
      }
    }

    if (parts.includes('snyat')) params.typ = 'let';
    if (parts.includes('kupit')) params.typ = 'sell';

    const requestApi = async (endpoint: string): Promise<Ad[]> => {
      const requestStartedAt = Date.now();
      const response = await this.axiosInstance.get(endpoint, {
        params,
        timeout: 3500,
        headers: {
          Host: new URL(endpoint).host,
          'User-Agent': this.getRandomUserAgent(),
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          Referer: 'https://www.kufar.by/',
          Origin: 'https://www.kufar.by',
        },
      });

      const rawAds = Array.isArray(response.data?.ads) ? response.data.ads : [];
      const ads = rawAds.filter((ad: any) => {
        if (!ad?.ad_id) return false;
        if (requestedCitySlug && !adCityMatches(ad, requestedCitySlug)) return false;
        const text = adSearchText(ad);
        if (!queryMatchesAd(text)) return false;
        if (normalizedBrandTerms.length > 0 && !normalizedBrandTerms.some(term => text.includes(term))) return false;
        const condition = normalizeSearchText(adCondition(ad));
        if (requestedCondition === 'new' && !/(new|нов|новое|новая|новый)/.test(condition)) return false;
        if (requestedCondition === 'used' && /(new|нов|новое|новая|новый)/.test(condition)) return false;
        if (requestedSeller === 'company' && !ad.company_ad) return false;
        if (requestedSeller === 'private' && ad.company_ad) return false;
        const rawPrice = ad.price_byn != null ? Number(ad.price_byn) / 100 : ad.price_usd != null ? Number(ad.price_usd) / 100 : undefined;
        if (requestedMinPrice != null && Number.isFinite(requestedMinPrice) && (rawPrice == null || rawPrice < requestedMinPrice)) return false;
        if (requestedMaxPrice != null && Number.isFinite(requestedMaxPrice) && (rawPrice == null || rawPrice > requestedMaxPrice)) return false;
        return true;
      });

      logger.debug('Kufar hot-path API page received', {
        endpoint,
        count: ads.length,
        rawCount: rawAds.length,
        requestMs: Date.now() - requestStartedAt,
      });

      return ads.map((ad: any) => {
        let price = 'Договорная';
        if (ad.price_byn != null) price = `${(Number(ad.price_byn) / 100).toFixed(2)} BYN`;
        else if (ad.price_usd != null) price = `${(Number(ad.price_usd) / 100).toFixed(2)} USD`;
        const image = ad.images?.[0];
        const location = ad.ad_parameters?.find((p: any) => p?.p === 'area')?.vl;
        const address = ad.account_parameters?.find((p: any) => p?.p === 'address')?.v;
        return {
          external_id: String(ad.ad_id),
          title: ad.subject || 'Без названия',
          description: ad.description,
          price,
          image_url: image?.path ? `https://rms4.kufar.by/v1/gallery/${image.path}` : image?.url,
          ad_url: ad.ad_link || `https://www.kufar.by/ad/${ad.ad_id}`,
          location,
          address,
          published_at: ad.list_time ? new Date(ad.list_time) : undefined,
          updated_at: ad.list_time_up ? new Date(ad.list_time_up) : undefined,
          condition: adCondition(ad) || null,
          is_company: Boolean(ad.company_ad),
        } as Ad;
      });
    };

    const requestHtml = async (): Promise<Ad[]> => {
      const started = Date.now();
      const response = await this.axiosInstance.get(url, {
        timeout: 4500,
        headers: {
          'User-Agent': this.getRandomUserAgent(),
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });
      const html = String(response.data || '');
      const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      if (!match?.[1]) throw new Error('Kufar page has no __NEXT_DATA__');

      const root = JSON.parse(match[1]);
      const found: any[] = [];
      const seen = new Set<any>();
      const visit = (value: any, depth = 0): void => {
        if (!value || depth > 8 || found.length >= 100 || seen.has(value)) return;
        if (typeof value !== 'object') return;
        seen.add(value);
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item?.ad_id || item?.id && (item?.subject || item?.ad_link || item?.price_byn != null)) {
              found.push(item);
            } else visit(item, depth + 1);
          }
          return;
        }
        for (const child of Object.values(value)) visit(child, depth + 1);
      };
      visit(root);

      const unique = new Map<string, any>();
      for (const ad of found) {
        const id = String(ad.ad_id ?? ad.id ?? '');
        if (id) unique.set(id, ad);
      }

      logger.debug('Kufar hot-path HTML page received', {
        count: unique.size,
        requestMs: Date.now() - started,
      });

      return [...unique.values()].map((ad: any) => {
        if (requestedCitySlug && !adCityMatches(ad, requestedCitySlug)) return null;
        const text = adSearchText(ad);
        if (!queryMatchesAd(text)) return null;
        if (normalizedBrandTerms.length && !normalizedBrandTerms.some(term => text.includes(term))) return null;
        const condition = normalizeSearchText(adCondition(ad));
        if (requestedCondition === 'new' && !/(new|нов|новое|новая|новый)/.test(condition)) return null;
        if (requestedCondition === 'used' && /(new|нов|новое|новая|новый)/.test(condition)) return null;
        if (requestedSeller === 'company' && !ad.company_ad) return null;
        if (requestedSeller === 'private' && ad.company_ad) return null;
        const rawPrice = ad.price_byn != null ? Number(ad.price_byn) / 100 : ad.price_usd != null ? Number(ad.price_usd) / 100 : undefined;
        if (requestedMinPrice != null && Number.isFinite(requestedMinPrice) && (rawPrice == null || rawPrice < requestedMinPrice)) return null;
        if (requestedMaxPrice != null && Number.isFinite(requestedMaxPrice) && (rawPrice == null || rawPrice > requestedMaxPrice)) return null;
        let price = 'Договорная';
        if (ad.price_byn != null) price = `${(Number(ad.price_byn) / 100).toFixed(2)} BYN`;
        else if (ad.price_usd != null) price = `${(Number(ad.price_usd) / 100).toFixed(2)} USD`;
        const image = ad.images?.[0];
        return {
          external_id: String(ad.ad_id ?? ad.id),
          title: ad.subject || ad.title || 'Без названия',
          description: ad.description,
          price,
          image_url: image?.path ? `https://rms4.kufar.by/v1/gallery/${image.path}` : image?.url,
          ad_url: ad.ad_link || ad.url || `https://www.kufar.by/ad/${ad.ad_id ?? ad.id}`,
          location: ad.ad_parameters?.find((p: any) => p?.p === 'area')?.vl,
          address: ad.account_parameters?.find((p: any) => p?.p === 'address')?.v,
          published_at: ad.list_time ? new Date(ad.list_time) : undefined,
          updated_at: ad.list_time_up ? new Date(ad.list_time_up) : undefined,
          condition: adCondition(ad) || null,
          is_company: Boolean(ad.company_ad),
        } as Ad;
      }).filter(Boolean) as Ad[];
    };

    try {
      // API category filtering is ID-based. For catalog slugs without a verified
      // API ID we deliberately use the rendered category page instead of risking
      // a silent fallback to "all Kufar listings".
      if (params.cat) {
        const results = await Promise.allSettled(API_ENDPOINTS.map(requestApi));
        const nonEmpty = results.find((result): result is PromiseFulfilledResult<Ad[]> => result.status === 'fulfilled' && result.value.length > 0);
        if (nonEmpty) return nonEmpty.value;
        const empty = results.find((result): result is PromiseFulfilledResult<Ad[]> => result.status === 'fulfilled');
        if (empty) return empty.value;
        throw new Error('All Kufar API endpoints failed');
      }
      logger.debug('Kufar category has no verified API id; using rendered category page', {
        url,
        categoryPath: parts.filter(part => !/^r~|^mt~/i.test(part)).join('/'),
        query: requestedQuery || null,
      });
    } catch (error: any) {
      logger.warn('Kufar API hot-path failed; trying rendered page', {
        url,
        errors: Array.isArray(error?.errors) ? error.errors.map((e: any) => e?.message).slice(0, 2) : [error?.message],
      });
    }

    return await requestHtml();
  }
}
