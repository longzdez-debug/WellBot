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
      'https://www.kufar.by/l/r~minsk/elektronika?query=iPhone&wb=kufar%7Celectronics%7C%7Cminsk%7C%7CiPhone%7C1000%7C2000%7Cnew%7Ccompany%7Cnormal',
    );

    expect(ads.map(ad => ad.external_id)).toEqual(['ok']);
  });
});
