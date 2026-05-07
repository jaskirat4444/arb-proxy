// arb-proxy v4 — real liquidity check via order books
const express=require("express"),cors=require("cors"),fetch=require("node-fetch"),app=express();
app.use(cors());

const KALSHI_BASE="https://api.elections.kalshi.com";
const POLY_BASE="https://gamma-api.polymarket.com";
const POLY_CLOB="https://clob.polymarket.com";
const DEFAULT_STAKE=100;
const MAX_DISPLAYED_SPREAD=0.15; // drop pairs whose displayed mid-spread exceeds this (likely no real liquidity on one side)

// In-memory cache so first request returns last good results immediately
let lastResponse=null;
let lastResponseAt=0;
let refreshing=false;
const STALE_AFTER_MS=60_000;

function getYes(m){try{const p=JSON.parse(m.outcomePrices);return parseFloat(p[0]);}catch{return 0.5;}}
function getClobIds(m){try{return JSON.parse(m.clobTokenIds||"[]");}catch{return[];}}

function kalshiUrl(eventTicker){
        if(!eventTicker)return"https://kalshi.com";
        const series=eventTicker.split("-")[0].toLowerCase();
        return`https://kalshi.com/markets/${series}`;
}
function polyUrl(m){
        const slug=m.events?.[0]?.slug||m.slug;
        return`https://polymarket.com/event/${slug}`;
}
function isParlay(ticker){return/KXMVE|CROSSCATEGORY|MULTIGAME/i.test(ticker||"");}

const STOP=new Set(["the","a","an","and","or","of","in","on","for","to","by","at","with","be","is","are","will","does","do","yes","no","over","under","than","more","less","this","that","new","next","first","last","when","who","what","which","how","vs","game","match","group","division","round","season","odds","price","reach","hit"]);
function tokens(s){return new Set((s||"").toLowerCase().replace(/[^a-z0-9$ ]/g," ").split(/\s+/).filter(w=>w.length>=3&&!STOP.has(w)));}
function jaccard(a,b){let inter=0;for(const w of a)if(b.has(w))inter++;const uni=a.size+b.size-inter;return uni===0?0:inter/uni;}

// Walk asks ascending, spending up to stakeUSD. Returns {filled, spent, contracts, avgPrice}.
function walkAsks(asks,stakeUSD){
        if(!asks||!asks.length)return null;
        let spent=0,contracts=0;
        for(const lvl of asks){
                  if(!(lvl.price>0&&lvl.price<1)||!(lvl.size>0))continue;
                  const lvlValue=lvl.price*lvl.size;
                  if(spent+lvlValue>=stakeUSD){
                              const need=stakeUSD-spent;
                              contracts+=need/lvl.price;
                              spent=stakeUSD;
                              return{filled:true,spent,contracts,avgPrice:spent/contracts};
                  }
                  spent+=lvlValue;contracts+=lvl.size;
        }
        return{filled:false,spent,contracts,avgPrice:contracts>0?spent/contracts:null};
}

