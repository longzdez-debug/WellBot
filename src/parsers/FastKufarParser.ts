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

const BRAND_SLUG_TO_API: Record<string, string> = {
  apple: 'Apple', samsung: 'Samsung', xiaomi: 'Xiaomi', huawei: 'Huawei', honor: 'Honor', nokia: 'Nokia',
  realme: 'Realme', oppo: 'OPPO', vivo: 'Vivo', oneplus: 'OnePlus', google: 'Google', tecno: 'Tecno', infinix: 'Infinix',
};

const REGION_MAP: Record<string, string> = {
  minsk: '7', brest: '1', vitebsk: '6', gomel: '2', grodno: '3', mogilev: '4',
  'minskaya-oblast': '5', 'brestskaya-oblast': '1', 'vitebskaya-oblast': '6',
  'gomelskaya-oblast': '2', 'grodnenskaya-oblast': '3', 'mogilevskaya-oblast': '4',
  baranovichi: '1', pinsk: '1', kobrin: '1', bereza: '1', orsha: '6', polotsk: '6', novopolotsk: '6',
  zhlobin: '2', mozyr: '2', rechitsa: '2', svetlogorsk: '2', lida: '3', volkovysk: '3', slonim: '3',
  borisov: '5', soligorsk: '5', molodechno: '5', zhodino: '5', slutsk: '5', bobruisk: '4',
};

export class FastKufarParser extends BaseParser {
  platform = 'kufar' as const;

  async parseUrl(url: string): Promise<Ad[]> {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const params: Record<string, string | number> = { size: 100, sort: 'lst.d' };

    for (const part of parts) {
      if (CATEGORY_MAP[part]) { params.cat = CATEGORY_MAP[part]; break; }
    }

    for (const part of parts) {
      const brand = part.match(/^mt~(.+)$/)?.[1];
      if (brand && BRAND_SLUG_TO_API[brand]) {
        params.subcat = BRAND_SLUG_TO_API[brand];
        break;
      }
    }

    const gtsy = parsed.searchParams.get('gtsy');
    if (gtsy) {
      params.gtsy = gtsy;
      if (gtsy.includes('province-minsk_gorod')) params.rgn = '7';
      else if (gtsy.includes('province-minskaja_oblast')) params.rgn = '5';
      else if (gtsy.includes('province-brestskaja_oblast')) params.rgn = '1';
      else if (gtsy.includes('province-vitebskaja_oblast')) params.rgn = '6';
      else if (gtsy.includes('province-gomelskaja_oblast')) params.rgn = '2';
      else if (gtsy.includes('province-grodnenskaja_oblast')) params.rgn = '3';
      else if (gtsy.includes('province-mogilevskaja_oblast')) params.rgn = '4';
    }

    const query = parsed.searchParams.get('query');
    if (query) params.query = query;
    for (const key of ['prc', 'rms']) {
      const value = parsed.searchParams.get(key);
      if (value) params[key] = value;
    }

    if (!params.rgn) {
      for (const part of parts) {
        const region = part.match(/^r~(.+)$/)?.[1] || part;
        if (REGION_MAP[region]) { params.rgn = REGION_MAP[region]; break; }
      }
    }

    if (parts.includes('snyat')) params.typ = 'let';
    if (parts.includes('kupit')) params.typ = 'sell';

    const response = await this.axiosInstance.get(
      'https://api.kufar.by/search-api/v2/search/rendered-paginated',
      {
        params,
        timeout: 8000,
        headers: {
          Host: 'api.kufar.by',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          Accept: 'application/json',
        },
      },
    );

    const ads = Array.isArray(response.data?.ads) ? response.data.ads : [];
    const result: Ad[] = ads
      .filter((ad: any) => ad?.ad_id)
      .map((ad: any) => {
        let price = 'Договорная';
        if (ad.price_byn != null) price = `${(Number(ad.price_byn) / 100).toFixed(2)} BYN`;
        else if (ad.price_usd != null) price = `${(Number(ad.price_usd) / 100).toFixed(2)} USD`;
        const image = ad.images?.[0];
        const location = ad.ad_parameters?.find((p: any) => p?.p === 'area')?.vl;
        const address = ad.account_parameters?.find((p: any) => p?.p === 'address')?.v;
        return {
          external_id: String(ad.ad_id),
          title: ad.subject || 'Без названия',
          description: undefined,
          price,
          image_url: image?.path ? `https://rms4.kufar.by/v1/gallery/${image.path}` : image?.url,
          ad_url: ad.ad_link || `https://www.kufar.by/ad/${ad.ad_id}`,
          location,
          address,
          published_at: ad.list_time ? new Date(ad.list_time) : undefined,
          updated_at: ad.list_time_up ? new Date(ad.list_time_up) : undefined,
        } as Ad;
      });

    logger.debug('Fast Kufar parse complete', { url, ads: result.length });
    return result;
  }
}
