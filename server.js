// arb-proxy v6 — real orderbook avg-fill prices for $stake; liquidity warning flag
const express=require("express"),cors=require("cors"),fetch=require("node-fetch"),app=express();
app.use(cors());

const KALSHI_BASE="https://api.elections.kalshi.com";
const POLY_BASE="https://gamma-api.polymarket.com";
const POLY_CLOB="https://clob.polymarket.com";
const DEFAULT_STAKE=100;
const MAX_DISPLAYED_SPREAD=0.50;
const LOW_LIQ_THRESHOLD=50; // if a leg can't fill at least $50, flag low-liquidity

let lastResponse=null,lastResponseAt=0,refreshing=false;
const STALE_AFTER_MS=60_000;

function getYes(m){try{const p=JSON.parse(m.outcomePrices);return parseFloat(p[0]);}catch{return 0.5;}}
function getClobIds(m){try{return JSON.parse(m.clobTokenIds||"[]");}catch{return[];}}

function kalshiUrl(eventTicker){
          if(!eventTicker)return"https://kalshi.com";
          const series=eventTicker.split("-")[0].toLowerCase();
          return`https://kalshi.com/markets/${series}`;
}
function polyUrl(m){const slug=m.events?.[0]?.slug||m.slug;return`https://polymarket.com/event/${slug}`;}
function isParlay(t){return/KXMVE|CROSSCATEGORY|MULTIGAME/i.test(t||"");}

const STOP=new Set(["the","a","an","and","or","of","in","on","for","to","by","at","with","be","is","are","will","does","do","yes","no","over","under","than","more","less","this","that","new","next","first","last","when","who","what","which","how","vs","game","match","group","division","round","season","odds","price","reach","hit"]);
function tokens(s){return new Set((s||"").toLowerCase().replace(/[^a-z0-9$ ]/g," ").split(/\s+/).filter(w=>w.length>=3&&!STOP.has(w)));}
function jaccard(a,b){let inter=0;for(const w of a)if(b.has(w))inter++;const uni=a.size+b.size-inter;return uni===0?0:inter/uni;}

