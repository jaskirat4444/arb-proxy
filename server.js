const express=require("express"),cors=require("cors"),fetch=require("node-fetch"),app=express();
app.use(cors());

async function getKalshiToken(){
  const r=await fetch("https://trading-api.kalshi.com/trade-api/v2/login",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({email:process.env.KALSHI_EMAIL,password:process.env.KALSHI_PASSWORD})
  });
  const d=await r.json();
  return d.token;
}

app.get("/debug",async(req,res)=>{
  try{
    const token=await getKalshiToken();
    const[p,k]=await Promise.allSettled([
      fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5&order=volume&ascending=false"),
      fetch("https://trading-api.kalshi.com/trade-api/v2/markets?status=open&limit=5",{headers:{"Authorization":"Bearer "+token}})
    ]);
    const kd=k.status==="fulfilled"&&k.value.ok?await k.value.json():null;
    const pd=p.status==="fulfilled"&&p.value.ok?await p.value.json():null;
    res.json({tokenOk:!!token,polyOk:p.value?.ok,kalshiOk:k.value?.ok,kalshiStatus:k.value?.status,polyCount:pd?.length,kalshiCount:kd?.markets?.length,kalshiSample:kd?.markets?.slice(0,3)?.map(m=>m.title),polySample:pd?.slice(0,3)?.map(m=>m.question)});
  }catch(e){res.json({error:e.message});}
});

app.get("/markets",async(req,res)=>{
  try{
    const KEY=process.env.ANTHROPIC_KEY;
    const token=await getKalshiToken();
    const[p,k]=await Promise.allSettled([
      fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=volume&ascending=false"),
      fetch("https://trading-api.kalshi.com/trade-api/v2/markets?status=open&limit=50",{headers:{"Authorization":"Bearer "+token}})
    ]);
    const poly=p.status==="fulfilled"&&p.value.ok?(await p.value.json()).map(m=>({title:m.question,yes:parseFloat(m.outcomePrices?.[0]??0.5),url:`https://polymarket.com/event/${m.slug}`})).filter(m=>m.yes>0&&m.yes<1):[];
    const kd=k.status==="fulfilled"&&k.value.ok?await k.value.json():null;
    const kalshi=kd?.markets?kd.markets.map(m=>({title:m.title,yes:(m.last_price??50)/100,url:`https://kalshi.com/markets/${m.ticker}`})).filter(m=>m.yes>0&&m.yes<1):[];
    if(!poly.length||!kalshi.length)return res.json({results:[],source:"unavailable",polyCount:poly.length,kalshiCount:kalshi.length});
    const prompt=`Match prediction markets from two platforms that resolve on the IDENTICAL event. POLYMARKET:${poly.map((m,i)=>`[${i}]${m.title} YES=${Math.round(m.yes*100)}c`).join("|")} KALSHI:${kalshi.map((m,i)=>`[${i}]${m.title} YES=${Math.round(m.yes*100)}c`).join("|")} Reply ONLY with JSON:{"matches":[{"pi":0,"ki":0,"note":"reason"}]}`;
    const ai=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":KEY,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:1000,messages:[{role:"user",content:prompt}]})});
    const aj=await ai.json();
    const raw=(aj.content?.[0]?.text||'{"matches":[]}').replace(/```json|```/g,"").trim();
    const matches=JSON.parse(raw.slice(raw.indexOf("{"),raw.lastIndexOf("}")+1)).matches||[];
    const results=matches.map(({pi,ki,note})=>{
      const pm=poly[pi],km=kalshi[ki];
      if(!pm||!km)return null;
      const spread=Math.abs(pm.yes-km.yes),yesCost=Math.min(pm.yes,km.yes),noCost=1-Math.max(pm.yes,km.yes),totalCost=yesCost+noCost;
      return{polyTitle:pm.title,kalshiTitle:km.title,polyYes:pm.yes,kalshiYes:km.yes,polyUrl:pm.url,kalshiUrl:km.url,note,spread,buyYesOn:pm.yes<=km.yes?"Polymarket":"Kalshi",buyNoOn:pm.yes<=km.yes?"Kalshi":"Polymarket",yesCost,noCost,totalCost,profitPct:((1-totalCost)/totalCost)*100,isArb:(1-totalCost)>0};
    }).filter(Boolean).sort((a,b)=>b.spread-a.spread);
    res.json({results,source:"live"});
  }catch(e){res.status(500).json({error:e.message});}
});

app.listen(process.env.PORT||3001,"0.0.0.0",()=>console.log("ready"));
