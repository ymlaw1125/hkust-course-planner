#!/usr/bin/env node
/**
 * Scrapes the HKUST Class Schedule & Quota site into local JS data files.
 *
 *   node scripts/scrape.mjs            # default term 2610 (2026-27 Fall)
 *   node scripts/scrape.mjs 2530       # another term
 *
 * Output (loadable over file:// via <script> tags, no server needed):
 *   data/index.js          -> window.CATALOG_INDEX  { term, generated, subjects[], courses[] }
 *   data/subjects/XXXX.js  -> window.CATALOG_SUBJECT_XXXX = [ ...courses ]
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const TERM = process.argv[2] || '2610';
const BASE = `https://w5.ab.ust.hk/wcq/cgi-bin/${TERM}`;
const OUT = path.resolve('data');
const CONCURRENCY = 6;

// ---------------------------------------------------------------- utilities

const DAY_CODES = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** "01:30PM" -> 810 (minutes since midnight) */
function parseClock(s) {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(s.trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const pm = m[3].toUpperCase() === 'P';
  if (h === 12) h = 0;
  return (h + (pm ? 12 : 0)) * 60 + min;
}

/**
 * "TuTh 01:30PM - 02:50PM" -> [{day:1,start:810,end:890}, {day:3,...}]
 * Returns [] for TBA / unparseable.
 */
function parseMeetingTime(text) {
  const out = [];
  const re =
    /((?:Mo|Tu|We|Th|Fr|Sa|Su)+)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/gi;
  let m;
  while ((m = re.exec(text))) {
    const start = parseClock(m[2]);
    const end = parseClock(m[3]);
    if (start == null || end == null) continue;
    const days = m[1].match(/Mo|Tu|We|Th|Fr|Sa|Su/g) || [];
    for (const d of days) {
      const day = DAY_CODES.indexOf(d);
      if (day >= 0) out.push({ day, start, end });
    }
  }
  return out;
}

/** Split one <tr> block into its top-level <td> inner-HTML strings. */
function splitCells(rowHtml) {
  const cells = [];
  const re = /<td\b[^>]*>/gi;
  let m;
  const starts = [];
  while ((m = re.exec(rowHtml))) starts.push({ open: m.index, contentAt: m.index + m[0].length });
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].open : rowHtml.length;
    cells.push(rowHtml.slice(starts[i].contentAt, end).replace(/<\/td>\s*$/i, ''));
  }
  return cells;
}

/** Pull the <tr class="..."> blocks out of a chunk of HTML. */
function extractRows(html) {
  const rows = [];
  const re = /<tr\s+class="([^"]*)"[^>]*>/gi;
  const hits = [];
  let m;
  while ((m = re.exec(html))) hits.push({ cls: m[1], open: m.index, contentAt: m.index + m[0].length });
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].open : html.length;
    rows.push({ cls: hits[i].cls, html: html.slice(hits[i].contentAt, end) });
  }
  return rows;
}

/** "L01" -> {kind:'LEC', group:'1'} ; "T1A" -> {kind:'TUT', group:'1'} */
function classifySection(code) {
  const m = /^([A-Za-z]+)\s*(\d*)/.exec(code.trim());
  const prefix = (m ? m[1] : code).toUpperCase();
  const group = m && m[2] ? String(parseInt(m[2], 10)) : '';
  const KINDS = {
    L: 'LEC', LE: 'LEC', C: 'LEC',
    T: 'TUT', TU: 'TUT',
    LA: 'LAB', LB: 'LAB',
    R: 'REC',
    S: 'STU', ST: 'STU',
    P: 'PRA', F: 'FLD', X: 'EXP',
  };
  return { kind: KINDS[prefix] || prefix, group };
}

function firstInt(text) {
  const m = /-?\d+/.exec(text);
  return m ? parseInt(m[0], 10) : null;
}

// ---------------------------------------------------------------- parsing

