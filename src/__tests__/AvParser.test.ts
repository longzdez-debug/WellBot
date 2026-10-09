import { AvParser } from '../parsers/AvParser';

describe('AvParser',()=>{
  test('ignores listings without a stable id',async()=>{
    const axiosMock={
      get:jest.fn().mockResolvedValue({
        status:200,
        data:'<script id="__NEXT_DATA__" type="application/json">{"props":{"initialState":{"ads":[{"title":"Broken without id"},{"id":"1","properties":[],"price":{"byn":{"amount":100,"currency":"BYN"}},"publicUrl":"/sale/1"}]}}}</script>'      }),
    } as any;
    const parser=new AvParser(axiosMock);
    const ads=await parser.parseUrl('https://cars.av.by/search/');
    expect(ads).toHaveLength(1);
    expect(ads[0].external_id).toBe('av_1');
  });
});
