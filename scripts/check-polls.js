#!/usr/bin/env node
/**
 * Poll Detector + Rebuilder
 * Scrapes Wikipedia's 2026 Texas Senate election page for the general election
 * polling table (Talarico vs Paxton), writes a changelog, a summary, and
 * rebuilds data/polls-2026.json from the full table on every run.
 *
 * Run via cron: node scripts/check-polls.js
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('node-html-parser');

const WIKI_URL = 'https://en.wikipedia.org/wiki/2026_United_States_Senate_election_in_Texas';
const POLLS_FILE = path.join(__dirname, '..', 'data', 'polls-2026.json');
const CHANGES_FILE = path.join(__dirname, '..', 'data', 'poll-updates.json');
const SUMMARY_FILE = path.join(__dirname, '..', 'data', 'poll-check-summary.json');

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

function normalizeWs(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function findGeneralElectionTable(html) {
  const root = parse(html);
  const tables = root.querySelectorAll('table');
  for (const t of tables) {
    const text = normalizeWs(t.textContent);
    if (
      text.includes('Poll source') &&
      text.includes('Paxton (R)') &&
      text.includes('Talarico (D)') &&
      text.includes('Margin of error')
    ) {
      return t;
    }
  }
  return null;
}

function cleanPollster(s) {
  return s.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
}

function parseDate(s) {
  const months = {
    January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
    July: 7, August: 8, September: 9, October: 10, November: 11, December: 12
  };
  const yearMatch = s.match(/(20\d{2})/);
  if (!yearMatch) return null;
  const year = parseInt(yearMatch[1], 10);
  const pairs = s.match(/([A-Za-z]+)\s+(\d{1,2})(?:-\d{1,2})?/g);
  if (pairs && pairs.length) {
    const last = pairs[pairs.length - 1];
    const m = last.match(/([A-Za-z]+)\s+(\d{1,2})/);
    if (m && months[m[1]]) {
      return `${year}-${String(months[m[1]]).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
    }
  }
  return `${year}-01-01`;
}

function parseSample(s) {
  const m = s.match(/([0-9,]+)\s*\((LV|RV|V|A)\)/);
  if (m) return { size: parseInt(m[1].replace(/,/g, ''), 10), method: m[2] };
  const m2 = s.match(/([0-9,]+)/);
  if (m2) return { size: parseInt(m2[1].replace(/,/g, ''), 10), method: 'LV' };
  return { size: null, method: 'LV' };
}

function parseMoE(s) {
  const m = s.match(/±\s*([0-9.]+)%/);
  return m ? parseFloat(m[1]) : null;
}

function parsePct(s) {
  const t = s.replace(/</g, '').replace(/%/g, '').replace(/—/g, '').trim();
  if (!t) return null;
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

function inferSponsor(pollsterRaw) {
  if (/YouGov Blue|Blue \(D\)|Public Opinion Research \(D\)|Beacon Research \(D\)|Impact Research \(D\)|Hart Research \(D\)|Blueprint Polling \(D\)|Public Policy Polling \(D\)/.test(pollsterRaw)) return 'Democratic';
  if (/\(R\)|Stratus Intelligence|Trafalgar Group|SoCal Strategies|Quantus Insights|Ragnar Research Partners|Overton Insights|Guidant Polling|Pulse Decision Science/.test(pollsterRaw)) return 'Republican';
  return 'Independent';
}

function parseGeneralElectionTable(table) {
  const rows = table.querySelectorAll('tr');
  // Merge continuation rows (empty first cell)
  const merged = [];
  for (const tr of rows) {
    const cells = tr.querySelectorAll('td, th').map(c => normalizeWs(c.textContent));
    if (cells.length < 8) continue;
    const first = cells[0].trim();
    if (!first && cells[1] && (cells[1].toLowerCase().includes('primary') || cells[1].toLowerCase().includes('election'))) continue;
    if (!first) {
      if (merged.length) merged[merged.length - 1].push(cells);
    } else {
      merged.push([cells]);
    }
  }

  const polls = [];
  for (const group of merged) {
    // Prefer LV over RV
    let selected = group[0];
    for (const r of group) {
      if (r[2].includes('LV')) {
        selected = r;
        break;
      }
    }
    const pollsterRaw = selected[0];
    const pollster = cleanPollster(pollsterRaw);
    const date = parseDate(selected[1]);
    const sample = parseSample(selected[2]);
    const moe = parseMoE(selected[3]);
    const paxton = parsePct(selected[4]);
    const talarico = parsePct(selected[5]);
    const other = parsePct(selected[6]);
    let undecided = parsePct(selected[7]);
    if (undecided === null && other !== null) undecided = other;
    if (talarico === null || paxton === null || date === null) continue;

    polls.push({
      pollster,
      sponsor: inferSponsor(pollsterRaw),
      date,
      sampleSize: sample.size,
      marginError: moe,
      talarico,
      paxton,
      undecided: undecided !== null ? undecided : 0,
      method: sample.method
    });
  }

  polls.sort((a, b) => (a.date > b.date ? -1 : 1));
  return polls;
}

function buildPollsJson(polls) {
  const n = polls.length;
  const avgT = n ? Math.round((polls.reduce((s, p) => s + p.talarico, 0) / n) * 10) / 10 : 0;
  const avgP = n ? Math.round((polls.reduce((s, p) => s + p.paxton, 0) / n) * 10) / 10 : 0;
  const avgU = n ? Math.round((polls.reduce((s, p) => s + p.undecided, 0) / n) * 10) / 10 : 0;

  return {
    race: '2026 Texas U.S. Senate (Paxton vs Talarico)',
    lastUpdated: new Date().toISOString().slice(0, 10),
    source: 'Wikipedia: 2026 United States Senate election in Texas (General election polling)',
    polls,
    averages: {
      talarico: avgT,
      paxton: avgP,
      undecided: avgU
    }
  };
}

function loadExistingPolls() {
  try {
    return JSON.parse(fs.readFileSync(POLLS_FILE, 'utf-8'));
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

  const table = findGeneralElectionTable(html);
  if (!table) {
    console.error('[polls] Could not find general election polling table');
    process.exit(1);
  }

  console.log('[polls] Extracting polls...');
  const wikiPolls = parseGeneralElectionTable(table);
  console.log(`[polls] Found ${wikiPolls.length} polls on Wikipedia`);

  const existing = loadExistingPolls();
  const existingDates = new Set(existing.polls.map(p => p.date));
  const newPolls = wikiPolls.filter(p => !existingDates.has(p.date));
  console.log(`[polls] New polls detected: ${newPolls.length}`);

  if (newPolls.length > 0) {
    for (const poll of newPolls) {
      console.log(`[polls] NEW: ${poll.pollster} (${poll.date}) — Paxton ${poll.paxton}% Talarico ${poll.talarico}%`);
    }
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
    changes.updates = changes.updates.slice(0, 50);
    fs.writeFileSync(CHANGES_FILE, JSON.stringify(changes, null, 2));
    console.log(`[polls] Wrote changelog to ${CHANGES_FILE}`);
  } else {
    console.log('[polls] No new polls since last check.');
  }

  // Always rebuild the full polls JSON from the latest table
  console.log('[polls] Rebuilding data/polls-2026.json...');
  const data = buildPollsJson(wikiPolls);
  fs.writeFileSync(POLLS_FILE, JSON.stringify(data, null, 2));
  console.log(`[polls] Wrote ${data.polls.length} polls to ${POLLS_FILE}`);

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
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(output, null, 2));
  console.log(`[polls] Summary written to ${SUMMARY_FILE}`);
}

main().catch(err => {
  console.error('[polls] Fatal error:', err);
  process.exit(1);
});
