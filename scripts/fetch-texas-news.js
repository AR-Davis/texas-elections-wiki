#!/usr/bin/env node
/**
 * Texas News Fetcher
 * Fetches Texas-specific news from AP and writes to JSON for static inclusion
 * Run via cron: node scripts/fetch-texas-news.js
 */

const fs = require('fs');
const path = require('path');

const RSS_FEEDS = [
  { name: 'topnews', url: 'https://rsshub.app/apnews/topics/apf-topnews' },
  { name: 'usnews', url: 'https://rsshub.app/apnews/topics/apf-usnews' },
  { name: 'politics', url: 'https://rsshub.app/apnews/topics/apf-politics' }
];

const TEXAS_KEYWORDS = [
  'texas', 'texan', 'houston', 'dallas', 'austin', 'san antonio', 'fort worth',
  'el paso', 'arlington', 'corpus christi', 'plano', 'lubbock', 'laredo',
  'irving', 'garland', 'amarillo', 'mcallen', 'brownsville', 'killeen',
  'pasadena', 'mesquite', 'midland', 'mckinney', 'denton', 'waco', 'abilene',
  'carrollton', 'beaumont', 'odessa', 'round rock', 'wichita falls',
  'richardson', 'lewisville', 'tyler', 'pearland', 'college station',
  'kevin stitt', 'greg abbott', 'ted cruz', 'john cornyn', 'dan patrick',
  'ken paxton', 'state legislature', 'txlege', 'lege', 'border',
  'rio grande', 'border patrol', 'mexico border'
];

const CACHE_FILE = path.join(__dirname, '..', 'data', 'texas-news.json');
const CACHE_HOURS = 1; // Refresh every hour

function texasRelevance(title = '', description = '') {
  const text = (title + ' ' + description).toLowerCase();
  let score = 0;
  
  for (const keyword of TEXAS_KEYWORDS) {
    if (text.includes(keyword.toLowerCase())) {
      // Major cities and state name get higher weight
      if (['texas', 'texan', 'txlege', 'lege'].includes(keyword)) score += 3;
      else if (['houston', 'dallas', 'austin', 'san antonio'].includes(keyword)) score += 2;
      else score += 1;
    }
  }
  
  return score;
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.items || [];
  } catch (err) {
    console.error(`Failed to fetch ${feed.name}:`, err.message);
    return [];
  }
}

async function main() {
  console.log('[texas-news] Starting fetch...');
  
  // Check cache
  try {
    const stats = fs.statSync(CACHE_FILE);
    const ageHours = (Date.now() - stats.mtime) / (1000 * 60 * 60);
    if (ageHours < CACHE_HOURS) {
      console.log(`[texas-news] Cache is ${ageHours.toFixed(1)}h old, using cached data.`);
      process.exit(0);
    }
  } catch {}
  
  // Fetch all feeds
  const allItems = [];
  for (const feed of RSS_FEEDS) {
    const items = await fetchFeed(feed);
    for (const item of items) {
      allItems.push({
        ...item,
        feedSource: feed.name,
        texasScore: texasRelevance(item.title, item.description)
      });
    }
  }
  
  // Filter and sort by Texas relevance
  const texasNews = allItems
    .filter(item => item.texasScore > 0)
    .sort((a, b) => {
      // Higher score first, then newer date
      if (b.texasScore !== a.texasScore) return b.texasScore - a.texasScore;
      return new Date(b.pubDate || 0) - new Date(a.pubDate || 0);
    })
    .slice(0, 15); // Top 15 Texas stories
  
  const output = {
    fetchedAt: new Date().toISOString(),
    count: texasNews.length,
    items: texasNews.map(item => ({
      title: item.title,
      link: item.link,
      pubDate: item.pubDate,
      description: item.description?.substring(0, 200),
      feedSource: item.feedSource,
      texasScore: item.texasScore
    }))
  };
  
  // Ensure data directory exists
  const dataDir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  fs.writeFileSync(CACHE_FILE, JSON.stringify(output, null, 2));
  console.log(`[texas-news] Wrote ${texasNews.length} Texas stories to cache.`);
}

main().catch(err => {
  console.error('[texas-news] Fatal error:', err);
  process.exit(1);
});