function parseSubjectPage(html, subject) {
  const courses = [];
  const chunks = html.split(/<div class="course">/).slice(1);

  for (const chunk of chunks) {
    const titleM = /<div class=['"]subject['"]>([\s\S]*?)<\/div>/.exec(chunk);
    if (!titleM) continue;
    const heading = stripTags(titleM[1]);

    // "COMP 1021 - Introduction to Computer Science (3 units)"
    const hm = /^([A-Z]{2,5})\s*(\d{4}[A-Z]*)\s*-\s*([\s\S]*?)\s*\(([^)]*)\)\s*$/.exec(heading);
    const code = hm ? `${hm[1]} ${hm[2]}` : heading.split(' - ')[0].trim();
    const title = hm ? hm[3] : (heading.split(' - ')[1] || '').trim();
    const creditsRaw = hm ? hm[4] : '';
    const credits = parseFloat(creditsRaw) || null;

    const sections = [];
    let current = null;

    for (const row of extractRows(chunk)) {
      const isMain = /\bmainRow\b/.test(row.cls);
      const isOther = /\botherRow\b/.test(row.cls);
      if (!isMain && !isOther) continue;

      const cells = splitCells(row.html).map((c) => c);
      if (!cells.length) continue;

      const secText = stripTags(cells[0] || '');
      const timeText = stripTags(cells[1] || '');
      const roomText = stripTags(cells[2] || '');

      if (isMain && /\bnewsect\b/.test(row.cls) && secText) {
        // "L01 (1038)" -> code L01, crn 1038
        const sm = /^([A-Za-z0-9]+)\s*(?:\((\d+)\))?/.exec(secText);
        const secCode = sm ? sm[1] : secText;
        const { kind, group } = classifySection(secCode);

        const quotaCell = cells[5] || '';
        const spanM = /<span>(\d+)<\/span>/.exec(quotaCell);

        current = {
          section: secCode,
          crn: sm && sm[2] ? sm[2] : null,
          kind,
          group,
          meetings: [],
          rooms: [],
          instructors: stripTags(cells[3] || ''),
          ta: stripTags(cells[4] || ''),
          quota: spanM ? parseInt(spanM[1], 10) : firstInt(stripTags(quotaCell)),
          enrol: firstInt(stripTags(cells[6] || '')),
          avail: firstInt(stripTags(cells[7] || '')),
          wait: firstInt(stripTags(cells[8] || '')),
          remarks: stripTags(cells[9] || ''),
        };
        sections.push(current);
      }

      if (!current) continue;

      const meets = parseMeetingTime(timeText);
      if (meets.length) {
        current.meetings.push(...meets);
        if (roomText && !current.rooms.includes(roomText)) current.rooms.push(roomText);
      } else if (isMain && /TBA/i.test(timeText)) {
        current.tba = true;
      }
    }

    if (sections.length) {
      courses.push({ subject, code, title, credits, sections });
    }
  }
  return courses;
}

// ---------------------------------------------------------------- fetching

