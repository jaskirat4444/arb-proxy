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

async function fetchKalshiEvents(target=500){
    const out=[];
    let cursor=null,pages=0;
    while(out.length<target&&pages<20){
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
                                        eventTitle:ev.title,
                                        subtitle,
                                        yes,
                                        url:kalshiUrl(ev.event_ticker),
                                        ticker:m.ticker
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
                            slug:m.slug
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
          const[poly,kalshi]=await Promise.all([fetchPolyMarkets(20),fetchKalshiEvents(20)]);
          res.json({polyCount:poly.length,kalshiCount:kalshi.length,polySample:poly.slice(0,5),kalshiSample:kalshi.slice(0,5)});
    }catch(e){res.json({error:e.message});}
});

app.get("/markets",async(req,res)=>{
    try{
          const AKEY=process.env.ANTHROPIC_KEY;
          if(!AKEY)return res.status(500).json({error:"ANTHROPIC_KEY not set"});
          const[poly,kalshi]=await Promise.all([fetchPolyMarkets(500),fetchKalshiEvents(500)]);
          if(!poly.length||!kalshi.length)return res.json({results:[],source:"unavailable",polyCount:poly.length,kalshiCount:kalshi.length});

      const chunkSize=60;
          const polyChunks=[];
          for(let i=0;i<poly.length;i+=chunkSize)polyChunks.push({items:poly.slice(i,i+chunkSize),offset:i});
          const kalshiChunks=[];
          for(let i=0;i<kalshi.length;i+=chunkSize)kalshiChunks.push({items:kalshi.slice(i,i+chunkSize),offset:i});

      const allMatches=[];
          const tasks=[];
          for(const pc of polyChunks){
                  for(const kc of kalshiChunks){
                            tasks.push({pc,kc});
                  }
          }

      async function runTask({pc,kc}){
              const prompt=`You are matching prediction markets between Polymarket and Kalshi for arbitrage. ONLY return matches when BOTH markets resolve YES on the EXACT SAME real-world outcome (same teams, same event, same date, same threshold). DO NOT match similar-sounding markets unless the resolution criteria are identical. Be extremely strict — false matches cost money.

              POLYMARKET MARKETS:
              ${pc.items.map((m,i)=>`P${i}: ${m.title} [YES=${Math.round(m.yes*100)}c]`).join("\n")}

              KALSHI MARKETS:
              ${kc.items.map((m,i)=>`K${i}: ${m.title} [YES=${Math.round(m.yes*100)}c]`).join("\n")}

              Reply with ONLY valid JSON, no prose:
              {"matches":[{"p":<index>,"k":<index>,"why":"brief reason both resolve identically"}]}
              If no certain matches, reply: {"matches":[]}`;
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
                                    if(typeof m.p!=="number"||typeof m.k!=="number")continue;
                                    allMatches.push({pi:m.p+pc.offset,ki:m.k+kc.offset,note:m.why||""});
                        }
              }catch(e){}
      }

      const concurrency=8;
          for(let i=0;i<tasks.length;i+=concurrency){
                  await Promise.all(tasks.slice(i,i+concurrency).map(runTask));
          }

      const seen=new Set();
          const results=allMatches.map(({pi,ki,note})=>{
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

      res.json({results,source:"live",polyCount:poly.length,kalshiCount:kalshi.length,matchCount:results.length});
    }catch(e){
          res.status(500).json({error:e.message});
    }
});

app.get("/",(req,res)=>res.json({ok:true,endpoints:["/markets","/debug"]}));

app.listen(process.env.PORT||3001,"0.0.0.0",()=>console.log("ready"));
