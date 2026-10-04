import { Ad } from '../types';
import { parseMarketPrice } from './MarketEngine';

export interface DealAnalysis {
  score:number|null; buyPrice:number|null; marketPrice:number|null; sellPrice:number|null; profit:number|null; roi:number|null; currency:string|null; reasons:string[]; confidence:string|null;
}
export function analyzeDeal(ad:Ad):DealAnalysis{
 const current=parseMarketPrice(ad.price);const market=Number.isFinite(ad.market_median)?Number(ad.market_median):null;
 if(!current||market==null||!Number.isFinite(Number(ad.market_percent)))return{score:null,buyPrice:current?.amount??null,marketPrice:market,sellPrice:null,profit:null,roi:null,currency:current?.currency??null,reasons:[],confidence:ad.market_confidence??null};
 let score=40;const reasons:string[]=[];const pct=Number(ad.market_percent);const discount=-pct;
 if(discount>=35){score+=32;reasons.push('сильно ниже рынка')}else if(discount>=25){score+=25;reasons.push('существенно ниже рынка')}else if(discount>=15){score+=18;reasons.push('ниже рынка')}else if(pct>0){score-=25;reasons.push('выше рынка')}else reasons.push('цена около рынка');
 const marketQuality=Number(ad.market_quality??0);if(marketQuality>=70){score+=8;reasons.push('много похожих объявлений')}else if(marketQuality>=45)score+=4;
 if(ad.is_company===false){score+=4;reasons.push('частный продавец')}if(ad.condition==='new')score+=4;else if(ad.condition==='used')score+=2;
 if(ad.published_at){const t=ad.published_at instanceof Date?ad.published_at.getTime():Date.parse(String(ad.published_at));if(Number.isFinite(t)){const age=Math.max(0,(Date.now()-t)/60000);if(age<=5){score+=8;reasons.push('только что опубликовано')}else if(age<=30)score+=5;else if(age<=120)score+=2;}}
 const sell=Number.isFinite(ad.sell_normal)?Number(ad.sell_normal):Number((market*.97).toFixed(2));const profit=Number((sell-current.amount).toFixed(2));const roi=current.amount>0?Number(((profit/current.amount)*100).toFixed(1)):null;
 if(profit>0)score+=Math.min(8,Math.max(0,Math.round((roi??0)/5)));else score-=8;
 const finalScore=Math.max(0,Math.min(100,Math.round(score)));
 return{score:finalScore,buyPrice:current.amount,marketPrice:market,sellPrice:sell,profit,roi,currency:current.currency,reasons:reasons.slice(0,4),confidence:ad.market_confidence??null};
}
