#!/usr/bin/env node
/**
 * Poll Detector
 * Scrapes Wikipedia's 2026 Texas Senate election page for the general election
 * polling table (Talarico vs Paxton), extracts polls, and compares against
 * our existing data/polls-2026.json. Writes updated data + a changelog.
 *
 * Run via cron: node scripts/check-polls.js
 */

const fs = require('fs');
const path = require('path');

const WIKI_URL = 'https://en.wikipedia.org/wiki/2026_United_States_Senate_election_in_Texas';
const POLLS_FILE = path.join(__dirname, '..', 'data', 'polls-2026.json');
const CHANGES_FILE = path.join(__dirname, '..', 'data', 'poll-updates.json');

async function fetchWikipedia() {
  try {
    const res = await fetch(WIKI_URL, {
      headers: { 'User-Agent': 'TexasElectionsWiki/1.0 (github.com/AR-Davis/texas-elections-wiki)' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    console.error(`[polls] Failed to fetch Wikipedia: ${err.message}`);
    return null;
  }
}

function extractPolls(html) {
  // Find all wikitables that contain both Talarico and Paxton
  const tableRegex = /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/g;
  const polls = [];
  let tableMatch;

  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[1];

    // Must contain both candidate names to be a general election table
    if (!tableHtml.includes('Talarico') || !tableHtml.includes('Paxton')) continue;

    // Parse rows
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let rowMatch;
    let isHeaderRow = true;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];

      // Skip header rows
      if (rowHtml.includes('<th') && !rowHtml.includes('<td')) continue;

      // Extract cells
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
      const cells = [];
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        let cellText = cellMatch[1]
          .replace(/<[^>]+>/g, ' ')  // strip tags
          .replace(/&amp;/g, '&')
          .replace(/&#91;\s*\d+\s*&#93;/g, '') // strip reference numbers
          .replace(/&#160;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        cells.push(cellText);
      }

      if (cells.length < 5) continue;

      // The general election table has columns:
      // Poll source | Date(s) administered | Sample size | MoE | Paxton (R) | Talarico (D) | Other | Undecided
      // We need to find which column is which by looking for the header

      // Try to extract pollster name, date, paxton %, talarico %, undecided %
      const pollster = cells[0] || '';
      const dateStr = cells[1] || '';

      // Look for percentage values in cells
      const pcts = cells.map(c => {
        const m = c.match(/^(\d{1,2}(?:\.\d)?)%$/);
        return m ? parseFloat(m[1]) : null;
      });

      // Find the two largest percentage values that aren't undecided
      // In a Talarico vs Paxton table, both candidates should be > 30%
      const candidatePcts = pcts.filter(p => p !== null && p >= 30);

      if (candidatePcts.length < 2) continue;

      // Determine which is Talarico and which is Paxton by column position
      // Paxton (R) typically comes before Talarico (D) in Wikipedia tables
      // Find the first two cells with % >= 30
      let paxtonIdx = -1, talaricoIdx = -1;
      for (let i = 0; i < pcts.length; i++) {
        if (pcts[i] !== null && pcts[i] >= 30) {
          if (paxtonIdx === -1) {
            paxtonIdx = i;
          } else if (talaricoIdx === -1) {
            talaricoIdx = i;
            break;
          }
        }
      }

      if (paxtonIdx === -1 || talaricoIdx === -1) continue;

      const paxton = pcts[paxtonIdx];
      const talarico = pcts[talaricoIdx];

      // Find undecided (usually the last % cell or one near 10)
      const undecided = pcts.find(p => p !== null && p < 30) || 0;

      // Skip if pollster is empty or it's a "May 26" event row
      if (!pollster || pollster.match(/^(May|March|June|July|April|Primary|Runoff)/i)) continue;

      // Normalize date — Wikipedia uses "June 23–28, 2026" format
      const date = dateStr.replace(/–/g, '-').replace(/\s+/g, ' ').trim();

      // Clean pollster name — strip Wikipedia reference numbers like [ 354 ]
      const cleanPollster = pollster.replace(/\[\s*\d+\s*\]/g, '').replace(/\[\s*[A-Z]\s*\]/g, '').trim();

      // Skip if pollster is empty or it's an event row
      if (!cleanPollster || cleanPollster.match(/^(May|March|June|July|April|Primary|Runoff|November|December|October|September|January|February)/i)) continue;

      // Create a unique ID from pollster + date
      const pollId = `${cleanPollster.substring(0, 30)}|${date}`.toLowerCase().replace(/\s+/g, '_');

      polls.push({
        pollId,
        pollster: cleanPollster.substring(0, 80),
        date,
        paxton,
        talarico,
        undecided,
        source: 'wikipedia',
      });
    }
  }

  return polls;
}

function loadExistingPolls() {
  try {
    const data = fs.readFileSync(POLLS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { polls: [], averages: {}, lastUpdated: '' };
  }
}

function loadExistingChanges() {
  try {
    return JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf-8'));
  } catch {
    return { updates: [] };
  }
}

async function main() {
  console.log('[polls] Fetching Wikipedia...');
  const html = await fetchWikipedia();
  if (!html) {
    console.log('[polls] No data fetched, exiting.');
    process.exit(0);
  }

  console.log('[polls] Extracting polls...');
  const wikiPolls = extractPolls(html);
  console.log(`[polls] Found ${wikiPolls.length} polls on Wikipedia`);

  // Load our existing data
  const existing = loadExistingPolls();

  // Normalize dates to "YYYY-MM" + start day for fuzzy matching
  // Our JSON uses "2026-06-23", Wikipedia uses "June 23-28, 2026"
  function normalizeDate(dateStr) {
    // Try ISO format first (our JSON)
    let isoMatch = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

    // Try "June 23-28, 2026" format (Wikipedia)
    const months = {january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',
                    july:'07',august:'08',september:'09',october:'10',november:'11',december:'12'};
    let wikiMatch = dateStr.toLowerCase().match(/(\w+)\s+(\d{1,2})(?:\s*[-–]\s*\d{1,2})?,?\s*(\d{4})/);
    if (wikiMatch) {
      const month = months[wikiMatch[1]] || '??';
      const day = wikiMatch[2].padStart(2, '0');
      const year = wikiMatch[3];
      return `${year}-${month}-${day}`;
    }
    // Fallback: just use the raw string
    return dateStr.toLowerCase().trim();
  }

  const existingDates = new Set(existing.polls.map(p => normalizeDate(p.date)));

  // Find new polls (by date match)
  const newPolls = wikiPolls.filter(p => {
    const normDate = normalizeDate(p.date);
    return !existingDates.has(normDate);
  });
  console.log(`[polls] New polls detected: ${newPolls.length}`);

  if (newPolls.length > 0) {
    for (const poll of newPolls) {
      console.log(`[polls] NEW: ${poll.pollster} (${poll.date}) — Paxton ${poll.paxton}% Talarico ${poll.talarico}%`);
    }

    // Update changelog
    const changes = loadExistingChanges();
    for (const poll of newPolls) {
      changes.updates.unshift({
        detectedAt: new Date().toISOString(),
        pollster: poll.pollster,
        date: poll.date,
        paxton: poll.paxton,
        talarico: poll.talarico,
        undecided: poll.undecided,
      });
    }
    // Keep last 50 changes
    changes.updates = changes.updates.slice(0, 50);

    // Write changelog
    fs.writeFileSync(CHANGES_FILE, JSON.stringify(changes, null, 2));
    console.log(`[polls] Wrote changelog to ${CHANGES_FILE}`);
  } else {
    console.log('[polls] No new polls since last check.');
  }

  // Always update the fetchedAt timestamp
  const output = {
    lastChecked: new Date().toISOString(),
    wikiPollCount: wikiPolls.length,
    newPollsDetected: newPolls.length,
    latestPolls: wikiPolls.slice(0, 10).map(p => ({
      pollster: p.pollster,
      date: p.date,
      paxton: p.paxton,
      talarico: p.talarico,
      undecided: p.undecided,
    })),
  };

  // Write a summary file
  const summaryFile = path.join(__dirname, '..', 'data', 'poll-check-summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(output, null, 2));
  console.log(`[polls] Summary written to ${summaryFile}`);
}

main().catch(err => {
  console.error('[polls] Fatal error:', err);
  process.exit(1);
});