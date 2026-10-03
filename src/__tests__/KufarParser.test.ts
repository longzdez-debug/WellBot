import { KufarParser } from '../parsers/KufarParser';

describe('KufarParser URL/filter handling', () => {
  test('passes q~ query plus ar and sort to Kufar API', async () => {
    const calls: any[] = [];
    const axiosMock = {
      get: jest.fn(async (_url: string, config: any) => {
        calls.push(config);
        return {
          data: {
            ads: [],
            pagination: { pages: [] },
          },
        };
      }),
    } as any;

    const parser = new KufarParser(axiosMock);
    await parser.parseUrl(
      'https://kufar.by/l/r~mogilevskaya-obl/q~apple?ar=v.or%3A13&sort=lst.d'
    );

    expect(calls[0].params).toMatchObject({
      rgn: '4',
      query: 'apple',
      ar: 'v.or:13',
      sort: 'lst.d',
      size: 100,
    });
  });

  test('follows cursor pagination instead of page=2/page=3', async () => {
    const calls: any[] = [];
    const axiosMock = {
      get: jest.fn(async (_url: string, config: any) => {
        calls.push(config);
        if (!config?.params?.cursor) {
          return {
            data: {
              ads: [{ ad_id: '1', subject: 'Apple iPhone' }],
              pagination: { pages: [{ label: 'next', token: 'cursor-2' }] },
            },
          };
        }
        return {
          data: {
            ads: [{ ad_id: '2', subject: 'Apple iPhone' }],
            pagination: { pages: [] },
          },
        };
      }),
    } as any;

    const parser = new KufarParser(axiosMock);
    const ads = await parser.parseUrl(
      'https://kufar.by/l/r~mogilevskaya-obl/q~apple?sort=lst.d'
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].params.cursor).toBeUndefined();
    expect(calls[1].params.cursor).toBe('cursor-2');
    expect(ads.map(ad => ad.external_id)).toEqual(['1', '2']);
  });



  test('filters by the actual city and does not match district/region names', async () => {
    const calls: any[] = [];
    const axiosMock = {
      get: jest.fn(async (_url: string, config: any) => {
        calls.push(config);
        if (config?.params?.size === 10) {
          return { data: { ads: [] } };
        }

        return {
          data: {
            ads: [
              {
                ad_id: 'minsk-1',
                subject: 'Real Minsk listing',
                ad_parameters: [
                  { p: 'area', vl: 'Минск' },
                  { p: 'region', vl: 'Минская область' },
                ],
                ad_location: 'Минск',
              },
              {
                ad_id: 'minsk-district-1',
                subject: 'District listing',
                ad_parameters: [
                  { p: 'area', vl: 'Первомайский район' },
                  { p: 'region', vl: 'Минская область' },
                ],
                ad_location: 'Первомайский район',
              },
              {
                ad_id: 'minsk-region-1',
                subject: 'Regional listing',
                ad_parameters: [
                  { p: 'area', vl: 'Минская область' },
                  { p: 'region', vl: 'Минская область' },
                ],
                ad_location: 'Минская область',
              },
              {
                ad_id: 'brest-district-1',
                subject: 'Brest district listing',
                ad_parameters: [
                  { p: 'area', vl: 'Брестский район' },
                  { p: 'region', vl: 'Брестская область' },
                ],
                ad_location: 'Брестский район',
              },
            ],
            pagination: { pages: [] },
          },
        };
      }),
    } as any;

    const parser = new KufarParser(axiosMock);
    const ads = await parser.parseUrl(
      'https://kufar.by/l/r~minsk/mobilnye-telefony?query=iphone'
    );

    expect(ads.map(ad => ad.external_id)).toEqual(['minsk-1']);
  });

  test('accepts city when Kufar returns city followed by district', async () => {
    const axiosMock = {
      get: jest.fn(async (_url: string, config: any) => {
        if (config?.params?.size === 10) {
          return { data: { ads: [] } };
        }

        return {
          data: {
            ads: [{
              ad_id: 'minsk-2',
              subject: 'Minsk listing',
              ad_parameters: [{ p: 'area', vl: 'Минск, Центральный район' }],
              ad_location: 'Минск, Центральный район',
            }],
            pagination: { pages: [] },
          },
        };
      }),
    } as any;

    const parser = new KufarParser(axiosMock);
    const ads = await parser.parseUrl('https://kufar.by/l/r~minsk/mobilnye-telefony');

    expect(ads.map(ad => ad.external_id)).toEqual(['minsk-2']);
  });

  test('preserves query-string filters instead of dropping them', async () => {
    const calls: any[] = [];
    const axiosMock = {
      get: jest.fn(async (_url: string, config: any) => {
        calls.push(config);
        return {
          data: { ads: [], pagination: { pages: [] } },
        };
      }),
    } as any;

    const parser = new KufarParser(axiosMock);
    await parser.parseUrl(
      'https://kufar.by/l/r~minsk/mobilnye-telefony?query=iphone&prc=0%2C500&ar=v.or%3A13&sort=prc.a'
    );

    expect(calls[0].params).toMatchObject({
      rgn: '7',
      cat: '17010',
      query: 'iphone',
      prc: '0,500',
      ar: 'v.or:13',
      sort: 'prc.a',
    });
  });
});
