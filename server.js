const express=require("express"),cors=require("cors"),fetch=require("node-fetch"),crypto=require("crypto"),app=express();
app.use(cors());

const KEY_ID="e4665d1d-c259-48ca-a2a2-179eafe54542";
const PRIVATE_KEY=process.env.KALSHI_PRIVATE_KEY;
const BASE="https://demo-api.kalshi.co";

function kalshiHeaders(method,path){
  const ts=Date.now().toString();
  const msg=ts+method+path.split("?")[0];
  const sig=crypto.createSign("RSA-SHA256");
  sig.update(msg);
  const signature=sig.sign({key:PRIVATE_KEY,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST},"base64");
  return{"KALSHI-ACCESS-KEY":KEY_ID,"KALSHI-ACCESS-TIMESTAMP":ts,"KALSHI-ACCESS-SIGNATURE":signature,"Content-Type":"application/json"};
}

fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5&order=volume&ascending=false"),
  try{
    const path="/trade-api/v2/markets?status=open&limit=5";
    const[p,k]=await Promise.allSettled([
      fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5&order=volume&ascending=false"),
      fetch(BASE+path,{headers:kalshiHeaders("GET",path)})
    ]);
    const pd=p.status==="fulfilled"&&p.value.ok?await p.value.json():null;
    const kd=k.status==="fulfilled"&&k.value.ok?await k.value.json():null;
    res.json({polyOk:p.value?.ok,kalshiOk:k.value?.ok,kalshiStatus:k.value?.status,polyCount:pd?.length,kalshiCount:kd?.markets?.length,kalshiSample:kd?.markets?.slice(0,3)?.map(m=>m.title),polySample:pd?.slice(0,3)?.map(m=>m.question)});
  }catch(e){res.json({error:e.message});}
});

app.get("/markets",async(req,res)=>{
  try{
    const AKEY=process.env.ANTHROPIC_KEY;
    const kpath="/trade-api/v2/markets?status=open&limit=50";
    const[p,k]=await Promise.allSettled([
      fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume&ascending=false"),
      fetch(BASE+kpath,{headers:kalshiHeaders("GET",kpath)})
    ]);
   const poly=p.status==="fulfilled"&&p.value.ok?(await p.value.json()).map(m=>({title:m.question,yes:parseFloat(JSON.parse(m.outcomePrices||"[0.5]")?.[0]??0.5),url:`https://polymarket.com/event/${m.slug}`})).filter(m=>m.yes>0.05&&m.yes<0.95):[];
    const kd=k.status==="fulfilled"&&k.value.ok?await k.value.json():null;
    const kalshi=kd?.markets?kd.markets.map(m=>({title:m.title,yes:(m.last_price??50)/100,url:`https://kalshi.com/markets/${m.ticker}`})).filter(m=>m.yes>0&&m.yes<1):[];
    if(!poly.length||!kalshi.length)return res.json({results:[],source:"unavailable",polyCount:poly.length,kalshiCount:kalshi.length});
    const prompt=`Match prediction markets from two platforms that resolve on the IDENTICAL event. POLYMARKET:${poly.map((m,i)=>`[${i}]${m.title} YES=${Math.round(m.yes*100)}c`).join("|")} KALSHI:${kalshi.map((m,i)=>`[${i}]${m.title} YES=${Math.round(m.yes*100)}c`).join("|")} Reply ONLY with JSON:{"matches":[{"pi":0,"ki":0,"note":"reason"}]}`;
    const ai=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":AKEY,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:1000,messages:[{role:"user",content:prompt}]})});
    const aj=await ai.json();
    const raw=(aj.content?.[0]?.text||'{"matches":[]}').replace(/```json|```/g,"").trim();
    const matches=JSON.parse(raw.slice(raw.indexOf("{"),raw.lastIndexOf("}")+1)).matches||[];
    const results=matches.map(({pi,ki,note})=>{const pm=poly[pi],km=kalshi[ki];if(!pm||!km)return null;const spread=Math.abs(pm.yes-km.yes),yesCost=Math.min(pm.yes,km.yes),noCost=1-Math.max(pm.yes,km.yes),totalCost=yesCost+noCost;return{polyTitle:pm.title,kalshiTitle:km.title,polyYes:pm.yes,kalshiYes:km.yes,polyUrl:pm.url,kalshiUrl:km.url,note,spread,buyYesOn:pm.yes<=km.yes?"Polymarket":"Kalshi",buyNoOn:pm.yes<=km.yes?"Kalshi":"Polymarket",yesCost,noCost,totalCost,profitPct:((1-totalCost)/totalCost)*100,isArb:(1-totalCost)>0};}).filter(Boolean).sort((a,b)=>b.spread-a.spread);
    res.json({results,source:"live"});
  }catch(e){res.status(500).json({error:e.message});}
});

app.listen(process.env.PORT||3001,"0.0.0.0",()=>console.log("ready"));
