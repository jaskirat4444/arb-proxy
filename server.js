// arb-proxy v3
const express=require("express"),cors=require("cors"),fetch=require("node-fetch"),app=express();
app.use(cors());

const KALSHI_BASE="https://api.elections.kalshi.com";
const POLY_BASE="https://gamma-api.polymarket.com";

function getYes(m){try{const p=JSON.parse(m.outcomePrices);return parseFloat(p[0]);}catch{return 0.5;}}

function kalshiUrl(eventTicker){
      if(!eventTicker)return"https://kalshi.com";
      const series=eventTicker.split("-")[0].toLowerCase();
      return`https://kalshi.com/markets/${series}`;
}

function polyUrl(m){
      const slug=m.events?.[0]?.slug||m.slug;
      return`https://polymarket.com/event/${slug}`;
}

function isParlay(ticker){
      return/KXMVE|CROSSCATEGORY|MULTIGAME/i.test(ticker||"");
}

const STOP=new Set(["the","a","an","and","or","of","in","on","for","to","by","at","with","be","is","are","will","does","do","yes","no","over","under","than","more","less","this","that","new","next","first","last","when","who","what","which","how","vs","game","match","group","division","round","season","odds","price","reach","hit"]);
function tokens(s){
      return new Set((s||"").toLowerCase().replace(/[^a-z0-9$ ]/g," ").split(/\s+/).filter(w=>w.length>=3&&!STOP.has(w)));
}
function jaccard(a,b){
      let inter=0;
      for(const w of a)if(b.has(w))inter++;
      const uni=a.size+b.size-inter;
      return uni===0?0:inter/uni;
}

async function fetchKalshiEvents(target=500){
      const out=[];
      let cursor=null,pages=0;
      while(out.length<target&&pages<30){
              const url=`${KALSHI_BASE}/trade-api/v2/events?status=open&limit=200&with_nested_markets=true${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`;
              const r=await fetch(url);
              if(!r.ok)break;
              const j=await r.json();
              const events=j.events||[];
              if(!events.length)break;
              for(const ev of events){
                        if(isParlay(ev.event_ticker))continue;
                        for(const m of(ev.markets||[])){
                                    if(m.status!=="active")continue;
                                    if(isParlay(m.ticker))continue;
                                    const yes=(m.yes_bid!=null&&m.yes_ask!=null)?((m.yes_bid+m.yes_ask)/2)/100:(m.last_price??50)/100;
                                    if(yes<=0.02||yes>=0.98)continue;
                                    const subtitle=m.yes_sub_title||"";
                                    const fullTitle=subtitle?`${ev.title} — ${subtitle}`:m.title||ev.title;
                                    out.push({
                                                  title:fullTitle,
                                                  yes,
                                                  url:kalshiUrl(ev.event_ticker),
                                                  ticker:m.ticker,
                                                  tok:tokens(fullTitle)
                                    });
                                    if(out.length>=target)break;
                        }
                        if(out.length>=target)break;
              }
              cursor=j.cursor;
              pages++;
              if(!cursor)break;
      }
      return out.slice(0,target);
}

async function fetchPolyMarkets(target=500){
      const out=[];
      let offset=0,pages=0;
      while(out.length<target&&pages<20){
              const url=`${POLY_BASE}/markets?active=true&closed=false&archived=false&limit=200&offset=${offset}&order=volume24hr&ascending=false`;
              const r=await fetch(url);
              if(!r.ok)break;
              const arr=await r.json();
              if(!arr.length)break;
              for(const m of arr){
                        const yes=getYes(m);
                        if(yes<=0.02||yes>=0.98)continue;
                        if(!m.question)continue;
                        out.push({
                                    title:m.question,
                                    yes,
                                    url:polyUrl(m),
                                    slug:m.slug,
                                    tok:tokens(m.question)
                        });
                        if(out.length>=target)break;
              }
              offset+=arr.length;
              pages++;
      }
      return out.slice(0,target);
}

