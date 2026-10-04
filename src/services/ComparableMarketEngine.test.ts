import { getComparableMarketSignal } from './ComparableMarketEngine';
import { Ad } from '../types';

const ad=(id:string,title:string,price:string,location='Минск'):Ad=>({external_id:id,title,price,location,ad_url:'https://example.com/'+id});

describe('ComparableMarketEngine',()=>{
  test('prefers similar titles over unrelated expensive listings',()=>{
    const current=ad('x','iPhone 15 Pro 256GB','700 BYN');
    const history=[
      ...Array.from({length:10},(_,i)=>ad(String(i),'iPhone 15 Pro 256GB',String(980+i*5)+' BYN')),
      ...Array.from({length:10},(_,i)=>ad('u'+i,'Холодильник Samsung',String(3000+i*20)+' BYN')),
    ];
    const signal=getComparableMarketSignal(current,history);
    expect(signal.comparable_count).toBeGreaterThanOrEqual(10);
    expect(signal.market_median).toBeGreaterThan(900);
    expect(signal.market_percent).toBeLessThan(-20);
  });
  test('refuses valuation when there are not enough comparable samples',()=>{
    const current=ad('x','PlayStation 5 Slim','900 BYN');
    const history=Array.from({length:9},(_,i)=>ad(String(i),i<2?'PlayStation 5 Slim':'Телевизор LG',String(1000+i*10)+' BYN'));
    const signal=getComparableMarketSignal(current,history);
    expect(signal.market_median).toBeNull();
    expect(signal.market_status).toBeNull();
    expect(signal.sample_size).toBe(0);
    expect(signal.comparable_count).toBe(2);
  });
});
