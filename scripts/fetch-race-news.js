#!/usr/bin/env node
/**
 * Race News Scanner
 * Fetches news from AP feeds via aaronrdavis.news/api/rss and filters for
 * stories relevant to the 2026 Texas Senate race (Talarico vs Paxton).
 * Writes results to data/race-news.json for static inclusion on the wiki.
 *
 * Run via cron: node scripts/fetch-race-news.js
 */

const fs = require('fs');
const path = require('path');

// Use our own RSS endpoint — rsshub.app is dead
const RSS_BASE = 'https://aaronrdavis.news/api/rss';
const FEEDS = [
  { name: 'topnews',   feed: 'apf-topnews' },
  { name: 'usnews',    feed: 'apf-usnews' },
  { name: 'politics',  feed: 'apf-politics' },
  { name: 'business',  feed: 'apf-business' },
  { name: 'health',    feed: 'apf-Health' },
];

// Additional sources via direct RSS (not through our proxy)
const EXTRA_FEEDS = [
  // Texas Tribune — Texas-focused political coverage
  { name: 'texastribune', url: 'https://www.texastribune.org/feeds/news.xml' },
  // Google News search for "Talarico Paxton Texas Senate 2026"
  { name: 'google-news-race', url: 'https://news.google.com/rss/search?q=Talarico+OR+Paxton+Texas+Senate+2026+when:3d&hl=en-US&gl=US&ceid=US:en' },
  // Google News search for "Texas politics" (broader)
  { name: 'google-news-texas', url: 'https://news.google.com/rss/search?q=%22Texas+politics%22+when:2d&hl=en-US&gl=US&ceid=US:en' },
];

// Race-specific keywords — these are what make a story relevant
const RACE_KEYWORDS = {
  // Candidates
  'talarico': 5, 'james talarico': 6,
  'paxton': 5, 'ken paxton': 6,
  // Race context
  'texas senate': 5, 'senate race': 3, 'senate election': 3,
  'texas senate race': 7,
  // Runoff / primary
  'primary runoff': 3, 'republican primary': 3, 'democratic primary': 3,
  // Former primary candidates
  'cornyn': 4, 'john cornyn': 5,
  // Key counties
  'harris county': 3, 'bexar county': 3, 'dallas county': 3,
  'tarrant county': 3, 'travis county': 3,
  // Related context
  'attorney general': 2, 'state representative': 2,
  'texas politics': 4, 'texas democrat': 3, 'texas republican': 3,
  'texas gop': 3, 'texas democrats': 3,
};

// Generic Texas keywords — lower weight, add context
const TEXAS_KEYWORDS = {
  'texas': 1, 'houston': 1, 'dallas': 1, 'austin': 1,
  'san antonio': 1, 'fort worth': 1, 'el paso': 1,
};

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'race-news.json');

function raceRelevance(title = '', description = '') {
  const text = (title + ' ' + description).toLowerCase();
  let score = 0;
  const matched = [];

  for (const [keyword, weight] of Object.entries(RACE_KEYWORDS)) {
    if (text.includes(keyword)) {
      score += weight;
      matched.push(keyword);
    }
  }

  // Add generic Texas weight only if we already have race relevance
  if (score > 0) {
    for (const [keyword, weight] of Object.entries(TEXAS_KEYWORDS)) {
      if (text.includes(keyword)) {
        score += weight;
      }
    }
  }

  return { score, matched };
}

async function fetchFeed(feed) {
  try {
    const url = feed.url || `${RSS_BASE}?feed=${feed.feed}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Our RSS endpoint returns JSON; external feeds return XML
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('json') || feed.feed) {
      const data = await res.json();
      return data.items || [];
    } else {
      // Parse XML RSS feed
      const text = await res.text();
      const items = [];
      // Simple regex RSS parser — no dependencies
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(text)) !== null) {
        const itemXml = match[1];
        const title = itemXml.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                      itemXml.match(/<title>([\s\S]*?)<\/title>/);
        const link = itemXml.match(/<link>([\s\S]*?)<\/link>/);
        const pubDate = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        const desc = itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                     itemXml.match(/<description>([\s\S]*?)<\/description>/);
        items.push({
          title: title ? title[1].trim() : '',
          link: link ? link[1].trim() : '',
          pubDate: pubDate ? pubDate[1].trim() : '',
          description: desc ? desc[1].replace(/<[^>]+>/g, '').trim() : '',
        });
      }
      return items;
    }
  } catch (err) {
    console.error(`[race-news] Failed to fetch ${feed.name}: ${err.message}`);
    return [];
  }
}

async function main() {
  console.log('[race-news] Starting scan...');

  // Fetch all feeds
  const allItems = [];
  for (const feed of FEEDS) {
    console.log(`[race-news] Fetching ${feed.name}...`);
    const items = await fetchFeed(feed);
    console.log(`[race-news]   ${items.length} items from ${feed.name}`);
    for (const item of items) {
      allItems.push({
        title: item.title || '',
        link: item.link || '',
        pubDate: item.pubDate || '',
        description: item.description || '',
        feedSource: feed.name,
      });
    }
  }
  for (const feed of EXTRA_FEEDS) {
    console.log(`[race-news] Fetching ${feed.name}...`);
    const items = await fetchFeed(feed);
    console.log(`[race-news]   ${items.length} items from ${feed.name}`);
    for (const item of items) {
      allItems.push({
        title: item.title || '',
        link: item.link || '',
        pubDate: item.pubDate || '',
        description: item.description || '',
        feedSource: feed.name,
      });
    }
  }

  // Score and filter
  const raceNews = allItems
    .map(item => {
      const { score, matched } = raceRelevance(item.title, item.description);
      return { ...item, raceScore: score, matchedKeywords: matched };
    })
    .filter(item => item.raceScore >= 3)
    .sort((a, b) => {
      if (b.raceScore !== a.raceScore) return b.raceScore - a.raceScore;
      return new Date(b.pubDate || 0) - new Date(a.pubDate || 0);
    })
    .slice(0, 25); // Top 25 race-relevant stories

  // Deduplicate by link
  const seen = new Set();
  const deduped = raceNews.filter(item => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });

  const output = {
    fetchedAt: new Date().toISOString(),
    count: deduped.length,
    feedsChecked: FEEDS.length + EXTRA_FEEDS.length,
    itemsScanned: allItems.length,
    items: deduped.map(item => ({
      title: item.title,
      link: item.link,
      pubDate: item.pubDate,
      feedSource: item.feedSource,
      raceScore: item.raceScore,
      matchedKeywords: item.matchedKeywords,
    })),
  };

  // Ensure data directory exists
  const dataDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[race-news] Wrote ${deduped.length} race-relevant stories to ${OUTPUT_FILE}`);
  console.log(`[race-news] Scanned ${allItems.length} items from ${FEEDS.length} feeds`);
}

main().catch(err => {
  console.error('[race-news] Fatal error:', err);
  process.exit(1);
});