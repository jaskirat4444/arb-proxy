const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const KEY = process.env.ANTHROPIC_KEY;

const MOCK_P = [
  {id:"pm1",title:"Will the Fed cut rates at the June 2026 FOMC meeting?",yes:0.38,url:"https://polymarket.com"},
  {id:"pm2",title:"Will Bitcoin exceed $120k before July 2026?",yes:0.29,url:"https://polymarket.com"},
  {id:"pm3",title:"Will the S&P 500 close above 5800 in May 2026?",yes:0.62,url:"https://polymarket.com"},
  {id:"pm4",title:"Will there be a US recession in 2026?",yes:0.34,url:"https://polymarket.com"},
  {id:"pm5",title:"Will Elon Musk leave his government role by end of 2026?",yes:0.57,url:"https://polymarket.com"},
];
const MOCK_K = [
  {id:"k1",title:"Fed cuts rates - June 2026 meeting",yes:0.41,url:"https://kalshi.com"},
  {id:"k2",title:"Bitcoin above $120,000 by July 1 2026",yes:0.26,url:"https://kalshi.com"},
  {id:"k3",title:"S&P 500 above 5800 end of May 2026",yes:0.65,url:"https://kalshi.com"},
  {id:"k4",title:"US economy enters recession in 2026",yes:0.31,url:"https://kalshi.com"},
  {id:"k5",title:"Elon Musk steps down from DOGE in 2026",yes:0.53,url:"https://kalshi.com"},
];

app.get("/markets", async (req, res) => {
  try {
    const [p, k] = await Promise.allSettled([
      fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&order=volume&ascending=false"),
      fetch("https://trading-api.kalshi.com/trade-api/v2/markets?status=open&limit=50")
    ]);

    const poly = p.status==="fulfilled" && p.value.ok
      ? (await p.value.json()).slice(0,50).map(m=>({id:m.id,title:m.question,yes:parseFloat(m.outcomePrices?.[0]??0.5),url:`https://polymarket.com/event/${m.slug}`})).filter(m=>m.yes>0&&m.yes<1)
      : MOCK_P;

    const kd = k.status==="fulfilled" && k.value.ok ? await k.value.json
