#!/usr/bin/env node
/**
 * Race Sentiment Analyzer
 * Reads data/race-news.json, runs sentiment analysis on each story via
 * aaronrdavis-news/api/sentiment (Cloudflare Workers AI), and writes
 * aggregated sentiment data to data/race-sentiment.json.
 *
 * Run via cron after fetch-race-news.js: node scripts/analyze-sentiment.js
 */

const fs = require('fs');
const path = require('path');

const NEWS_FILE = path.join(__dirname, '..', 'data', 'race-news.json');
const SENTIMENT_FILE = path.join(__dirname, '..', 'data', 'race-sentiment.json');
const SENTIMENT_ENDPOINT = 'https://aaronrdavis.news/api/sentiment';

function loadNews() {
  try {
    return JSON.parse(fs.readFileSync(NEWS_FILE, 'utf-8'));
  } catch {
    return { items: [] };
  }
}

function loadExistingSentiment() {
  try {
    return JSON.parse(fs.readFileSync(SENTIMENT_FILE, 'utf-8'));
  } catch {
    return { analyzedAt: '', stories: [], weekly: {} };
  }
}

async function analyzeStory(story) {
  try {
    // Use the headline + description for sentiment (not the full article)
    const text = `${story.title}. ${story.description || ''}`.trim();
    
    const res = await fetch(SENTIMENT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();

    return {
      title: story.title,
      link: story.link,
      pubDate: story.pubDate,
      feedSource: story.feedSource,
      raceScore: story.raceScore,
      matchedKeywords: story.matchedKeywords,
      sentiment: {
        positive: result.positive,
        negative: result.negative,
        label: result.label,
      },
    };
  } catch (err) {
    console.error(`[sentiment] Failed: ${story.title.substring(0, 50)}... — ${err.message}`);
    return {
      title: story.title,
      link: story.link,
      pubDate: story.pubDate,
      feedSource: story.feedSource,
      raceScore: story.raceScore,
      matchedKeywords: story.matchedKeywords,
      sentiment: null,
      error: err.message,
    };
  }
}

function getWeekKey(dateStr) {
  try {
    const d = new Date(dateStr);
    const year = d.getUTCFullYear();
    const start = new Date(Date.UTC(year, 0, 1));
    const week = Math.floor((d - start) / (7 * 24 * 60 * 60 * 1000));
    return `${year}-W${String(week + 1).padStart(2, '0')}`;
  } catch {
    return 'unknown';
  }
}

function determineCandidate(story) {
  const text = (story.title + ' ' + (story.description || '')).toLowerCase();
  const mentionsTalarico = text.includes('talarico');
  const mentionsPaxton = text.includes('paxton');
  
  if (mentionsTalarico && mentionsPaxton) return 'both';
  if (mentionsTalarico) return 'talarico';
  if (mentionsPaxton) return 'paxton';
  return 'general';
}

async function main() {
  console.log('[sentiment] Starting analysis...');

  const news = loadNews();
  const existing = loadExistingSentiment();

  if (!news.items || news.items.length === 0) {
    console.log('[sentiment] No news items to analyze.');
    process.exit(0);
  }

  // Track which links we've already analyzed
  const alreadyAnalyzed = new Set(existing.stories.map(s => s.link));

  // Only analyze new stories
  const newStories = news.items.filter(item => !alreadyAnalyzed.has(item.link));
  console.log(`[sentiment] ${newStories.length} new stories to analyze (out of ${news.items.length})`);

  if (newStories.length === 0) {
    console.log('[sentiment] All stories already analyzed.');
    // Still update the timestamp
    existing.analyzedAt = new Date().toISOString();
    fs.writeFileSync(SENTIMENT_FILE, JSON.stringify(existing, null, 2));
    process.exit(0);
  }

  // Analyze each story (with a small delay to avoid rate limits)
  const analyzed = [];
  for (let i = 0; i < newStories.length; i++) {
    const story = newStories[i];
    console.log(`[sentiment] Analyzing ${i + 1}/${newStories.length}: ${story.title.substring(0, 60)}...`);
    const result = await analyzeStory(story);
    result.candidate = determineCandidate(story);
    result.weekKey = getWeekKey(story.pubDate);
    analyzed.push(result);
    
    // Small delay between requests
    if (i < newStories.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Merge with existing stories
  const allStories = [...analyzed, ...existing.stories].slice(0, 100); // Keep last 100

  // Aggregate by week and candidate
  const weekly = {};
  for (const story of allStories) {
    if (!story.sentiment) continue;
    
    const week = story.weekKey;
    const candidate = story.candidate;
    
    if (!weekly[week]) weekly[week] = {};
    if (!weekly[week][candidate]) {
      weekly[week][candidate] = { positive: 0, negative: 0, total: 0 };
    }
    
    if (story.sentiment.label === 'positive') weekly[week][candidate].positive++;
    if (story.sentiment.label === 'negative') weekly[week][candidate].negative++;
    weekly[week][candidate].total++;
  }

  const output = {
    analyzedAt: new Date().toISOString(),
    newsFetchedAt: news.fetchedAt,
    totalAnalyzed: allStories.length,
    newThisRun: analyzed.length,
    stories: allStories,
    weekly,
  };

  fs.writeFileSync(SENTIMENT_FILE, JSON.stringify(output, null, 2));
  console.log(`[sentiment] Wrote ${allStories.length} analyzed stories to ${SENTIMENT_FILE}`);
  console.log(`[sentiment] Weekly aggregation: ${Object.keys(weekly).length} weeks`);
}

main().catch(err => {
  console.error('[sentiment] Fatal error:', err);
  process.exit(1);
});