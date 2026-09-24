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
        if (calls.length === 1) {
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
    expect(ads.map(ad => ad.external_id)).toEqual(['2', '1']);
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
