/**
 * Hantavirus Tracker — Backend Crawler
 *
 * What it does:
 *   - Scrapes WHO DON 599 + CDC situation summary every 30 min
 *   - Parses out deaths / confirmed / suspected / countries
 *   - Caches the merged result in memory
 *   - Exposes GET /api/outbreak/latest for the frontend
 *
 * Run:
 *   npm init -y
 *   npm install express cheerio node-fetch@2 cors
 *   node server.js
 *
 * Deploy:
 *   - Render.com (free tier)  → push to Git, point Render at it
 *   - Railway / Fly.io / DO App Platform — same idea
 *   - VPS — pm2 start server.js
 *
 * Frontend:
 *   In index.html, set:
 *     const API_URL = 'https://your-backend.onrender.com/api/outbreak/latest';
 */

const express = require('express');
const cors    = require('cors');
const cheerio = require('cheerio');
const fetch   = require('node-fetch');

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 30 * 60 * 1000; // 30 min

const SOURCES = {
  WHO_DON: 'https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON599',
  CDC_SITUATION: 'https://www.cdc.gov/hantavirus/situation-summary/index.html',
};

const UA = 'Mozilla/5.0 (compatible; HantaTrackerBot/1.0; +https://hantavirustracker.today)';

/* ---------- In-memory cache ---------- */
let cache = {
  updatedAt: null,
  stats: { deaths: 3, confirmed: 5, suspected: 3, onboard: 147, countries: 6 },
  cases: defaultCases(),
  timeline: defaultTimeline(),
  news: defaultNews(),
  sources: { who: null, cdc: null },
  errors: [],
};

/* ---------- Scrapers ---------- */

async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/**
 * Pull the first integer that follows a keyword in plain text.
 * e.g. text="seven cases (two laboratory confirmed cases of hantavirus and five suspected cases) have been identified, including three deaths"
 *      pickNumber(text, /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+death/i)
 */
