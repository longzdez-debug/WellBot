import { BaseParser } from './BaseParser';
import { Ad } from '../types';
import { logger } from '../utils/logger';

const CATEGORY_MAP: Record<string, string> = {
  avtomobili: '2010', mototsikly: '2020', 'avtobusy-i-mikroavtobusy': '2030', 'shiny-i-diski': '2100',
  'telefony-i-planshety': '17010', 'mobilnye-telefony': '17010', telefony: '17010',
  noutbuki: '19020', kompyutery: '19010', televizory: '12030', 'igrovye-pristavki-i-igry': '12040',
  'stiralnye-mashiny': '14050', kvartiru: '1010', komnatu: '1030', dom: '1020', dachu: '1020',
  uchastok: '1050', kommercheskaya: '1060', garazh: '1040', mebel: '15040', velosipedy: '8030',
};

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

const ALLOWED_SEARCH_PARAMS = new Set(['query', 'prc', 'rms', 'gtsy']);
const API_ENDPOINTS = [
  'https://api.kufar.by/search-api/v2/search/rendered-paginated',
  'https://cre-api.kufar.by/ads-search/v1/engine/v1/search/rendered-paginated',
];

function normalizeSearchText(value: unknown): string {
  return String(value ?? '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
      if (ALLOWED_SEARCH_PARAMS.has(key) && value) params[key] = value;
    }

    let requestedBrandSlug = '';
    for (const part of parts) {
      const normalizedPart = part.toLocaleLowerCase('ru-RU');
      if (CATEGORY_MAP[normalizedPart]) {
        params.cat = CATEGORY_MAP[normalizedPart];
        continue;
      }

      const brandSlug = part.match(/^mt~(.+)$/i)?.[1]?.toLocaleLowerCase('ru-RU');
      if (brandSlug && BRAND_MAP[brandSlug]) requestedBrandSlug = brandSlug;
    }

    const requestedQuery = String(parsed.searchParams.get('query') || '').trim();
    const brandTerms = requestedBrandSlug ? (BRAND_TERMS[requestedBrandSlug] || [requestedBrandSlug]) : [];
    const normalizedBrandTerms = brandTerms.map(normalizeSearchText).filter(Boolean);
    const normalizedRequestedQuery = normalizeSearchText(requestedQuery);

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

    const effectiveQuery = String(params.query || '').trim();
    const queryTerms = normalizeSearchText(effectiveQuery)
      .split(' ')
      .filter(term => term.length >= 2);

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

    let lastError: any = null;
    for (let i = 0; i < API_ENDPOINTS.length; i++) {
      const endpoint = API_ENDPOINTS[i];
      try {
        const requestStartedAt = Date.now();
        const response = await this.axiosInstance.get(endpoint, {
          params,
          timeout: 6000,
          headers: {
            Host: new URL(endpoint).host,
            'User-Agent': this.getRandomUserAgent(),
            Accept: 'application/json',
            Referer: 'https://www.kufar.by/',
          },
        });

        const rawAds = Array.isArray(response.data?.ads) ? response.data.ads : [];
        const ads = rawAds.filter((ad: any) => {
          if (!ad?.ad_id) return false;
          const text = adSearchText(ad);
          if (normalizedBrandTerms.length > 0 && !normalizedBrandTerms.some(term => text.includes(term))) return false;
          if (queryTerms.length > 0 && !queryTerms.every(term => text.includes(term))) return false;
          return true;
        });

        const timestamps = rawAds
          .map((ad: any) => Number(ad?.list_time))
          .filter((value: number) => Number.isFinite(value) && value > 0);
        logger.debug('Kufar hot-path page received', {
          count: ads.length,
          rawCount: rawAds.length,
          requestedBrand: requestedBrandSlug || undefined,
          requestedQuery: requestedQuery || undefined,
          upstreamQuery: params.query || undefined,
          newestPublishedAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : undefined,
          oldestPublishedAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : undefined,
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
          } as Ad;
        });
      } catch (error: any) {
        lastError = error;
        const status = error?.response?.status;
        logger.warn('Kufar API request failed', { endpoint, status, params, error: error?.message });
        if (status !== 422 || i === API_ENDPOINTS.length - 1) throw error;
      }
    }
    throw lastError || new Error('Kufar API request failed');
  }
}