app.get("/debug",async(req,res)=>{
      try{
              const[poly,kalshi]=await Promise.all([fetchPolyMarkets(50),fetchKalshiEvents(50)]);
              res.json({polyCount:poly.length,kalshiCount:kalshi.length,polySample:poly.slice(0,5).map(p=>({title:p.title,url:p.url,yes:p.yes})),kalshiSample:kalshi.slice(0,5).map(k=>({title:k.title,url:k.url,yes:k.yes}))});
      }catch(e){res.json({error:e.message});}
});

app.get("/markets",async(req,res)=>{
      try{
              const AKEY=process.env.ANTHROPIC_KEY;
              if(!AKEY)return res.status(500).json({error:"ANTHROPIC_KEY not set"});
              const[poly,kalshi]=await Promise.all([fetchPolyMarkets(500),fetchKalshiEvents(500)]);
              if(!poly.length||!kalshi.length)return res.json({results:[],source:"unavailable",polyCount:poly.length,kalshiCount:kalshi.length});

        const candidates=[];
              for(let pi=0;pi<poly.length;pi++){
                        const p=poly[pi];
                        if(p.tok.size<2)continue;
                        const scored=[];
                        for(let ki=0;ki<kalshi.length;ki++){
                                    const k=kalshi[ki];
                                    if(k.tok.size<2)continue;
                                    const j=jaccard(p.tok,k.tok);
                                    if(j>=0.18)scored.push({ki,j});
                        }
                        scored.sort((a,b)=>b.j-a.j);
                        for(const s of scored.slice(0,5)){
                                    candidates.push({pi,ki:s.ki,j:s.j});
                        }
              }

        if(!candidates.length)return res.json({results:[],source:"live",polyCount:poly.length,kalshiCount:kalshi.length,matchCount:0,candidateCount:0});

        const chunkSize=20;
              const chunks=[];
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
                                            const c=chunk[m.i];
                                            if(!c)continue;
                                            verified.push({pi:c.pi,ki:c.ki,note:m.why||""});
                              }
                  }catch(e){}
        }

        const concurrency=10;
              for(let i=0;i<chunks.length;i+=concurrency){
                        await Promise.all(chunks.slice(i,i+concurrency).map(runChunk));
              }

        const seen=new Set();
              const results=verified.map(({pi,ki,note})=>{
                        const key=pi+":"+ki;
                        if(seen.has(key))return null;
                        seen.add(key);
                        const pm=poly[pi],km=kalshi[ki];
                        if(!pm||!km)return null;
                        const spread=Math.abs(pm.yes-km.yes);
                        const yesCost=Math.min(pm.yes,km.yes);
                        const noCost=1-Math.max(pm.yes,km.yes);
                        const totalCost=yesCost+noCost;
                        return{
                                    polyTitle:pm.title,
                                    kalshiTitle:km.title,
                                    polyYes:pm.yes,
                                    kalshiYes:km.yes,
                                    polyUrl:pm.url,
                                    kalshiUrl:km.url,
                                    note,
                                    spread,
                                    buyYesOn:pm.yes<=km.yes?"Polymarket":"Kalshi",
                                    buyNoOn:pm.yes<=km.yes?"Kalshi":"Polymarket",
                                    yesCost,noCost,totalCost,
                                    profitPct:((1-totalCost)/totalCost)*100,
                                    isArb:(1-totalCost)>0
                        };
              }).filter(Boolean).sort((a,b)=>b.spread-a.spread);

        res.json({results,source:"live",polyCount:poly.length,kalshiCount:kalshi.length,candidateCount:candidates.length,matchCount:results.length});
      }catch(e){
              res.status(500).json({error:e.message});
      }
});

app.get("/",(req,res)=>res.json({ok:true,endpoints:["/markets","/debug"]}));

app.listen(process.env.PORT||3001,"0.0.0.0",()=>console.log("ready"));