async function polyBook(tokenId){
        if(!tokenId)return null;
        try{
                  const r=await fetch(`${POLY_CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
                  if(!r.ok)return null;
                  const j=await r.json();
                  const asks=(j.asks||[]).map(x=>({price:parseFloat(x.price),size:parseFloat(x.size)})).filter(x=>x.price>0&&x.price<1&&x.size>0).sort((a,b)=>a.price-b.price);
                  return{asks};
        }catch{return null;}
}

async function kalshiBook(ticker){
        if(!ticker)return null;
        try{
                  const r=await fetch(`${KALSHI_BASE}/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook?depth=50`);
                  if(!r.ok)return null;
                  const j=await r.json();
                  const ob=j.orderbook_fp||j.orderbook||{};
                  // Kalshi: ob.yes = bids on YES, ob.no = bids on NO. Each entry [priceCents, size].
          // Ask price for YES = 1 - bestNoBid; ask price for NO = 1 - bestYesBid.
          const yesBids=(ob.yes_dollars||[]).map(([p,s])=>({price:parseFloat(p),size:parseFloat(s)})).filter(x=>x.size>0);
                  const noBids=(ob.no_dollars||[]).map(([p,s])=>({price:parseFloat(p),size:parseFloat(s)})).filter(x=>x.size>0);
                  const yesAsks=noBids.map(x=>({price:1-x.price,size:x.size})).filter(x=>x.price>0&&x.price<1).sort((a,b)=>a.price-b.price);
                  const noAsks=yesBids.map(x=>({price:1-x.price,size:x.size})).filter(x=>x.price>0&&x.price<1).sort((a,b)=>a.price-b.price);
                  return{yesAsks,noAsks};
        }catch{return null;}
}

async function fetchKalshiEvents(target=500){
        const out=[];let cursor=null,pages=0;
        while(out.length<target&&pages<30){
                  const url=`${KALSHI_BASE}/trade-api/v2/events?status=open&limit=200&with_nested_markets=true${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`;
                  const r=await fetch(url);if(!r.ok)break;
                  const j=await r.json();const events=j.events||[];if(!events.length)break;
                  for(const ev of events){
                              if(isParlay(ev.event_ticker))continue;
                              for(const m of(ev.markets||[])){
                                            if(m.status!=="active")continue;
                                            if(isParlay(m.ticker))continue;
                                            const hasRealQuote=(m.yes_bid!=null&&m.yes_ask!=null);
                                            const yes=hasRealQuote?((m.yes_bid+m.yes_ask)/2)/100:(m.last_price??50)/100;
                                            if(yes<=0.02||yes>=0.98)continue;
                                            const subtitle=m.yes_sub_title||"";
                                            const fullTitle=subtitle?`${ev.title} — ${subtitle}`:m.title||ev.title;
                                            out.push({title:fullTitle,yes,url:kalshiUrl(ev.event_ticker),ticker:m.ticker,hasRealQuote,tok:tokens(fullTitle)});
                                            if(out.length>=target)break;
                              }
                              if(out.length>=target)break;
                  }
                  cursor=j.cursor;pages++;if(!cursor)break;
        }
        return out.slice(0,target);
}

async function fetchPolyMarkets(target=500){
        const out=[];let offset=0,pages=0;
        while(out.length<target&&pages<20){
                  const url=`${POLY_BASE}/markets?active=true&closed=false&archived=false&limit=200&offset=${offset}&order=volume24hr&ascending=false`;
                  const r=await fetch(url);if(!r.ok)break;
                  const arr=await r.json();if(!arr.length)break;
                  for(const m of arr){
                              const yes=getYes(m);
                              if(yes<=0.02||yes>=0.98)continue;
                              if(!m.question)continue;
                              const ids=getClobIds(m);
                              out.push({title:m.question,yes,url:polyUrl(m),slug:m.slug,yesTokenId:ids[0]||null,noTokenId:ids[1]||null,tok:tokens(m.question)});
                              if(out.length>=target)break;
                  }
                  offset+=arr.length;pages++;
        }
        return out.slice(0,target);
}

app.get("/debug",async(req,res)=>{
        try{
                  const[poly,kalshi]=await Promise.all([fetchPolyMarkets(50),fetchKalshiEvents(50)]);
                  res.json({polyCount:poly.length,kalshiCount:kalshi.length,polySample:poly.slice(0,5).map(p=>({title:p.title,url:p.url,yes:p.yes,hasTokens:!!p.yesTokenId})),kalshiSample:kalshi.slice(0,5).map(k=>({title:k.title,url:k.url,yes:k.yes,ticker:k.ticker,hasRealQuote:k.hasRealQuote}))});
        }catch(e){res.json({error:e.message});}
});

async function computeMarkets(stake){
        const AKEY=process.env.ANTHROPIC_KEY;
        if(!AKEY)return{error:"ANTHROPIC_KEY not set"};
        const[poly,kalshi]=await Promise.all([fetchPolyMarkets(500),fetchKalshiEvents(500)]);
        if(!poly.length||!kalshi.length)return{results:[],source:"unavailable",polyCount:poly.length,kalshiCount:kalshi.length,stake};

  const candidates=[];
        for(let pi=0;pi<poly.length;pi++){
                  const p=poly[pi];if(p.tok.size<2)continue;
                  const scored=[];
                  for(let ki=0;ki<kalshi.length;ki++){
                              const k=kalshi[ki];if(k.tok.size<2)continue;
                              // Pre-filter: skip pairs whose displayed mid-prices differ by more than MAX_DISPLAYED_SPREAD
                    // (those are almost always artifacts of one side having no real quotes).
                    if(Math.abs(p.yes-k.yes)>MAX_DISPLAYED_SPREAD)continue;
                              const j=jaccard(p.tok,k.tok);
                              if(j>=0.18)scored.push({ki,j});
                  }
                  scored.sort((a,b)=>b.j-a.j);
                  for(const s of scored.slice(0,5))candidates.push({pi,ki:s.ki,j:s.j});
        }

  if(!candidates.length)return{results:[],source:"live",polyCount:poly.length,kalshiCount:kalshi.length,matchCount:0,candidateCount:0,stake};

  const chunkSize=20;const chunks=[];
        for(let i=0;i<candidates.length;i+=chunkSize)chunks.push(candidates.slice(i,i+chunkSize));
        const verified=[];

  async function runChunk(chunk){
            const lines=chunk.map((c,i)=>`${i}: PM="${poly[c.pi].title}" [${Math.round(poly[c.pi].yes*100)}c] | KSH="${kalshi[c.ki].title}" [${Math.round(kalshi[c.ki].yes*100)}c]`).join("\n");
            const prompt=`You verify candidate matches between Polymarket and Kalshi prediction markets. For each candidate, decide if BOTH markets resolve YES on the SAME real-world outcome (same teams/people, same event, same date window, same threshold).

            Allow matches with slightly different wording if the resolution criteria are clearly identical (e.g. "Will BTC hit 100k by Dec 31?" matches "Bitcoin above 100,000 on Dec 31"). Reject if dates, thresholds, or teams differ.

            CANDIDATES:
            ${lines}

            Reply with ONLY valid JSON, no prose:
            {"matches":[{"i":<candidate index>,"why":"brief reason"}]}
            Include only verified matches. If none, return {"matches":[]}.`;
            try{
                        const ai=await fetch("https://api.anthropic.com/v1/messages",{
                                      method:"POST",
                                      headers:{"Content-Type":"application/json","x-api-key":AKEY,"anthropic-version":"2023-06-01"},
                                      body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:1500,messages:[{role:"user",content:prompt}]})
                        });
                        if(!ai.ok)return;
                        const aj=await ai.json();
                        const raw=(aj.content?.[0]?.text||'{"matches":[]}').replace(/```json|```/g,"").trim();
                        const start=raw.indexOf("{"),end=raw.lastIndexOf("}");
                        if(start<0||end<0)return;
                        const parsed=JSON.parse(raw.slice(start,end+1));
                        for(const m of(parsed.matches||[])){
                                      const c=chunk[m.i];if(!c)continue;
                                      verified.push({pi:c.pi,ki:c.ki,note:m.why||""});
                        }
            }catch(e){}
  }

  const concurrency=10;
        for(let i=0;i<chunks.length;i+=concurrency){
                  await Promise.all(chunks.slice(i,i+concurrency).map(runChunk));
        }

  const seen=new Set();
        const dedup=verified.filter(({pi,ki})=>{const k=pi+":"+ki;if(seen.has(k))return false;seen.add(k);return true;});

  // For each verified pair, fetch both order books and compute real fillable cost for $stake on each leg.
  const enriched=await Promise.all(dedup.map(async({pi,ki,note})=>{
            const pm=poly[pi],km=kalshi[ki];if(!pm||!km)return null;
            const[pYes,pNo,kBook]=await Promise.all([
                        polyBook(pm.yesTokenId),
                        polyBook(pm.noTokenId),
                        kalshiBook(km.ticker),
                      ]);
            const aPoly=pYes?walkAsks(pYes.asks,stake):null;
            const aKal=kBook?walkAsks(kBook.noAsks,stake):null;
            const bPoly=pNo?walkAsks(pNo.asks,stake):null;
            const bKal=kBook?walkAsks(kBook.yesAsks,stake):null;

                                                 function score(legPoly,legKal,polySide){
                                                             if(!legPoly||!legKal||!legPoly.filled||!legKal.filled)return null;
                                                             const totalCost=legPoly.spent+legKal.spent;
                                                             const guaranteedPayout=Math.min(legPoly.contracts,legKal.contracts);
                                                             const profit=guaranteedPayout-totalCost;
                                                             return{polySide,totalCost,guaranteedPayout,profit,profitPct:(profit/totalCost)*100,polyAvgPrice:legPoly.avgPrice,kalshiAvgPrice:legKal.avgPrice,polyContracts:legPoly.contracts,kalshiContracts:legKal.contracts,polySpent:legPoly.spent,kalshiSpent:legKal.spent};
                                                 }
            const sA=score(aPoly,aKal,"YES");
            const sB=score(bPoly,bKal,"NO");
            let best=null;
            if(sA&&(!sB||sA.profit>=sB.profit))best=sA;
            else if(sB)best=sB;
            if(!best)return null;

                                                 const buyYesOn=best.polySide==="YES"?"Polymarket":"Kalshi";
            const buyNoOn=best.polySide==="YES"?"Kalshi":"Polymarket";
            const yesPrice=best.polySide==="YES"?best.polyAvgPrice:best.kalshiAvgPrice;
            const noPrice=best.polySide==="YES"?best.kalshiAvgPrice:best.polyAvgPrice;
            const totalCostPerDollar=best.totalCost/best.guaranteedPayout;

                                                 return{
                                                             polyTitle:pm.title,kalshiTitle:km.title,
                                                             polyYes:pm.yes,kalshiYes:km.yes,
                                                             polyUrl:pm.url,kalshiUrl:km.url,
                                                             note,
                                                             stake,
                                                             realPolyAvgPrice:best.polyAvgPrice,
                                                             realKalshiAvgPrice:best.kalshiAvgPrice,
                                                             polyContracts:best.polyContracts,
                                                             kalshiContracts:best.kalshiContracts,
                                                             polySpent:best.polySpent,
                                                             kalshiSpent:best.kalshiSpent,
                                                             totalSpent:best.totalCost,
                                                             guaranteedPayout:best.guaranteedPayout,
                                                             netProfit:best.profit,
                                                             realProfitPct:best.profitPct,
                                                             polySide:best.polySide,
                                                             // Legacy fields used by current frontend so cards still render during transition:
                                                             spread:Math.abs(yesPrice-(1-noPrice)),
                                                             yesCost:yesPrice,
                                                             noCost:1-noPrice,
                                                             totalCost:totalCostPerDollar,
                                                             profitPct:best.profitPct,
                                                             buyYesOn,buyNoOn,
                                                             isArb:best.profit>0,
                                                 };
  }));

  const results=enriched.filter(Boolean).filter(x=>x.isArb).sort((a,b)=>b.netProfit-a.netProfit);
        return{results,source:"live",polyCount:poly.length,kalshiCount:kalshi.length,candidateCount:candidates.length,matchCount:results.length,stake};
}

async function refreshInBackground(stake){
        if(refreshing)return;
        refreshing=true;
        try{
                  const fresh=await computeMarkets(stake);
                  if(!fresh.error){lastResponse=fresh;lastResponseAt=Date.now();}
        }catch(e){}finally{refreshing=false;}
}

app.get("/markets",async(req,res)=>{
        try{
                  const stake=Math.max(10,Math.min(10000,parseFloat(req.query.stake)||DEFAULT_STAKE));
                  if(lastResponse&&lastResponse.stake===stake){
                              const ageMs=Date.now()-lastResponseAt;
                              if(ageMs>STALE_AFTER_MS)refreshInBackground(stake);
                              return res.json({...lastResponse,cachedAgeMs:ageMs});
                  }
                  const fresh=await computeMarkets(stake);
                  if(fresh.error)return res.status(500).json(fresh);
                  lastResponse=fresh;lastResponseAt=Date.now();
                  res.json({...fresh,cachedAgeMs:0});
        }catch(e){res.status(500).json({error:e.message});}
});

app.get("/",(req,res)=>res.json({ok:true,endpoints:["/markets","/markets?stake=100","/debug"]}));
app.listen(process.env.PORT||3001,"0.0.0.0",()=>console.log("ready"));