async function fetchText(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (course-planner scraper)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------- common core

/**
 * Common Core group pages use exactly the same markup as subject pages, so we
 * only need the course codes — every one of them is already in the subject
 * data, section times included.
 */
async function scrapeCommonCore(home) {
  const seen = new Map();
  const re = new RegExp(
    `href="/wcq/cgi-bin/${TERM}/common_core/([A-Z0-9]+)(?:/(\\d+))?"[^>]*>([^<]*)<`,
    'g'
  );
  for (const m of home.matchAll(re)) {
    const [, cohort, num, label] = m;
    const key = num ? `${cohort}/${num}` : cohort;
    if (!seen.has(key)) seen.set(key, { cohort, num: num || null, label: label.trim() });
  }

  const cohorts = [];
  const groups = [];
  for (const [key, info] of seen) {
    if (!info.num) {
      cohorts.push({ id: info.cohort, label: info.label });
    } else {
      const area = /Common Core \(([^)]+)\)/.exec(info.label);
      groups.push({
        id: key,
        cohort: info.cohort,
        area: area ? area[1] : info.label,
        label: info.label,
        courses: [],
      });
    }
  }

  console.log(`${cohorts.length} cohorts, ${groups.length} common core groups`);

  let done = 0;
  await mapLimit(groups, CONCURRENCY, async (g) => {
    try {
      const html = await fetchText(`${BASE}/common_core/${g.id}`);
      const codes = [
        ...html.matchAll(/<div class=['"]subject['"]>([A-Z]{2,5})\s*(\d{4}[A-Z]*)\s*-/g),
      ].map((m) => `${m[1]} ${m[2]}`);
      g.courses = [...new Set(codes)].sort();
    } catch (err) {
      console.warn(`  ! common core ${g.id}: ${err.message}`);
    }
    done++;
    process.stdout.write(`\r  ${done}/${groups.length} groups…   `);
  });

  const withCourses = groups.filter((g) => g.courses.length).length;
  console.log(`\n  ${withCourses}/${groups.length} groups have offerings this term`);
  return { cohorts, groups };
}

// ---------------------------------------------------------------- main

async function main() {
  console.log(`Term ${TERM} — ${BASE}`);
  const home = await fetchText(`${BASE}/`);
  const subjects = [
    ...new Set(
      [...home.matchAll(new RegExp(`/wcq/cgi-bin/${TERM}/subject/([A-Z]+)`, 'g'))].map((m) => m[1])
    ),
  ].sort();
  console.log(`${subjects.length} subjects found`);

  if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'subjects'), { recursive: true });

  const index = [];
  let totalCourses = 0;
  let totalSections = 0;
  let done = 0;

  await mapLimit(subjects, CONCURRENCY, async (subject) => {
    let courses = [];
    try {
      const html = await fetchText(`${BASE}/subject/${subject}`);
      courses = parseSubjectPage(html, subject);
    } catch (err) {
      console.warn(`  ! ${subject}: ${err.message}`);
      return;
    }

    totalCourses += courses.length;
    for (const c of courses) {
      totalSections += c.sections.length;
      index.push({ s: subject, c: c.code, t: c.title, u: c.credits, n: c.sections.length });
    }

    await writeFile(
      path.join(OUT, 'subjects', `${subject}.js`),
      `window.CATALOG_SUBJECT_${subject}=${JSON.stringify(courses)};\n`,
      'utf8'
    );

    done++;
    process.stdout.write(`\r  ${done}/${subjects.length} subjects…   `);
  });

  index.sort((a, b) => a.c.localeCompare(b.c));

  const commonCore = await scrapeCommonCore(home);
  await writeFile(
    path.join(OUT, 'common-core.js'),
    `window.CATALOG_COMMON_CORE=${JSON.stringify(commonCore)};\n`,
    'utf8'
  );

  const meta = {
    term: TERM,
    termName: termName(TERM),
    generated: new Date().toISOString(),
    subjects,
    courses: index,
  };
  await writeFile(path.join(OUT, 'index.js'), `window.CATALOG_INDEX=${JSON.stringify(meta)};\n`, 'utf8');

  console.log(
    `\nDone. ${totalCourses} courses, ${totalSections} sections across ${subjects.length} subjects.`
  );
  console.log(`Wrote ${path.join(OUT, 'index.js')} + data/subjects/*.js`);
}

function termName(t) {
  const yr = 2000 + parseInt(t.slice(0, 2), 10);
  const sem = { 0: 'Fall', 1: 'Winter', 2: 'Winter', 3: 'Spring', 4: 'Summer' };
  const d = t[2];
  const label = { '1': 'Fall', '2': 'Winter', '3': 'Spring', '4': 'Summer' }[d] || sem[d] || '';
  return `${yr}-${String(yr + 1).slice(2)} ${label}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
