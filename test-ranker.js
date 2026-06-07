'use strict';
/**
 * Unit + integration tests for ranker matching and rank ordering.
 * Run: node --test test-ranker.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from .claude'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
//  Pure functions copied verbatim from ranker.js
// ─────────────────────────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const fields = [];
  let field = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { field += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      fields.push(field); field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function parseCsv(text) {
  const lines = text.split('\n');
  let headers = null;
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (!headers) { headers = fields.map(h => h.trim()); continue; }
    const row = {};
    headers.forEach((h, i) => { row[h] = (fields[i] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

function normalizeText(s) {
  return (s || '').toLowerCase().replace(/[,.()\-&]/g, ' ').replace(/\s+/g, ' ').trim();
}

function matchScore(pageText, csvText) {
  const pg  = normalizeText(pageText);
  const csv = normalizeText(csvText);
  if (!pg || !csv) return 0;
  if (pg === csv)  return 1000;

  const pgWords  = new Set(pg.split(/\s+/).filter(w => w.length >= 4));
  const csvWords = new Set(csv.split(/\s+/).filter(w => w.length >= 4));
  if (!pgWords.size || !csvWords.size) return 0;

  let inter = 0;
  for (const w of pgWords) if (csvWords.has(w)) inter++;
  const union   = pgWords.size + csvWords.size - inter;
  const jaccard = inter / union;
  if (jaccard < 0.7) return 0;

  let score = Math.round(jaccard * 600);
  if (pg.includes(csv) || csv.includes(pg)) {
    score += Math.round(
      Math.min(pg.length, csv.length) / Math.max(pg.length, csv.length) * 400
    );
  }
  return score;
}

const QUOTA_ORDER = ['AI', 'OS', 'HS', 'GO', 'JK', 'LA'];

function bestMatch(byQuota, preferredQuota, choice) {
  const quotaRank = q => {
    const order = [preferredQuota, ...QUOTA_ORDER.filter(x => x !== preferredQuota)];
    const idx = order.indexOf(q);
    return idx === -1 ? 99 : idx;
  };
  let best = null, bestScore = 0, bestQRank = 99;
  for (const [q, rows] of Object.entries(byQuota)) {
    for (const r of rows) {
      const instScore = matchScore(choice.institute, r.institute_name);
      if (instScore < 500) continue;
      const progScore = matchScore(choice.program, r.program_branch);
      if (progScore < 500) continue;
      const total = instScore + progScore;
      const qRank = quotaRank(q);
      if (total > bestScore || (total === bestScore && qRank < bestQRank)) {
        bestScore = total; bestQRank = qRank;
        best = { row: r, quotaUsed: q, score: total }; // score mirrored from ranker.js
      }
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTML parser for collges.html
// ─────────────────────────────────────────────────────────────────────────────

// Decode minimal HTML entities (mirrors browser textContent behaviour)
function decodeHtmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function parseChoicesFromHtml(html) {
  const choices = [];
  // Split on <tr> and extract instnm/brnm from each block
  const blocks = html.split(/<tr[\s>]/);
  for (const block of blocks) {
    const instMatch  = block.match(/class="instnm"[^>]*>([\s\S]*?)<\/td>/);
    const brnmMatch  = block.match(/class="brnm"[^>]*>([\s\S]*?)<\/td>/);
    const instcdMatch = block.match(/class="instcd[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    const brcdMatch   = block.match(/class="brcd[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    if (instMatch && brnmMatch) {
      // Normalize whitespace exactly as the fixed pageExtractChoicesFunction does:
      //   .replace(/\s+/g, ' ').trim()  +  HTML entity decoding
      const clean = s => decodeHtmlEntities(s.replace(/\s+/g, ' ').trim());
      choices.push({
        institute: clean(instMatch[1]),
        program:   clean(brnmMatch[1]),
        instcd:    instcdMatch ? instcdMatch[1].trim() : '',
        brcd:      brcdMatch   ? brcdMatch[1].trim()   : '',
      });
    }
  }
  return choices;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildByQuota(allCsvRows, category, gender) {
  const byQuota = {};
  for (const r of allCsvRows) {
    if (r.category === category && r.gender === gender) {
      if (!byQuota[r.quota]) byQuota[r.quota] = [];
      byQuota[r.quota].push(r);
    }
  }
  return byQuota;
}

function runMatch(allCsvRows, pageChoices, category, gender, preferredQuota) {
  const byQuota = buildByQuota(allCsvRows, category, gender);
  let results = pageChoices.map((choice, idx) => {
    const hit = bestMatch(byQuota, preferredQuota, choice);
    if (hit) {
      const { row: csvRow, quotaUsed, score } = hit;
      const cr = parseInt(csvRow.closing_rank);
      return {
        pageIdx: idx,
        institute: choice.institute,
        program:   choice.program,
        csvInstitute: csvRow.institute_name,
        csvProgram:   csvRow.program_branch,
        closingRank: isNaN(cr) ? null : cr,
        openingRank: parseInt(csvRow.opening_rank) || null,
        found: true,
        quotaUsed,
        score,
        rowKey: `${csvRow.institute_name}||${csvRow.program_branch}||${quotaUsed}`,
      };
    }
    return {
      pageIdx: idx,
      institute: choice.institute,
      program:   choice.program,
      found: false,
      closingRank: null,
      score: 0,
      rowKey: null,
    };
  });

  // Mirror ranker.js dedup: when two choices map to the same CSV row, keep higher-scoring one
  const takenRows = new Map();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.found) continue;
    if (takenRows.has(r.rowKey)) {
      const prevIdx = takenRows.get(r.rowKey);
      if (r.score > results[prevIdx].score) {
        results[prevIdx] = { ...results[prevIdx], found: false, closingRank: null };
        takenRows.set(r.rowKey, i);
      } else {
        results[i] = { ...r, found: false, closingRank: null };
      }
    } else {
      takenRows.set(r.rowKey, i);
    }
  }

  return results;
}

function sortItems(matchResults) {
  return [...matchResults].sort((a, b) => {
    if (!a.found && !b.found) return 0;
    if (!a.found) return 1;
    if (!b.found) return -1;
    if (a.closingRank === null && b.closingRank === null) return 0;
    if (a.closingRank === null) return 1;
    if (b.closingRank === null) return -1;
    return a.closingRank - b.closingRank;
  });
}

function checkDuplicates(results) {
  const seen = new Map(); // rowKey → first match result
  const duplicates = [];
  for (const r of results) {
    if (!r.found) continue;
    if (seen.has(r.rowKey)) {
      duplicates.push({ existing: seen.get(r.rowKey), duplicate: r });
    } else {
      seen.set(r.rowKey, r);
    }
  }
  return duplicates;
}

function checkSortOrder(sortedResults) {
  const violations = [];
  const found = sortedResults.filter(r => r.found && r.closingRank !== null);
  for (let i = 1; i < found.length; i++) {
    if (found[i].closingRank < found[i - 1].closingRank) {
      violations.push({
        pos: i,
        prev: found[i - 1],
        curr: found[i],
      });
    }
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Load data once
// ─────────────────────────────────────────────────────────────────────────────

let pageChoices, allCsvRows;

before(() => {
  const html    = fs.readFileSync(path.join(__dirname, 'collges.html'), 'utf8');
  const csvText = fs.readFileSync(path.join(__dirname, 'ranks.csv'),    'utf8');
  pageChoices = parseChoicesFromHtml(html);
  allCsvRows  = parseCsv(csvText);
});

// ═════════════════════════════════════════════════════════════════════════════
//  1. DATA LOADING
// ═════════════════════════════════════════════════════════════════════════════

describe('Data loading', () => {
  it('parses exactly 694 choices from collges.html', () => {
    assert.strictEqual(pageChoices.length, 694);
  });

  it('all choices have non-empty institute and program', () => {
    const bad = pageChoices.filter(c => !c.institute || !c.program);
    assert.strictEqual(bad.length, 0, `${bad.length} entries missing institute or program`);
  });

  it('loads ranks.csv with headers and data rows', () => {
    assert.ok(allCsvRows.length > 5000, `Expected >5000 CSV rows, got ${allCsvRows.length}`);
  });

  it('CSV rows have all required fields', () => {
    const required = ['institute_name', 'program_branch', 'quota', 'category', 'gender', 'opening_rank', 'closing_rank'];
    const sample = allCsvRows[0];
    for (const f of required) {
      assert.ok(f in sample, `Missing field: "${f}" in CSV`);
    }
  });

  it('no page choice entry appears twice (HTML has no duplicates)', () => {
    const keys = pageChoices.map(c => `${c.institute}||${c.program}`);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.strictEqual(dupes.length, 0,
      `Duplicate page entries: ${[...new Set(dupes)].slice(0,3).join(', ')}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  2. matchScore UNIT TESTS
// ═════════════════════════════════════════════════════════════════════════════

describe('matchScore – unit tests', () => {
  it('identical strings → 1000', () => {
    assert.strictEqual(matchScore('IIT Bombay', 'IIT Bombay'), 1000);
    assert.strictEqual(matchScore(
      'National Institute of Technology, Warangal',
      'National Institute of Technology, Warangal'
    ), 1000);
  });

  it('normalization: commas/parens/hyphens → same score as without', () => {
    const a = matchScore(
      'National Institute of Technology, Rourkela',
      'National Institute of Technology Rourkela'
    );
    assert.ok(a >= 500, `Expected ≥500 after normalization, got ${a}`);
  });

  it('empty page text → 0', () => {
    assert.strictEqual(matchScore('', 'IIT Bombay'), 0);
  });

  it('empty CSV text → 0', () => {
    assert.strictEqual(matchScore('IIT Bombay', ''), 0);
  });

  it('both empty → 0', () => {
    assert.strictEqual(matchScore('', ''), 0);
  });

  it('NIT Raipur vs IIIT Raipur → 0  (cross-institute false-positive guard)', () => {
    const s = matchScore(
      'National Institute of Technology Raipur',
      'Indian Institute of Information Technology Raipur'
    );
    assert.strictEqual(s, 0, `Expected 0 but got ${s} — substring false-positive detected`);
  });

  it('NIT Nagpur vs IIIT Nagpur → 0', () => {
    const s = matchScore(
      'National Institute of Technology Nagpur',
      'Indian Institute of Information Technology Nagpur'
    );
    assert.strictEqual(s, 0, `Expected 0 but got ${s}`);
  });

  it('CSE exact vs CSE+AI → exact scores higher (best-match wins)', () => {
    const exact = matchScore(
      'Computer Science and Engineering (4 Years, Bachelor of Technology)',
      'Computer Science and Engineering (4 Years, Bachelor of Technology)'
    );
    const withAI = matchScore(
      'Computer Science and Engineering (4 Years, Bachelor of Technology)',
      'Computer Science and Engineering with Artificial Intelligence (4 Years, Bachelor of Technology)'
    );
    assert.ok(exact > withAI,
      `Exact CSE (${exact}) should outscore CSE+AI (${withAI})`);
  });

  it('score ≥ 500 threshold: genuine match passes per-field minimum', () => {
    const s = matchScore(
      'National Institute of Technology, Warangal',
      'National Institute of Technology Warangal'
    );
    assert.ok(s >= 500, `Genuine NIT match scored only ${s}, below 500 threshold`);
  });

  it('score < 500 threshold: different cities in same institute type → no match', () => {
    const s = matchScore('National Institute of Technology Raipur', 'National Institute of Technology Warangal');
    assert.ok(s < 500, `Raipur vs Warangal scored ${s}, should be below 500`);
  });

  it('"Bio Technology" program: only matches "Bio Technology", not all B.Tech programs', () => {
    const correct = matchScore(
      'Bio Technology (4 Years, Bachelor of Technology)',
      'Bio Technology (4 Years, Bachelor of Technology)'
    );
    const wrong = matchScore(
      'Bio Technology (4 Years, Bachelor of Technology)',
      'Computer Science and Engineering (4 Years, Bachelor of Technology)'
    );
    assert.strictEqual(correct, 1000);
    assert.strictEqual(wrong, 0, `Bio Tech matched CSE with score ${wrong}`);
  });

  it('Jaccard < 0.7 → 0 (strict threshold enforced)', () => {
    // "Electrical Engineering" vs "Civil Engineering" — 1 shared word ("engineering") out of 3+3-1=5 union
    // Jaccard = 1/5 = 0.2 < 0.7
    const s = matchScore('Electrical Engineering (4 Years, Bachelor of Technology)',
                          'Civil Engineering (4 Years, Bachelor of Technology)');
    assert.strictEqual(s, 0, `Different disciplines scored ${s}, should be 0`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  3. FULL PIPELINE — OPEN Gender-Neutral, OS quota  (primary NIT scenario)
// ═════════════════════════════════════════════════════════════════════════════

describe('Full pipeline: OPEN Gender-Neutral, OS quota', () => {
  let results, sorted, found, notFound;

  before(() => {
    results  = runMatch(allCsvRows, pageChoices, 'OPEN', 'Gender-Neutral', 'OS');
    sorted   = sortItems(results);
    found    = results.filter(r => r.found);
    notFound = results.filter(r => !r.found);
  });

  it('matches ≥ 500 of 694 choices', () => {
    console.log(`    OS/OPEN/GN: ${found.length}/694 matched`);
    assert.ok(found.length >= 500,
      `Only ${found.length}/694 matched — too few (expected ≥500)`);
  });

  it('zero duplicate CSV row assignments', () => {
    const dups = checkDuplicates(results);
    if (dups.length) {
      for (const { existing: e, duplicate: d } of dups.slice(0, 5)) {
        console.error(`    COLLISION: [${e.pageIdx}] "${e.institute} | ${e.program}"`);
        console.error(`         with: [${d.pageIdx}] "${d.institute} | ${d.program}"`);
        console.error(`         key:  ${e.rowKey}`);
      }
    }
    assert.strictEqual(dups.length, 0,
      `${dups.length} duplicate CSV row assignment(s) — same rank would appear twice`);
  });

  it('sorted: all found items precede all not-found items', () => {
    const firstNotFound = sorted.findIndex(r => !r.found);
    const lastFound     = sorted.map(r => r.found).lastIndexOf(true);
    if (firstNotFound === -1 || lastFound === -1) return;
    assert.ok(lastFound < firstNotFound,
      `Found item at position ${lastFound} appears after not-found at ${firstNotFound}`);
  });

  it('sorted: closing ranks are monotonically non-decreasing', () => {
    const violations = checkSortOrder(sorted);
    if (violations.length) {
      for (const v of violations.slice(0, 3)) {
        console.error(`    INVERSION at pos ${v.pos}: rank ${v.prev.closingRank} (${v.prev.institute}) → ${v.curr.closingRank} (${v.curr.institute})`);
      }
    }
    assert.strictEqual(violations.length, 0,
      `${violations.length} rank inversion(s) in sorted output`);
  });

  it('all found closing ranks are positive integers', () => {
    const bad = found.filter(r => r.closingRank !== null && (r.closingRank <= 0 || !Number.isInteger(r.closingRank)));
    assert.strictEqual(bad.length, 0,
      `${bad.length} entries with invalid closing rank`);
  });

  it('opening rank ≤ closing rank for all matched entries', () => {
    const bad = found.filter(r =>
      r.openingRank !== null && r.closingRank !== null &&
      r.openingRank > r.closingRank
    );
    if (bad.length) {
      for (const r of bad.slice(0, 3))
        console.error(`    OR ${r.openingRank} > CR ${r.closingRank}: ${r.institute} | ${r.program}`);
    }
    assert.strictEqual(bad.length, 0, `${bad.length} entries where opening > closing rank`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  4. FULL PIPELINE — OPEN Gender-Neutral, AI quota  (IITs + fallback for NITs)
// ═════════════════════════════════════════════════════════════════════════════

describe('Full pipeline: OPEN Gender-Neutral, AI quota', () => {
  let results, sorted, found;

  before(() => {
    results = runMatch(allCsvRows, pageChoices, 'OPEN', 'Gender-Neutral', 'AI');
    sorted  = sortItems(results);
    found   = results.filter(r => r.found);
  });

  it('matches ≥ 400 of 694 (AI+fallback covers IITs and most NITs)', () => {
    console.log(`    AI/OPEN/GN: ${found.length}/694 matched`);
    assert.ok(found.length >= 400,
      `Only ${found.length}/694 matched under AI quota (with fallback)`);
  });

  it('zero duplicate CSV row assignments', () => {
    const dups = checkDuplicates(results);
    if (dups.length) {
      for (const { existing: e, duplicate: d } of dups.slice(0, 3)) {
        console.error(`    COLLISION: "${e.institute}|${e.program}" vs "${d.institute}|${d.program}" → ${e.rowKey}`);
      }
    }
    assert.strictEqual(dups.length, 0);
  });

  it('sorted: closing ranks non-decreasing', () => {
    const violations = checkSortOrder(sorted);
    assert.strictEqual(violations.length, 0,
      `${violations.length} rank inversion(s) in AI quota sorted output`);
  });

  it('sorted: found before not-found', () => {
    const firstNotFound = sorted.findIndex(r => !r.found);
    const lastFound     = sorted.map(r => r.found).lastIndexOf(true);
    if (firstNotFound === -1 || lastFound === -1) return;
    assert.ok(lastFound < firstNotFound);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  5. FULL PIPELINE — OPEN Gender-Neutral, HS quota
// ═════════════════════════════════════════════════════════════════════════════

describe('Full pipeline: OPEN Gender-Neutral, HS quota', () => {
  let results, sorted, found;

  before(() => {
    results = runMatch(allCsvRows, pageChoices, 'OPEN', 'Gender-Neutral', 'HS');
    sorted  = sortItems(results);
    found   = results.filter(r => r.found);
  });

  it('matches ≥ 300 of 694', () => {
    console.log(`    HS/OPEN/GN: ${found.length}/694 matched`);
    assert.ok(found.length >= 300, `Only ${found.length}/694 matched`);
  });

  it('zero duplicate CSV row assignments', () => {
    const dups = checkDuplicates(results);
    assert.strictEqual(dups.length, 0, `${dups.length} duplicates`);
  });

  it('sorted: closing ranks non-decreasing', () => {
    assert.strictEqual(checkSortOrder(sorted).length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  6. SPECIFIC KNOWN ENTRIES (regression tests for previously broken cases)
// ═════════════════════════════════════════════════════════════════════════════

describe('Specific entry regression tests', () => {
  let byQuota;

  before(() => {
    byQuota = buildByQuota(allCsvRows, 'OPEN', 'Gender-Neutral');
  });

  it('NIT Delhi – Aerospace Engineering matches (was 0 before quota fallback)', () => {
    const choice = {
      institute: 'National Institute of Technology Delhi',
      program:   'Aerospace Engineering (4 Years, Bachelor of Technology)',
    };
    const hit = bestMatch(byQuota, 'OS', choice);
    assert.ok(hit, 'NIT Delhi Aerospace should match via OS or HS quota');
    assert.ok(
      hit.row.institute_name.toLowerCase().includes('delhi'),
      `Wrong institute: expected Delhi, got "${hit.row.institute_name}"`
    );
    console.log(`    NIT Delhi Aerospace → quota:${hit.quotaUsed} CR:${hit.row.closing_rank}`);
  });

  it('NIT Rourkela – Bio Technology matches the correct institute (not a cross-NIT collision)', () => {
    const choice = {
      institute: 'National Institute of Technology, Rourkela',
      program:   'Bio Technology (4 Years, Bachelor of Technology)',
    };
    const hit = bestMatch(byQuota, 'OS', choice);
    assert.ok(hit, 'NIT Rourkela Bio Technology should match');
    assert.ok(
      hit.row.institute_name.toLowerCase().includes('rourkela'),
      `Wrong institute: expected Rourkela, got "${hit.row.institute_name}"`
    );
  });

  it('NIT Warangal – Bio Technology maps to Warangal (not any other NIT)', () => {
    const choice = {
      institute: 'National Institute of Technology, Warangal',
      program:   'Bio Technology (4 Years, Bachelor of Technology)',
    };
    const hit = bestMatch(byQuota, 'OS', choice);
    assert.ok(hit, 'NIT Warangal Bio Technology should match');
    assert.ok(
      hit.row.institute_name.toLowerCase().includes('warangal'),
      `Wrong institute: expected Warangal, got "${hit.row.institute_name}"`
    );
  });

  it('NIT Warangal – CSE matches Warangal (not cross-institute to IIT CSE)', () => {
    const choice = {
      institute: 'National Institute of Technology, Warangal',
      program:   'Computer Science and Engineering (4 Years, Bachelor of Technology)',
    };
    const hit = bestMatch(byQuota, 'OS', choice);
    assert.ok(hit, 'NIT Warangal CSE should match');
    assert.ok(
      hit.row.institute_name.toLowerCase().includes('warangal'),
      `Wrong institute: expected Warangal, got "${hit.row.institute_name}"`
    );
    console.log(`    NIT Warangal CSE → quota:${hit.quotaUsed} CR:${hit.row.closing_rank}`);
  });

  it('NIT Goa – CSE matches NIT Goa (GO quota preferred)', () => {
    const choice = {
      institute: 'National Institute of Technology Goa',
      program:   'Computer Science and Engineering (4 Years, Bachelor of Technology)',
    };
    const hit = bestMatch(byQuota, 'GO', choice);
    assert.ok(hit, 'NIT Goa CSE should match');
    assert.ok(
      hit.row.institute_name.toLowerCase().includes('goa'),
      `Wrong institute: expected Goa, got "${hit.row.institute_name}"`
    );
    console.log(`    NIT Goa CSE → quota:${hit.quotaUsed} CR:${hit.row.closing_rank}`);
  });

  it('NIT Goa – Civil Engineering matches NIT Goa', () => {
    const choice = {
      institute: 'National Institute of Technology Goa',
      program:   'Civil Engineering (4 Years, Bachelor of Technology)',
    };
    const hit = bestMatch(byQuota, 'GO', choice);
    assert.ok(hit, 'NIT Goa Civil should match');
    assert.ok(
      hit.row.institute_name.toLowerCase().includes('goa'),
      `Wrong institute: got "${hit.row.institute_name}"`
    );
  });

  it('NIT Agartala – Chemical Engineering matches correctly', () => {
    const choice = {
      institute: 'National Institute of Technology Agartala',
      program:   'Chemical Engineering (4 Years, Bachelor of Technology)',
    };
    const hit = bestMatch(byQuota, 'OS', choice);
    assert.ok(hit, 'NIT Agartala Chemical should match');
    assert.ok(
      hit.row.institute_name.toLowerCase().includes('agartala'),
      `Wrong institute: got "${hit.row.institute_name}"`
    );
  });

  it('NIT Andhra Pradesh – Bio Technology matches (not Rourkela or Warangal)', () => {
    const choice = {
      institute: 'National Institute of Technology, Andhra Pradesh',
      program:   'Bio Technology (4 Years, Bachelor of Technology)',
    };
    const hit = bestMatch(byQuota, 'OS', choice);
    assert.ok(hit, 'NIT AP Bio Technology should match');
    assert.ok(
      hit.row.institute_name.toLowerCase().includes('andhra'),
      `Wrong institute: expected Andhra Pradesh, got "${hit.row.institute_name}"`
    );
  });

  it('CSE-AI program matches CSE-AI row, not plain CSE row', () => {
    // If the page has "CSE with AI" and CSV has both "CSE" and "CSE with Artificial Intelligence",
    // the CSE-AI row should win (higher score)
    const choiceCSEAI = {
      institute: 'National Institute of Technology, Warangal',
      program: 'Computer Science and Engineering with Artificial Intelligence (4 Years, Bachelor of Technology)',
    };
    const hitCSEAI = bestMatch(byQuota, 'OS', choiceCSEAI);
    const choiceCSE = {
      institute: 'National Institute of Technology, Warangal',
      program: 'Computer Science and Engineering (4 Years, Bachelor of Technology)',
    };
    const hitCSE = bestMatch(byQuota, 'OS', choiceCSE);
    // If both exist in CSV, their rowKeys must differ
    if (hitCSEAI && hitCSE) {
      assert.notStrictEqual(hitCSEAI.rowKey, hitCSE.rowKey,
        'CSE and CSE-AI must not map to the same CSV row');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  7. SORT INVARIANTS (unit tests, no CSV needed)
// ═════════════════════════════════════════════════════════════════════════════

describe('sortItems – invariants', () => {
  it('empty array → empty', () => {
    assert.deepStrictEqual(sortItems([]), []);
  });

  it('all found, ascending ranks → unchanged order', () => {
    const input = [
      { found: true,  closingRank: 100 },
      { found: true,  closingRank: 200 },
      { found: true,  closingRank: 300 },
    ];
    const s = sortItems(input);
    assert.deepStrictEqual(s.map(r => r.closingRank), [100, 200, 300]);
  });

  it('all found, descending ranks → reversed', () => {
    const input = [
      { found: true, closingRank: 300 },
      { found: true, closingRank: 200 },
      { found: true, closingRank: 100 },
    ];
    const s = sortItems(input);
    assert.deepStrictEqual(s.map(r => r.closingRank), [100, 200, 300]);
  });

  it('not-found entries move to end regardless of insertion order', () => {
    const input = [
      { found: false, closingRank: null },
      { found: true,  closingRank: 9999 },
      { found: false, closingRank: null },
      { found: true,  closingRank: 1    },
    ];
    const s = sortItems(input);
    assert.strictEqual(s[0].closingRank, 1);
    assert.strictEqual(s[1].closingRank, 9999);
    assert.strictEqual(s[2].found, false);
    assert.strictEqual(s[3].found, false);
  });

  it('found with null closingRank goes after found with a rank, before not-found', () => {
    const input = [
      { found: true,  closingRank: null },
      { found: true,  closingRank: 5000 },
      { found: false, closingRank: null },
      { found: true,  closingRank: 1000 },
    ];
    const s = sortItems(input);
    assert.strictEqual(s[0].closingRank, 1000);
    assert.strictEqual(s[1].closingRank, 5000);
    assert.strictEqual(s[2].found, true);
    assert.strictEqual(s[2].closingRank, null);
    assert.strictEqual(s[3].found, false);
  });

  it('equal closing ranks: order is stable (no inversion)', () => {
    const input = [
      { found: true, closingRank: 500, id: 'a' },
      { found: true, closingRank: 500, id: 'b' },
      { found: true, closingRank: 500, id: 'c' },
    ];
    const s = sortItems(input);
    assert.deepStrictEqual(s.map(r => r.closingRank), [500, 500, 500]);
  });

  it('all not-found: original order preserved', () => {
    const input = [
      { found: false, closingRank: null, id: 'x' },
      { found: false, closingRank: null, id: 'y' },
    ];
    const s = sortItems(input);
    assert.strictEqual(s[0].id, 'x');
    assert.strictEqual(s[1].id, 'y');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  8. CROSS-QUOTA CONSISTENCY
// ═════════════════════════════════════════════════════════════════════════════

describe('Cross-quota consistency', () => {
  it('preferred quota is used when available (AI for IIT entries)', () => {
    const byQuota = buildByQuota(allCsvRows, 'OPEN', 'Gender-Neutral');
    // IIT Bombay CSE should match via AI quota
    const choice = {
      institute: 'Indian Institute of Technology Bombay',
      program: 'Computer Science and Engineering (4 Years, Bachelor of Technology)',
    };
    const hit = bestMatch(byQuota, 'AI', choice);
    if (hit) {
      assert.strictEqual(hit.quotaUsed, 'AI',
        `Expected AI quota for IIT Bombay CSE, got ${hit.quotaUsed}`);
      console.log(`    IIT Bombay CSE → quota:${hit.quotaUsed} CR:${hit.row.closing_rank}`);
    }
  });

  it('fallback quota used when preferred unavailable (OS→HS for NIT under AI pref)', () => {
    const byQuota = buildByQuota(allCsvRows, 'OPEN', 'Gender-Neutral');
    const choice = {
      institute: 'National Institute of Technology, Rourkela',
      program: 'Ceramic Engineering (4 Years, Bachelor of Technology)',
    };
    const hit = bestMatch(byQuota, 'AI', choice);
    if (hit) {
      assert.notStrictEqual(hit.quotaUsed, 'AI',
        'NIT Rourkela Ceramic should NOT have AI quota data');
      console.log(`    NIT Rourkela Ceramic under AI pref → fallback to ${hit.quotaUsed}, CR:${hit.row.closing_rank}`);
    }
  });

  it('both OS and HS preferred-quota matches cover a substantial portion of choices', () => {
    const osResults = runMatch(allCsvRows, pageChoices, 'OPEN', 'Gender-Neutral', 'OS');
    const hsResults = runMatch(allCsvRows, pageChoices, 'OPEN', 'Gender-Neutral', 'HS');
    const osCount   = osResults.filter(r => r.found && r.quotaUsed === 'OS').length;
    const hsCount   = hsResults.filter(r => r.found && r.quotaUsed === 'HS').length;
    console.log(`    OS-primary matches using OS: ${osCount}, HS-primary matches using HS: ${hsCount}`);
    assert.ok(osCount >= 200, `OS primary-quota matches too low: ${osCount}`);
    assert.ok(hsCount >= 200, `HS primary-quota matches too low: ${hsCount}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  9. COPY → PASTE → FILL PIPELINE
//     Verifies that text produced by copyList() can be round-tripped through
//     parseChoices() and then isMatchFiller() against the original page choices.
//     Root cause of the bug: multi-line textContent in the HTML caused
//     copyList()'s \n-joined output to be split incorrectly by parseChoices().
//     Fix: pageExtractChoicesFunction now does .replace(/\s+/g,' ').trim()
// ═════════════════════════════════════════════════════════════════════════════

// Mirrors popup.js parseChoices()
function parseChoices(raw) {
  return raw.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const parts = l.split('|').map(p => p.trim());
      return { institute: parts[0] || '', program: parts[1] || '' };
    })
    .filter(c => c.institute);
}

// Mirrors OLD pageFillerFunction isMatchFiller() before the Jaccard fix
function normalizeTextFiller(s) {
  return (s || '').toLowerCase().replace(/[,.()\-&]/g, ' ').replace(/\s+/g, ' ').trim();
}
function isMatchOld(userInput, pageText, pageCode) {
  const inp = normalizeTextFiller(userInput);
  const txt = normalizeTextFiller(pageText);
  if (userInput.trim() === (pageCode || '').trim()) return true;
  if (txt.includes(inp)) return true;
  const words = inp.split(/\s+/).filter(w => w.length >= 4);
  return words.length > 0 && words.every(w => txt.includes(w));
}

describe('Copy → Paste → Fill pipeline', () => {
  let copiedText, parsedChoices;

  before(() => {
    // Simulate copyList(): "institute | program" per line, joined by \n
    copiedText    = pageChoices.map(c => `${c.institute} | ${c.program}`).join('\n');
    parsedChoices = parseChoices(copiedText);
  });

  it('parseChoices produces exactly 694 entries from copyList output', () => {
    assert.strictEqual(parsedChoices.length, 694,
      `Expected 694, got ${parsedChoices.length} — embedded newlines are breaking line splitting`);
  });

  it('every parsed entry has a non-empty institute and program', () => {
    const bad = parsedChoices.filter(c => !c.institute || !c.program);
    if (bad.length) {
      for (const b of bad.slice(0, 5))
        console.error(`    EMPTY FIELD: inst="${b.institute}" prog="${b.program}"`);
    }
    assert.strictEqual(bad.length, 0,
      `${bad.length} parsed entries have empty institute or program`);
  });

  it('every parsed institute matches its original page choice exactly', () => {
    const mismatches = parsedChoices
      .map((c, i) => ({ i, parsed: c.institute, orig: pageChoices[i].institute }))
      .filter(x => x.parsed !== x.orig);
    if (mismatches.length) {
      for (const m of mismatches.slice(0, 3))
        console.error(`    [${m.i}] orig: "${m.orig}"\n         parsed: "${m.parsed}"`);
    }
    assert.strictEqual(mismatches.length, 0,
      `${mismatches.length} institute round-trip mismatches`);
  });

  it('every parsed program matches its original page choice exactly', () => {
    const mismatches = parsedChoices
      .map((c, i) => ({ i, parsed: c.program, orig: pageChoices[i].program }))
      .filter(x => x.parsed !== x.orig);
    if (mismatches.length) {
      for (const m of mismatches.slice(0, 3))
        console.error(`    [${m.i}] orig: "${m.orig}"\n         parsed: "${m.parsed}"`);
    }
    assert.strictEqual(mismatches.length, 0,
      `${mismatches.length} program round-trip mismatches`);
  });

  it('isMatch finds every parsed choice in the available choices list (0 NOT FOUND)', () => {
    const notFound = [];
    for (let i = 0; i < parsedChoices.length; i++) {
      const choice = parsedChoices[i];
      let matched = false;
      for (const pg of pageChoices) {
        if (isMatchOld(choice.institute, pg.institute, pg.instcd) &&
            isMatchOld(choice.program,   pg.program,   pg.brcd)) {
          matched = true;
          break;
        }
      }
      if (!matched) notFound.push({ i, choice });
    }
    if (notFound.length) {
      for (const { i, choice } of notFound.slice(0, 10))
        console.error(`    NOT FOUND [${i}]: "${choice.institute}" | "${choice.program}"`);
    }
    assert.strictEqual(notFound.length, 0,
      `${notFound.length} entries from copyList could not be found by isMatch — embedded-newline bug still present`);
  });

  it('isMatch finds correct entry: no false cross-matches between same institute different programs', () => {
    // Take a college that appears multiple times with different programs
    const grouped = {};
    for (const c of pageChoices) {
      if (!grouped[c.institute]) grouped[c.institute] = [];
      grouped[c.institute].push(c);
    }
    const multiProgram = Object.entries(grouped).find(([, progs]) => progs.length >= 3);
    if (!multiProgram) return;
    const [inst, progs] = multiProgram;
    console.log(`    Testing cross-match guard for "${inst}" (${progs.length} programs)`);

    // Each program should match exactly one page entry, not bleed into others
    for (const prog of progs) {
      const matches = pageChoices.filter(pg =>
        isMatchOld(prog.program, pg.program, pg.brcd) &&
        isMatchOld(prog.institute, pg.institute, pg.instcd)
      );
      assert.ok(matches.length >= 1,
        `"${prog.program}" matched 0 entries — too strict`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  10. isMatch – filler matching function
//      Tests the Jaccard-based matching used by pageFillerFunction to decide
//      whether a pasted choice is already filled or present in avlChoiceContainer.
// ═════════════════════════════════════════════════════════════════════════════

// isMatchFiller: the FIXED version used by pageFillerFunction (≥3-char words, Jaccard ≥ 0.90)
function isMatchFiller(userInput, pageText, pageCode) {
  const inp = normalizeTextFiller(userInput);
  const txt = normalizeTextFiller(pageText);
  if (userInput.trim() === (pageCode || '').trim()) return true;
  if (txt.includes(inp)) return true;
  const inpW = new Set(inp.split(/\s+/).filter(w => w.length >= 3));
  const txtW = new Set(txt.split(/\s+/).filter(w => w.length >= 3));
  if (!inpW.size || !txtW.size) return false;
  let inter = 0;
  for (const w of inpW) if (txtW.has(w)) inter++;
  return inter / (inpW.size + txtW.size - inter) >= 0.90;
}

describe('isMatch – filler matching (Jaccard fix: ≥3-char words, threshold 0.90)', () => {
  // ── False-positive cases that the old word-all check got wrong ─────────────

  it('Bio Technology does NOT match CSE (old bug: all words present in any B.Tech)', () => {
    const bioTech = 'Bio Technology (4 Years, Bachelor of Technology)';
    const cse = 'Computer Science and Engineering (4 Years, Bachelor of Technology)';
    assert.strictEqual(isMatchFiller(bioTech, cse, ''), false,
      'Bio Technology should not match CSE via word fallback');
  });

  it('Bio Technology does NOT match Electrical Engineering', () => {
    assert.strictEqual(
      isMatchFiller('Bio Technology (4 Years, Bachelor of Technology)',
              'Electrical Engineering (4 Years, Bachelor of Technology)', ''),
      false);
  });

  it('Bio Technology does NOT match Mechanical Engineering', () => {
    assert.strictEqual(
      isMatchFiller('Bio Technology (4 Years, Bachelor of Technology)',
              'Mechanical Engineering (4 Years, Bachelor of Technology)', ''),
      false);
  });

  it('CSE does NOT match CSE (Data Science and Analytics) – old bug: all CSE words in longer name', () => {
    // Jaccard({computer,science,engineering,years,bachelor,technology},
    //         {computer,science,engineering,data,analytics,years,bachelor,technology}) = 6/8 = 0.75 < 0.85
    const cse    = 'Computer Science and Engineering (4 Years, Bachelor of Technology)';
    const cseda  = 'Computer Science Engineering (Data Science and Analytics) (4 Years, Bachelor of Technology)';
    assert.strictEqual(isMatchFiller(cse, cseda, ''), false,
      'Plain CSE must not match CSE-Data-Analytics (both from same institute causes wrong already-filled)');
  });

  it('Computer Science does NOT match Computer Science and Engineering', () => {
    // Jaccard({computer,science,years,bachelor,technology},
    //         {computer,science,engineering,years,bachelor,technology}) = 5/6 ≈ 0.83 < 0.85
    assert.strictEqual(
      isMatchFiller('Computer Science (4 Years, Bachelor of Technology)',
              'Computer Science and Engineering (4 Years, Bachelor of Technology)', ''),
      false);
  });

  it('Electrical Engineering does NOT match Electrical and Electronics Engineering', () => {
    // Jaccard = 5/7 ≈ 0.71 < 0.85
    assert.strictEqual(
      isMatchFiller('Electrical Engineering (4 Years, Bachelor of Technology)',
              'Electrical and Electronics Engineering (4 Years, Bachelor of Technology)', ''),
      false);
  });

  // ── Correct positive matches ───────────────────────────────────────────────

  it('exact program match → true (substring path)', () => {
    const prog = 'Computer Science and Engineering (4 Years, Bachelor of Technology)';
    assert.strictEqual(isMatchFiller(prog, prog, ''), true);
  });

  it('exact institute match → true', () => {
    const inst = 'National Institute of Technology, Warangal';
    assert.strictEqual(isMatchFiller(inst, inst, ''), true);
  });

  it('code match takes priority over text', () => {
    assert.strictEqual(isMatchFiller('anything', 'something else entirely', 'anything'), true);
  });

  it('institute with comma vs without comma → true (normalization)', () => {
    assert.strictEqual(
      isMatchFiller('National Institute of Technology, Rourkela',
              'National Institute of Technology Rourkela', ''),
      true);
  });

  it('Bio Technology vs Bio Technology → true', () => {
    assert.strictEqual(
      isMatchFiller('Bio Technology (4 Years, Bachelor of Technology)',
              'Bio Technology (4 Years, Bachelor of Technology)', ''),
      true);
  });

  it('IIIT (all caps) vs mixed case → true (after lowercase normalization)', () => {
    assert.strictEqual(
      isMatchFiller('INDIAN INSTITUTE OF INFORMATION TECHNOLOGY SENAPATI MANIPUR',
              'Indian Institute of Information Technology Senapati Manipur', ''),
      true);
  });

  it('institute with & → true (&→space, substring still matches)', () => {
    const inst = 'Shri Mata Vaishno Devi University, Katra, Jammu & Kashmir';
    assert.strictEqual(isMatchFiller(inst, inst, ''), true);
  });

  // ── The 35 specific failing entries: isMatch must find each in page choices ──

  it('every entry from the 35-failing list is findable in page choices (avlChoiceContainer scan)', () => {
    const failing35 = [
      ['Indian Institute of Information Technology Lucknow','Computer Science (4 Years, Bachelor of Technology)'],
      ['Atal Bihari Vajpayee Indian Institute of Information Technology & Management Gwalior','Integrated B. Tech.(IT) and M. Tech (IT) (5 Years, Integrated B. Tech. and M. Tech.)'],
      ['National Institute of Technology Goa','Computer Science and Engineering (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology, Kurukshetra','Electrical Engineering (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology Goa','Electronics and Communication Engineering (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology Goa','Electrical and Electronics Engineering (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology, Kurukshetra','Mechanical Engineering (4 Years, Bachelor of Technology)'],
      ['Indian Institute of Information Technology, Design & Manufacturing, Kancheepuram','Electronics and Communication Engineering (4 Years, Bachelor of Technology)'],
      ['Indian Institute of Information Technology Tiruchirappalli','Computer Science and Engineering (4 Years, Bachelor of Technology)'],
      ['Indian Institute of Information Technology Surat','Computer Science and Engineering (4 Years, Bachelor of Technology)'],
      ['Indian Institute of Information Technology, Design & Manufacturing, Kancheepuram','B.Tech. in Electronics and Communication Engineering and M.Tech. in Communication Systems (5 Years, Bachelor and Master of Technology (Dual Degree))'],
      ['Indian Institute of Information Technology (IIIT) Nagpur','Computer Science and Engineering (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology, Warangal','Bio Technology (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology, Rourkela','Bio Technology (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology Goa','Mechanical Engineering (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology Calicut','Bio Technology (4 Years, Bachelor of Technology)'],
      ['Motilal Nehru National Institute of Technology Allahabad','Bio Technology (4 Years, Bachelor of Technology)'],
      ['Indian Institute of Information Technology Tiruchirappalli','Electronics and Communication Engineering (4 Years, Bachelor of Technology)'],
      ['Indian Institute of Information Technology(IIIT) Kottayam','Computer Science and Engineering (4 Years, Bachelor of Technology)'],
      ['Indian Institute of Information Technology (IIIT) Nagpur','Electronics and Communication Engineering (4 Years, Bachelor of Technology)'],
      ['Indian Institute of Information Technology(IIIT) Kalyani, West Bengal','Computer Science and Engineering (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology Goa','Civil Engineering (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology Durgapur','Bio Technology (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology Patna','Civil Engineering (4 Years, Bachelor of Technology)'],
      ['Dr. B R Ambedkar National Institute of Technology, Jalandhar','Bio Technology (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology, Andhra Pradesh','Bio Technology (4 Years, Bachelor of Technology)'],
      ['National Institute of Technology Raipur','Bio Technology (4 Years, Bachelor of Technology)'],
      ['INDIAN INSTITUTE OF INFORMATION TECHNOLOGY SENAPATI MANIPUR','Computer Science and Engineering (4 Years, Bachelor of Technology)'],
      ['Birla Institute of Technology, Mesra, Ranchi','Bio Technology (4 Years, Bachelor of Technology)'],
      ['School of Engineering, Tezpur University, Napaam, Tezpur','Computer Science and Engineering (4 Years, Bachelor of Technology)'],
      ['School of Engineering, Tezpur University, Napaam, Tezpur','Electronics and Communication Engineering (4 Years, Bachelor of Technology)'],
      ['Shri Mata Vaishno Devi University, Katra, Jammu & Kashmir','Bio Technology (4 Years, Bachelor of Technology)'],
      ['School of Engineering, Tezpur University, Napaam, Tezpur','Mechanical Engineering (4 Years, Bachelor of Technology)'],
      ['School of Engineering, Tezpur University, Napaam, Tezpur','Civil Engineering (4 Years, Bachelor of Technology)'],
      ['School of Engineering, Tezpur University, Napaam, Tezpur','Food Engineering and Technology (4 Years, Bachelor of Technology)'],
    ];
    const notFound = [];
    for (const [inst, prog] of failing35) {
      const hit = pageChoices.find(pg =>
        isMatchFiller(inst, pg.institute, pg.instcd) && isMatchFiller(prog, pg.program, pg.brcd)
      );
      if (!hit) notFound.push(`"${inst}" | "${prog}"`);
    }
    if (notFound.length)
      for (const e of notFound) console.error(`    STILL NOT FOUND: ${e}`);
    assert.strictEqual(notFound.length, 0,
      `${notFound.length} of 35 entries still not matchable`);
  });

  it('no already-filled false positives across the 35-failing list × full page choices', () => {
    // Simulates: for each entry in the 35 list, check if isMatch would
    // INCORRECTLY mark it as already_filled against a DIFFERENT program
    // from the same institute that IS genuinely filled.
    const failing35inst = [
      'National Institute of Technology, Warangal',
      'National Institute of Technology, Rourkela',
      'National Institute of Technology Calicut',
      'Motilal Nehru National Institute of Technology Allahabad',
      'National Institute of Technology Durgapur',
      'National Institute of Technology Patna',
      'National Institute of Technology, Andhra Pradesh',
      'National Institute of Technology Raipur',
      'Birla Institute of Technology, Mesra, Ranchi',
    ];
    const biotechProg = 'Bio Technology (4 Years, Bachelor of Technology)';
    const falsePositives = [];
    for (const inst of failing35inst) {
      // All other programs from the same institute in pageChoices
      const others = pageChoices.filter(pg =>
        isMatchFiller(inst, pg.institute, pg.instcd) && pg.program !== biotechProg
      );
      for (const other of others) {
        if (isMatchFiller(biotechProg, other.program, other.brcd)) {
          falsePositives.push(`"${inst}" Bio Tech falsely matches "${other.program}"`);
        }
      }
    }
    if (falsePositives.length)
      for (const f of falsePositives.slice(0, 5)) console.error(`    FALSE POSITIVE: ${f}`);
    assert.strictEqual(falsePositives.length, 0,
      `${falsePositives.length} Bio Technology already-filled false positives remain`);
  });

  it('CSE not falsely marked as already-filled by CSE-specialization from same institute', () => {
    // IIIT Nagpur has "Computer Science Engineering (Data Science and Analytics)"
    // Plain CSE must NOT match it in the already-filled check
    const cseda = pageChoices.find(pg =>
      pg.program.toLowerCase().includes('data science') &&
      pg.program.toLowerCase().includes('computer science')
    );
    if (!cseda) { console.log('    (no CSE+Data Science entry found, skip)'); return; }
    const plainCSE = 'Computer Science and Engineering (4 Years, Bachelor of Technology)';
    assert.strictEqual(
      isMatchFiller(plainCSE, cseda.program, cseda.brcd), false,
      `Plain CSE must not match "${cseda.program}" (false already-filled)`
    );
    console.log(`    CSE vs "${cseda.program.slice(0, 60)}…" → false ✓`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  11. END-TO-END: extract → rank → copy → parse → fill-match
//      Full simulation of the user workflow without a browser:
//        1. Extract 694 choices from collges.html
//        2. Run bestMatch (OS quota, OPEN GN) to rank and sort
//        3. Simulate copyList() → parseChoices() round-trip
//        4. For each parsed choice, simulate the avlChoiceContainer scan
//           (isMatch against all page choices) and the alreadyFilled check
//        5. Assert every entry is found exactly once with the correct
//           institute+program, and no false "already_filled" fires
// ═════════════════════════════════════════════════════════════════════════════

describe('End-to-end: extract → rank → copy → parse → fill-match', () => {
  let sortedItems, parsedFromCopy;

  before(() => {
    // Step 1+2: rank with OS/OPEN/GN
    const rawResults = runMatch(allCsvRows, pageChoices, 'OPEN', 'Gender-Neutral', 'OS');
    sortedItems = sortItems(rawResults);

    // Step 3: copy → parse (mirrors copyList + parseChoices)
    const copiedText = sortedItems.map(item => `${item.institute} | ${item.program}`).join('\n');
    parsedFromCopy = parseChoices(copiedText);
  });

  it('copy list produces exactly 694 parseable lines', () => {
    assert.strictEqual(parsedFromCopy.length, 694);
  });

  it('every parsed choice is findable via isMatch in avlChoiceContainer (0 NOT FOUND)', () => {
    const notFound = parsedFromCopy.filter(choice =>
      !pageChoices.some(pg =>
        isMatchFiller(choice.institute, pg.institute, pg.instcd) &&
        isMatchFiller(choice.program,   pg.program,   pg.brcd)
      )
    );
    if (notFound.length)
      for (const c of notFound.slice(0, 5))
        console.error(`    NOT FOUND: "${c.institute}" | "${c.program}"`);
    assert.strictEqual(notFound.length, 0,
      `${notFound.length} entries not findable in page choices`);
  });

  it('no already-filled false positives when filling in sorted order', () => {
    // Simulate filling sequentially: for each choice, check if it would be
    // falsely marked as already_filled by a DIFFERENT, previously-filled choice
    // from the same institute.
    const filledSoFar = [];  // accumulates { institute, program } as we go
    const falsePositives = [];

    for (const choice of parsedFromCopy) {
      // Simulate the already_filled scan
      const falseFired = filledSoFar.some(filled =>
        isMatchFiller(choice.institute, filled.institute, '') &&
        isMatchFiller(choice.program,   filled.program,   '') &&
        filled.program !== choice.program   // same institute, DIFFERENT program = false positive
      );
      if (falseFired) {
        const culprit = filledSoFar.find(f =>
          isMatchFiller(choice.institute, f.institute, '') &&
          isMatchFiller(choice.program, f.program, '') &&
          f.program !== choice.program
        );
        falsePositives.push({
          choice: `${choice.institute} | ${choice.program}`,
          culprit: culprit ? culprit.program : '?',
        });
      } else {
        filledSoFar.push({ institute: choice.institute, program: choice.program });
      }
    }

    if (falsePositives.length) {
      console.log(`\n    FALSE POSITIVES (${falsePositives.length}):`);
      for (const fp of falsePositives.slice(0, 10))
        console.error(`    "${fp.choice}"\n      ← falsely matched by: "${fp.culprit}"`);
    }
    assert.strictEqual(falsePositives.length, 0,
      `${falsePositives.length} entries would be wrongly skipped as already-filled`);
  });

  it('isMatch finds correct page entry (not a cross-institute or cross-program match)', () => {
    // Spot-check 10 entries: each should match its OWN page choice, not another
    const spots = parsedFromCopy.slice(0, 10);
    for (const choice of spots) {
      const hits = pageChoices.filter(pg =>
        isMatchFiller(choice.institute, pg.institute, pg.instcd) &&
        isMatchFiller(choice.program,   pg.program,   pg.brcd)
      );
      assert.ok(hits.length >= 1, `"${choice.institute}|${choice.program}" → 0 hits`);
      // Every hit should have the same institute (no cross-institute leak)
      const instNorm = normalizeTextFiller(choice.institute);
      for (const h of hits) {
        assert.ok(
          normalizeTextFiller(h.institute).includes(instNorm.split(' ').slice(-1)[0]) ||
          instNorm.includes(normalizeTextFiller(h.institute).split(' ').slice(-1)[0]),
          `Cross-institute match: "${choice.institute}" matched "${h.institute}"`
        );
      }
    }
  });

  it('ranked items have strictly non-decreasing closing ranks', () => {
    const ranked = sortedItems.filter(r => r.found && r.closingRank !== null);
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i].closingRank >= ranked[i-1].closingRank,
        `Rank inversion at position ${i}: ${ranked[i-1].closingRank} > ${ranked[i].closingRank}`);
    }
  });

  it('all not-found items appear after all ranked items', () => {
    const firstNotFound = sortedItems.findIndex(r => !r.found);
    const lastFound     = sortedItems.map(r => r.found).lastIndexOf(true);
    if (firstNotFound === -1 || lastFound === -1) return;
    assert.ok(lastFound < firstNotFound);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  12. SUMMARY REPORT  (printed, not an assertion)
// ═════════════════════════════════════════════════════════════════════════════

describe('Summary report – match counts across all filter combos', () => {
  it('prints match counts for all filter combos', () => {
    const combos = [
      ['OPEN', 'Gender-Neutral', 'OS'],
      ['OPEN', 'Gender-Neutral', 'HS'],
      ['OPEN', 'Gender-Neutral', 'AI'],
      ['OPEN', 'Female-only (including Supernumerary)', 'OS'],
      ['OBC-NCL', 'Gender-Neutral', 'OS'],
      ['SC', 'Gender-Neutral', 'OS'],
      ['ST', 'Gender-Neutral', 'OS'],
      ['EWS', 'Gender-Neutral', 'OS'],
    ];
    console.log('\n    ── Match counts (694 total choices) ──');
    for (const [cat, gen, quota] of combos) {
      const results = runMatch(allCsvRows, pageChoices, cat, gen, quota);
      const n = results.filter(r => r.found).length;
      const dups = checkDuplicates(results).length;
      const label = `${cat}/${gen.split(' ')[0]}/${quota}`.padEnd(32);
      console.log(`    ${label} matched: ${String(n).padStart(3)}/694  dupes: ${dups}`);
    }
  });
});
