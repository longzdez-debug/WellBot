import { FastKufarParser } from '../parsers/FastKufarParser';

function nextData(ads: unknown[]): string {
  return '<script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({ props: { pageProps: { ads } } }) +
    '</script>';
}

describe('FastKufarParser catalog/search behavior', () => {
  test('uses the selected Kufar category page and keeps only query matches', async () => {
    const calls: Array<{ url: string; config: any }> = [];
    const axiosMock = {
      get: jest.fn(async (url: string, config: any) => {
        calls.push({ url, config });
        return {
          data: nextData([
            { ad_id: '1', subject: 'Apple iPhone 15 Pro', description: 'Телефон', price_byn: 100000, ad_link: 'https://www.kufar.by/ad/1' },
            { ad_id: '2', subject: 'Samsung Galaxy S24', description: 'Телефон', price_byn: 120000, ad_link: 'https://www.kufar.by/ad/2' },
          ]),
        };
      }),
    } as any;

    const parser = new FastKufarParser(axiosMock);
    const ads = await parser.parseUrl('https://www.kufar.by/l/elektronika?query=iPhone%2015');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://www.kufar.by/l/elektronika?query=iPhone%2015');
    expect(ads.map(ad => ad.external_id)).toEqual(['1']);
  });

  test('uses numeric catalog id from monitor identity', async () => {
    const calls: any[] = [];
    const axiosMock = {
      get: jest.fn(async (_url: string, config: any) => {
        calls.push(config);
        return { data: { ads: [], pagination: { pages: [] } } };
      }),
    } as any;

    const parser = new FastKufarParser(axiosMock);
    await parser.parseUrl(
      'https://www.kufar.by/l/telefony-i-planshety/wb?wb=kufar%7C17010%7C17050%7C%7C%7C%7C%7Cminsk%7C%7C0%7C2000%7Cnew%7Cprivate%7Cnormal',
    );

    expect(calls[0].params.cat).toBe('17050');
  });

  test('enforces brand and model from monitor identity even without query text', async () => {
    const axiosMock = {
      get: jest.fn(async () => ({
        data: { ads: [
          { ad_id: 'ok', subject: 'Apple iPhone 17 Pro', description: '256 GB', ad_parameters: [{ p: 'condition', vl: 'Новое' }], company_ad: false, price_byn: 150000, ad_link: 'https://www.kufar.by/ad/ok' },
          { ad_id: 'wrong-brand', subject: 'Samsung Galaxy S26', description: '256 GB', ad_parameters: [{ p: 'condition', vl: 'Новое' }], company_ad: false, price_byn: 150000, ad_link: 'https://www.kufar.by/ad/wrong-brand' },
          { ad_id: 'wrong-model', subject: 'Apple iPhone 16 Pro', description: '256 GB', ad_parameters: [{ p: 'condition', vl: 'Новое' }], company_ad: false, price_byn: 150000, ad_link: 'https://www.kufar.by/ad/wrong-model' },
        ] },
      })),
    } as any;

    const parser = new FastKufarParser(axiosMock);
    const ads = await parser.parseUrl(
      'https://www.kufar.by/l/mobilnye-telefony/mt~apple-iphone-17-pro?wb=kufar%7Cphones%7C17010%7Capple%7CiPhone%2017%20Pro%7C%7C%7C%7C%7C1500%7C2000%7Cnew%7Cprivate%7Cnormal',
    );

    expect(ads.map(ad => ad.external_id)).toEqual(['ok']);
  });

  test('parses JSON monitor identity without breaking pipe-containing filters', async () => {
    const axiosMock = {
      get: jest.fn(async (_url: string, config: any) => {
        expect(config.params.cat).toBe('17010');
        return {
          data: { ads: [
            { ad_id: 'ok', subject: 'Apple iPhone 17 | Pro', description: '256 GB', company_ad: false, price_byn: 150000, ad_link: 'https://www.kufar.by/ad/ok' },
            { ad_id: 'wrong', subject: 'Apple iPhone 16 Pro', description: '256 GB', company_ad: false, price_byn: 150000, ad_link: 'https://www.kufar.by/ad/wrong' },
          ] },
        };
      }),
    } as any;
    const identity = JSON.stringify({
      v: 2,
      source: 'kufar',
      categoryId: 'phones',
      subcategoryId: '17010',
      brand: 'apple',
      model: 'iPhone 17 | Pro',
      phoneFilters: {},
      region: '',
      city: 'minsk',
      query: '',
      minPrice: 1000,
      maxPrice: 2000,
      condition: 'new',
      seller: 'private',
      mode: 'sniper',
    });
    const parser = new FastKufarParser(axiosMock);
    const ads = await parser.parseUrl(
      'https://www.kufar.by/l/mobilnye-telefony/mt~apple-iphone-17-pro?wb=' + encodeURIComponent(identity),
    );
    expect(ads.map(ad => ad.external_id)).toEqual(['ok']);
  });

  test('applies city, price, condition and seller filters together', async () => {
    const axiosMock = {
      get: jest.fn(async () => ({
        data: nextData([
          {
            ad_id: 'ok',
            subject: 'iPhone 15',
            ad_parameters: [
              { p: 'area', vl: 'Минск, Центральный район' },
              { p: 'condition', vl: 'Новое' },
            ],
            company_ad: true,
            price_byn: 150000,
            ad_link: 'https://www.kufar.by/ad/ok',
          },
          {
            ad_id: 'wrong-city',
            subject: 'iPhone 15',
            ad_parameters: [{ p: 'area', vl: 'Брест' }, { p: 'condition', vl: 'Новое' }],
            company_ad: true,
            price_byn: 150000,
            ad_link: 'https://www.kufar.by/ad/wrong-city',
          },
          {
            ad_id: 'wrong-price',
            subject: 'iPhone 15',
            ad_parameters: [{ p: 'area', vl: 'Минск' }, { p: 'condition', vl: 'Новое' }],
            company_ad: true,
            price_byn: 300000,
            ad_link: 'https://www.kufar.by/ad/wrong-price',
          },
        ]),
      })),
    } as any;

    const parser = new FastKufarParser(axiosMock);
    const ads = await parser.parseUrl(
      'https://www.kufar.by/l/r~minsk/elektronika?query=iPhone&wb=kufar%7Celectronics%7C%7C%7C%7C%7C%7Cminsk%7CiPhone%7C1000%7C2000%7Cnew%7Ccompany%7Cnormal',
    );

    expect(ads.map(ad => ad.external_id)).toEqual(['ok']);
  });
  test('uses the configured managed Kufar source when direct Kufar endpoints are denied', async () => {
    const previousKey = process.env.KUFAR_REEF_API_KEY;
    process.env.KUFAR_REEF_API_KEY = 'test-key';
    try {
      const calls: Array<{ url: string; config: any }> = [];
      const axiosMock = {
        get: jest.fn(async (url: string) => {
          calls.push({ url, config: null });
          const error: any = new Error('Request failed with status code 403');
          error.response = { status: 403 };
          throw error;
        }),
        post: jest.fn(async (url: string, body: any, config: any) => {
          calls.push({ url, config: { body, ...config } });
          return {
            data: { ok: true, data: { listings: [{
              listing_id: 'reef-1',
              title: 'iPhone 15 Pro',
              price: 1500,
              price_currency: 'BYN',
              posted_at: '2026-10-05T12:00:00Z',
              url: 'https://www.kufar.by/item/reef-1',
              region_name: 'Минск',
              area_name: 'Центральный',
              seller_type: 'private',
              image: 'https://example.com/image.jpg',
            }] } },
          };
        }),
      } as any;
      const parser = new FastKufarParser(axiosMock);
      const ads = await parser.parseUrl(
        'https://www.kufar.by/l/telefony-i-planshety/wb?wb=kufar%7C17010%7C17050%7C%7C%7C%7C%7Cminsk%7C%7C0%7C2000%7Cnew%7Cprivate%7Cnormal',
      );
      expect(axiosMock.post).toHaveBeenCalledTimes(1);
      expect(calls.some(call => call.url.includes('reefapi.com/kufar/v1/search'))).toBe(true);
      expect(ads).toHaveLength(1);
      expect(ads[0].external_id).toBe('reef-1');
      expect(ads[0].first_seen_source).toBe('reefapi');
    } finally {
      if (previousKey === undefined) delete process.env.KUFAR_REEF_API_KEY;
      else process.env.KUFAR_REEF_API_KEY = previousKey;
    }
  });

});