const WORD_NUM = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12 };
function toNum(token) {
  if (!token) return null;
  const t = token.toLowerCase();
  if (WORD_NUM[t] !== undefined) return WORD_NUM[t];
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
function pickNumber(text, regex) {
  const m = text.match(regex);
  return m ? toNum(m[1]) : null;
}

async function scrapeWHO() {
  const html = await fetchHTML(SOURCES.WHO_DON);
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');

  const numWord = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

  const deaths     = pickNumber(text, new RegExp(numWord + '\\s+deaths?', 'i'));
  const confirmed  = pickNumber(text, new RegExp(numWord + '\\s+(?:laboratory\\s+)?confirmed', 'i'));
  const suspected  = pickNumber(text, new RegExp(numWord + '\\s+suspected', 'i'));

  return {
    source: 'WHO DON 599',
    url: SOURCES.WHO_DON,
    fetchedAt: new Date().toISOString(),
    deaths, confirmed, suspected,
  };
}

async function scrapeCDC() {
  const html = await fetchHTML(SOURCES.CDC_SITUATION);
  const $ = cheerio.load(html);
  const text = $('main, .syndicate, body').first().text().replace(/\s+/g, ' ');

  const numWord = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
  const deaths    = pickNumber(text, new RegExp(numWord + '\\s+deaths?', 'i'));
  const confirmed = pickNumber(text, new RegExp(numWord + '\\s+confirmed\\s+cases?', 'i'));
  const suspected = pickNumber(text, new RegExp(numWord + '\\s+suspected\\s+cases?', 'i'));

  return {
    source: 'CDC Situation Summary',
    url: SOURCES.CDC_SITUATION,
    fetchedAt: new Date().toISOString(),
    deaths, confirmed, suspected,
  };
}

/* ---------- Aggregator ---------- */

async function refresh() {
  const errors = [];
  let who = null, cdc = null;

  try { who = await scrapeWHO(); }
  catch (e) { errors.push('WHO: ' + e.message); }

  try { cdc = await scrapeCDC(); }
  catch (e) { errors.push('CDC: ' + e.message); }

  // Merge: prefer the larger value (cases only grow), keep existing on null
  function merge(field) {
    const candidates = [who?.[field], cdc?.[field], cache.stats[field]].filter(n => Number.isFinite(n));
    return candidates.length ? Math.max(...candidates) : cache.stats[field];
  }

  cache = {
    ...cache,
    updatedAt: new Date().toISOString(),
    stats: {
      deaths:    merge('deaths'),
      confirmed: merge('confirmed'),
      suspected: merge('suspected'),
      onboard:   cache.stats.onboard,    // total on-board count is fixed per voyage
      countries: cache.stats.countries,  // not reliably parsed; keep curated
    },
    sources: { who, cdc },
    errors,
  };

  console.log(`[${cache.updatedAt}] refreshed · stats=${JSON.stringify(cache.stats)} · errors=${errors.length}`);
}

/* ---------- Default datasets (fallback / curated) ---------- */

function defaultCases() {
  return [
    { lat: 16.02, lng: -22.93, type: 'ship',      label: 'MV Hondius',      desc: 'Last reported position · heading toward Canary Islands' },
    { lat: 14.92, lng: -23.51, type: 'death',     label: 'Cabo Verde',      desc: 'Evacuation · 3 deaths recorded near port of Mindelo' },
    { lat: 28.29, lng: -16.62, type: 'confirmed', label: 'Tenerife, Spain', desc: 'Receiving evacuated passengers · multiple confirmed cases' },
    { lat: 51.50, lng: -0.12,  type: 'confirmed', label: 'United Kingdom',  desc: '3 nationals — confirmed and suspected cases under UKHSA care' },
    { lat: 52.52, lng: 13.40,  type: 'confirmed', label: 'Germany',         desc: '1 confirmed case · returnee monitoring active' },
    { lat: 50.85, lng: 4.35,   type: 'suspected', label: 'Belgium',         desc: 'Suspected case among returnees' },
    { lat: 38.91, lng: -77.04, type: 'monitor',   label: 'United States',   desc: 'CDC monitoring returned passengers · no confirmed cases' },
    { lat: 45.42, lng: -75.70, type: 'monitor',   label: 'Canada',          desc: 'PHAC follow-up of returned travellers' },
  ];
}
function defaultTimeline() {
  return [
    { date: '08 MAY 2026', title: 'WHO update · 5 PCR-confirmed cases', desc: 'Five of eight cluster cases now PCR-confirmed Andes virus.', source: 'WHO update, UKHSA, CDC', major: true },
    { date: '07 MAY 2026', title: 'Evacuations resume',                desc: 'Three sick passengers evacuated for treatment.', source: 'AP · Reuters · CBS' },
    { date: '04 MAY 2026', title: 'WHO publishes DON 599',             desc: 'WHO reports seven cases (two confirmed, five suspected), three deaths.', source: 'WHO DON 599', major: true },
    { date: '02 MAY 2026', title: 'Cluster reported to WHO',           desc: 'UK IHR focal point notifies WHO of severe respiratory illness cluster.', source: 'WHO DON 599' },
    { date: '06 APR 2026', title: 'First illness onset',               desc: 'Earliest illness onset among the cluster.', source: 'WHO DON 599' },
  ];
}
function defaultNews() {
  return [
    { source: 'WHO',     title: 'Hantavirus cluster linked to cruise ship travel — multi-country', url: SOURCES.WHO_DON, date: '04 May 2026', desc: 'Initial outbreak notification with case counts, deaths and risk assessment.' },
    { source: 'CDC',     title: 'Hantavirus current situation summary',                            url: SOURCES.CDC_SITUATION, date: '08 May 2026', desc: 'CDC raises travel response to Level 3, monitors returned US passengers.' },
    { source: 'Reuters', title: 'Spain prepares to receive evacuated cruise passengers',           url: 'https://www.reuters.com/', date: '09 May 2026', desc: 'Tenerife readies for arrival of more than 140 passengers and crew.' },
    { source: 'AP',      title: 'International effort to track dispersed cruise passengers',       url: 'https://apnews.com/', date: '08 May 2026', desc: 'Health officials in at least a dozen countries are monitoring returnees.' },
  ];
}

/* ---------- HTTP server ---------- */

const app = express();
app.use(cors()); // allow your frontend domain to fetch this

app.get('/api/outbreak/latest', (req, res) => {
  res.json({
    updatedAt: cache.updatedAt,
    stats: cache.stats,
    cases: cache.cases,
    timeline: cache.timeline,
    news: cache.news,
    sources: cache.sources,
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, updatedAt: cache.updatedAt, errors: cache.errors });
});

app.get('/', (req, res) => {
  res.type('text/plain').send('Hantavirus Tracker API · GET /api/outbreak/latest');
});

app.listen(PORT, () => {
  console.log(`API running on :${PORT}`);
  refresh();                          // initial scrape
  setInterval(refresh, REFRESH_MS);   // every 30 min
});