function walkAsks(asks,stakeUSD){
          if(!asks||!asks.length)return null;
          let spent=0,contracts=0;
          for(const lvl of asks){
                      if(!(lvl.price>0&&lvl.price<1)||!(lvl.size>0))continue;
                      const v=lvl.price*lvl.size;
                      if(spent+v>=stakeUSD){const need=stakeUSD-spent;contracts+=need/lvl.price;spent=stakeUSD;return{filled:true,spent,contracts,avgPrice:spent/contracts};}
                      spent+=v;contracts+=lvl.size;
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
                      res.json({polyCount:poly.length,kalshiCount:kalshi.length});
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
              const prompt=`You verify candidate matches between Polymarket and Kalshi prediction markets. For each candidate, decide if BOTH markets resolve YES on the SAME real-world outcome (same teams/people, same event, same date window, same threshold).\n\nAllow matches with slightly different wording if the resolution criteria are clearly identical. Reject if dates, thresholds, or teams differ.\n\nCANDIDATES:\n${lines}\n\nReply with ONLY valid JSON, no prose:\n{"matches":[{"i":<candidate index>,"why":"brief reason"}]}\nInclude only verified matches. If none, return {"matches":[]}.`;
              try{
                            const ai=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":AKEY,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:1500,messages:[{role:"user",content:prompt}]})});
                            if(!ai.ok)return;
                            const aj=await ai.json();
                            const raw=(aj.content?.[0]?.text||'{"matches":[]}').replace(/```json|```/g,"").trim();
                            const start=raw.indexOf("{"),end=raw.lastIndexOf("}");
                            if(start<0||end<0)return;
                            const parsed=JSON.parse(raw.slice(start,end+1));
                            for(const m of(parsed.matches||[])){const c=chunk[m.i];if(!c)continue;verified.push({pi:c.pi,ki:c.ki,note:m.why||""});}
              }catch(e){}
  }

  const concurrency=10;
          for(let i=0;i<chunks.length;i+=concurrency){await Promise.all(chunks.slice(i,i+concurrency).map(runChunk));}

  const seen=new Set();
          const dedup=verified.filter(({pi,ki})=>{const k=pi+":"+ki;if(seen.has(k))return false;seen.add(k);return true;});

  // For each verified pair: compute displayed-price arb. If it's an arb (totalCost<1), include it.
  // Also fetch order books in parallel and compute lowLiquidity flag.
  const enriched=await Promise.all(dedup.map(async({pi,ki,note})=>{
              const pm=poly[pi],km=kalshi[ki];if(!pm||!km)return null;
              let yesCost=Math.min(pm.yes,km.yes);
              let noCost=1-Math.max(pm.yes,km.yes);
              let totalCost=yesCost+noCost;
              if(totalCost>=1.5)return null; // far from arb on display prices — skip
                                                 const buyYesOn=pm.yes<=km.yes?"Polymarket":"Kalshi";
              const buyNoOn=pm.yes<=km.yes?"Kalshi":"Polymarket";
              let spread=Math.abs(pm.yes-km.yes);
              let profitPct=((1-totalCost)/totalCost)*100;

                                                 // Liquidity check (does NOT gate). Determines lowLiquidity flag.
                                                 let lowLiquidity=false,liqDetail=null;
              try{
                            const polyTokenForYes=buyYesOn==="Polymarket"?pm.yesTokenId:null;
                            const polyTokenForNo=buyNoOn==="Polymarket"?pm.noTokenId:null;
                            const[pBookYes,pBookNo,kBook]=await Promise.all([polyBook(polyTokenForYes),polyBook(polyTokenForNo),kalshiBook(km.ticker)]);
                            const yesAsks=buyYesOn==="Polymarket"?(pBookYes?.asks||null):(kBook?.yesAsks||null);
                            const noAsks=buyNoOn==="Polymarket"?(pBookNo?.asks||null):(kBook?.noAsks||null);
                            const yesFill=yesAsks?walkAsks(yesAsks,stake):null;
                            const noFill=noAsks?walkAsks(noAsks,stake):null;
                            const yesOK=yesFill&&yesFill.spent>=LOW_LIQ_THRESHOLD;
                            const noOK=noFill&&noFill.spent>=LOW_LIQ_THRESHOLD;
                            lowLiquidity=!(yesOK&&noOK);if(yesFill&&yesFill.avgPrice!=null&&noFill&&noFill.avgPrice!=null){yesCost=yesFill.avgPrice;noCost=noFill.avgPrice;totalCost=yesCost+noCost;spread=Math.max(0,1-totalCost);profitPct=totalCost>0?(spread/totalCost)*100:0;const bestYes=yesAsks&&yesAsks[0]?yesAsks[0].price:yesCost;const bestNo=noAsks&&noAsks[0]?noAsks[0].price:noCost;const yesSlip=yesCost-bestYes;const noSlip=noCost-bestNo;if(yesSlip>0.05||noSlip>0.05)lowLiquidity=true;}
                            liqDetail={yesSpent:yesFill?.spent??0,noSpent:noFill?.spent??0,yesAvg:yesFill?.avgPrice??null,noAvg:noFill?.avgPrice??null};
              }catch{lowLiquidity=true;}

                                                 // v6.1: override display prices with real avg-fill prices when orderbook fills are available
                                                 if(liqDetail && liqDetail.yesSpent>=stake*0.5 && liqDetail.noSpent>=stake*0.5){
                                                   yesCost = liqDetail.yesAvg;
                                                   noCost  = liqDetail.noAvg;
                                                   totalCost = yesCost + noCost;
                                                   spread = 1 - totalCost;
                                                   profitPct = totalCost > 0 ? (spread / totalCost) * 100 : 0;
                                                 }
                                                 return{
                                                               polyTitle:pm.title,kalshiTitle:km.title,
                                                               polyYes:pm.yes,kalshiYes:km.yes,
                                                               polyUrl:pm.url,kalshiUrl:km.url,
                                                               note,
                                                               spread,yesCost,noCost,totalCost,profitPct,
                                                               buyYesOn,buyNoOn,
                                                               isArb:true,
                                                               lowLiquidity,liqDetail,
                                                               stake,
                                                 };
  }));

  const results=enriched.filter(o=>o&&o.spread>0&&o.totalCost<1).sort((a,b)=>b.spread-a.spread);
          return{results,source:"live",polyCount:poly.length,kalshiCount:kalshi.length,candidateCount:candidates.length,matchCount:results.length,stake};
}

async function refreshInBackground(stake){
          if(refreshing)return;
          refreshing=true;
          try{const fresh=await computeMarkets(stake);if(!fresh.error){lastResponse=fresh;lastResponseAt=Date.now();}}catch{}finally{refreshing=false;}
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

app.get("/",(req,res)=>res.json({ok:true,version:"v5",endpoints:["/markets","/markets?stake=100","/debug"]}));
app.listen(process.env.PORT||3001,"0.0.0.0",()=>console.log("ready"));
