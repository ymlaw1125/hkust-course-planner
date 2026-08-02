#!/usr/bin/env node
/**
 * Instructor ratings from ust-rankings.com -> data/ratings.js
 *
 *   node scripts/scrape-ratings.mjs
 *
 * Their site ships the whole dataset inside a Next.js chunk rather than an
 * API, so we locate the chunk, pull the instructor records out of it, and
 * reduce each one to a single letter grade.
 *
 * The score formula, the eligibility rule and the percentile->letter
 * thresholds are all reproduced from their published source
 * (github.com/ust-archive/ust-rankings, app/page.tsx + app/instructor-card.tsx)
 * so the letters here match the letters on their site rather than being a
 * grading scheme of our own invention.
 *
 * Ratings come from past terms — a term that hasn't been taught yet has no
 * survey data — so we use the most recent term present in their data.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://ust-rankings.com';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; hkust-timetable-planner)' };

const CRITERIA = ['content', 'teaching', 'grading', 'workload', 'course', 'instructor'];

// app/page.tsx — the default formula, weights inlined.
const WEIGHTS = {
  content: (2 / 3) * 0.4,
  teaching: (2 / 3) * 0.4,
  grading: (2 / 3) * 0.15,
  workload: (2 / 3) * 0.05,
  course: (1 / 3) * 0.25,
  instructor: (1 / 3) * 0.75,
};

// app/instructor-card.tsx — letterGrade(percentile)
const GRADES = [
  [0.9, 'A+'], [0.8, 'A'], [0.75, 'A-'], [0.6, 'B+'], [0.45, 'B'], [0.35, 'B-'],
  [0.3, 'C+'], [0.25, 'C'], [0.2, 'C-'], [0.1, 'D'], [0.0, 'F'],
];

const letterGrade = (p) => (GRADES.find(([t]) => p >= t) || [0, 'F'])[1];

/** data/ratings.ts — formatTerm(n) */
function formatTerm(n) {
  const season = ['Fall', 'Winter', 'Spring', 'Summer'][n % 4];
  const year = 2000 + Math.floor(n / 4);
  return `${year}-${String(year + 1).slice(2)} ${season}`;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** The dataset lives in whichever chunk is by far the largest. */
async function findDataChunk() {
  const html = await fetchText(ORIGIN + '/');
  const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  let best = null;
  for (const src of srcs) {
    const js = await fetchText(ORIGIN + src).catch(() => '');
    if (!best || js.length > best.js.length) best = { src, js };
  }
  if (!best || !best.js.includes('"meta":{"name":')) {
    throw new Error('Could not find the ratings chunk — their bundle layout may have changed.');
  }
  return best;
}

/**
 * Walk braces to slice out one JSON object, skipping over string literals so
 * that braces inside course descriptions don't throw the depth count off.
 */
function extractObject(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

async function main() {
  console.log('Locating the ratings chunk…');
  const { src, js } = await findDataChunk();
  console.log(`  ${src} (${(js.length / 1024 / 1024).toFixed(1)}MB)`);

  const marker = '{"meta":{"name":"';
  const records = [];
  for (let i = js.indexOf(marker); i !== -1; i = js.indexOf(marker, i + 1)) {
    const raw = extractObject(js, i);
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw);
      if (rec && rec.meta && rec.meta.name && rec.ratings) records.push(rec);
    } catch (_) { /* not an instructor record */ }
  }
  console.log(`  ${records.length} instructor records`);
  if (!records.length) throw new Error('No records parsed.');

  // Most recent term with data, across every criterion.
  let term = -1;
  for (const r of records) {
    for (const c of CRITERIA) {
      const b = r.ratings[c] && r.ratings[c].bayesian;
      for (const t in b || {}) if (b[t] != null) term = Math.max(term, +t);
    }
  }
  const T = String(term);
  console.log(`  latest term with data: ${T} (${formatTerm(term)})`);

  // data/instructor.ts — only instructors with confidence in this term rank.
  const eligible = records.filter((r) =>
    CRITERIA.some((c) => r.ratings[c] && r.ratings[c].confidence && r.ratings[c].confidence[T])
  );
  console.log(`  ${eligible.length} rated this term`);

  for (const r of eligible) {
    r.score = CRITERIA.reduce((sum, c) => {
      const b = (r.ratings[c] && r.ratings[c].bayesian && r.ratings[c].bayesian[T]) || 0;
      return sum + b * WEIGHTS[c];
    }, 0);
  }
  eligible.sort((a, b) => b.score - a.score);

  const instructors = {};
  eligible.forEach((r, i) => {
    const percentile = 1 - i / eligible.length;
    instructors[r.meta.name] = {
      g: letterGrade(percentile),
      // Keep enough precision that re-deriving a letter from p can't round a
      // value sitting exactly on a band edge (0.9, 0.75, 0.1 …) into the next
      // grade up, and so co-taught averages and sorting stay distinguishable.
      p: Math.round(percentile * 1e6) / 1e6,
      r: i + 1,
    };
  });

  // Every known name, rated or not — needed to split the run-together
  // instructor strings in the catalog ("CHEUNG, Kwok YipGUO, Di").
  const roster = [...new Set(records.map((r) => r.meta.name))].sort();

  const payload = {
    source: 'ust-rankings.com',
    sourceUrl: ORIGIN,
    term: T,
    termLabel: formatTerm(term),
    scraped: new Date().toISOString().slice(0, 10),
    count: eligible.length,
    instructors,
    roster,
  };

  await writeFile(path.join(OUT, 'ratings.js'), `window.CATALOG_RATINGS=${JSON.stringify(payload)};\n`, 'utf8');

  const dist = {};
  for (const v of Object.values(instructors)) dist[v.g] = (dist[v.g] || 0) + 1;
  console.log('\ngrade distribution:');
  for (const [, g] of GRADES) if (dist[g]) console.log(`  ${g.padEnd(3)} ${dist[g]}`);
  console.log(`\nWrote ${path.join(OUT, 'ratings.js')} — roster ${roster.length}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
