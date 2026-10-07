import { AvParser } from '../parsers/AvParser';

describe('AvParser',()=>{
  test('ignores listings without a stable id',async()=>{
    const axiosMock={
      get:jest.fn().mockResolvedValue({
        data:{props:{initialState:{ads:[
          {title:'Broken without id'},
          {id:'1',properties:[],price:{byn:{amount:100,currency:'BYN'}},publicUrl:'/sale/1'},
        ]}}},
      }),
    } as any;
    const parser=new AvParser(axiosMock);
    const ads=await parser.parseUrl('https://cars.av.by/search/');
    expect(ads).toHaveLength(1);
    expect(ads[0].external_id).toBe('av_1');
  });
});
