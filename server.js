const express=require("express"),cors=require("cors"),fetch=require("node-fetch"),app=express();
app.use(cors());
const KEY=process.env.ANTHROPIC_KEY;
const MP=[{id:"pm1",title:"Will the Fed cut rates at June 2026 FOMC?",yes:0.38,url:"https://polymarket.com"},{id:"pm2",title:"Will Bitcoin exceed $120k before July 2026?",yes:0.29,url:"https://polymarket.com"},{id:"pm3",title:"Will S&P 500 close above 5800 in May 2026?",yes:0.62,url:"https://polymarket.com"},{id:"pm4",title:"Will there be a US recession in 2026?",yes:0.34,url:"https://polymarket.com"},{id:"pm5",title:"Will Elon Musk leave government by end of 2026?",yes:0.57,url:"https://polymarket.com"}];
const MK=[{id:"k1",title:"Fed cuts rates June 2026",yes:0.41,url:"https://kalshi.com"},{id:"k2",title:"Bitcoin above $120k by July 1 2026",yes:0.26,url:"https://kalshi.com"},{id:"k3",title:"S&P 500 above 5800 end of May 2026",yes:0.65,url:"https://kalshi.com"},{id:"k4",title:"US recession in 2026",yes:0.31,url:"https://kalshi.com"},{id:"k5",title:"Elon Musk leaves DOGE in 2026",yes:0.53,url:"https://kalshi.com"}];
app.get("/markets",async(req,res)=>{
try{
const[p,k]=await Promise.allSettled([fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=volume&ascending=false"),fetch("https://trading-api.kalshi.com/trade-api/v2/markets?status=open&limit=50")]);
const poly=p.status==="fulfilled"&&p.value.ok?(await p.value.json()).slice(0,50).map(m=>({id:m.id,title:m.question,yes:parseFloat(m.outcomePrices?.[0]??0.5),url:`https://polymarket.com/event/${m.slug}`})).filter(m=>m.yes>0&&m.yes<1):MP;
const kd=k.status==="fulfilled"&&k.value.ok?await k.value.json():null;
const kalshi=kd?.markets?kd.markets.slice(0,50).map(m=>({id:m.ticker,title:m.title,yes:(m.last_price??50)/100,url:`https://kalshi.com/markets/${m.ticker}`})).filter(m=>m.yes>0&&m.yes<1):MK;
const ai=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":KEY,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:1000,messages:[{role:"user",content:`Match markets on IDENTICAL events. POLYMARKET:${poly.map((m,i)=>`[${i}]${m.title} YES=${Math.round(m.yes*100)}c`).join("|")} KALSHI:${kalshi.map((m,i)=>`[${i}]${m.title} YES=${Math.round(m.yes*100)}c`).join("|")} Reply ONLY with JSON: {"matches":[{"pi":0,"ki":0,"note":"reason"}]}`}]})});
const aj=await ai.json();
const raw=(aj.content?.[0]?.text||'{"matches":[]}').replace(/```json|```/g,"").trim();
const matches=JSON.parse(raw.slice(raw.indexOf("{"),raw.lastIndexOf("}")+1)).matches||[];
const results=matches.map(({pi,ki,note})=>{const pm=poly[pi],km=kalshi[ki];if(!pm||!km)return null;const spread=Math.abs(pm.yes-km.yes),yesCost=Math.min(pm.yes,km.yes),noCost=1-Math.max(pm.yes,km.yes),totalCost=yesCost+noCost;return{polyTitle:pm.title,kalshiTitle:km.title,polyYes:pm.yes,kalshiYes:km.yes,polyUrl:pm.url,kalshiUrl:km.url,note,spread,buyYesOn:pm.yes<=km.yes?"Polymarket":"Kalshi",buyNoOn:pm.yes<=km.yes?"Kalshi":"Polymarket",yesCost,noCost,totalCost,profitPct:((1-totalCost)/totalCost)*100,isArb:(1-totalCost)>0};}).filter(Boolean).sort((a,b)=>b.spread-a.spread);
res.json({results,source:poly===MP?"demo":"live"});
}catch(e){console.error(e);res.status(500).json({error:e.message});}
});
app.get("/debug",async(req,res)=>{
const[p,k]=await Promise.allSettled([fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5&order=volume&ascending=false"),fetch("https://trading-api.kalshi.com/trade-api/v2/markets?status=open&limit=5")]);
const pd=p.status==="fulfilled"&&p.value.ok?await p.value.json():null;
const kd=k.status==="fulfilled"&&k.value.ok?await k.value.json():null;
res.json({polyOk:p.status==="fulfilled"&&p.value.ok,kalshiOk:k.status==="fulfilled"&&k.value.ok,polySample:pd?pd.slice(0,2):null,kalshiSample:kd?.markets?kd.markets.slice(0,2):null});
});
app.listen(process.env.PORT||3001,"0.0.0.0",()=>console.log("ready"));
